import { readFile } from "node:fs/promises";
import { z } from "zod";
import { durableJson } from "./deploy-holds.ts";

export interface FleetProgressObservation {
  /** Stable work identity, prefixed by the source (integration, heavy, or lead). */
  id: string;
  stalled: boolean;
  message: string;
}
export interface FleetProgressSource {
  prefix: string;
  read(): Promise<readonly FleetProgressObservation[]>;
}
const IncidentSchema = z.strictObject({
  id: z.string().max(512),
  message: z.string().max(4000),
  openedAt: z.string(),
  alert: z.enum(["claimed", "submitted", "unavailable"]),
  recoveredAt: z.string().optional(),
  recovery: z.enum(["claimed", "submitted", "unavailable"]).optional(),
});
const JournalSchema = z.array(IncidentSchema).max(256);
type Incident = z.infer<typeof IncidentSchema>;

/** Three fleet progress checks share one observer; notification can never block observation. */
export class FleetProgressObserver {
  private incidents: Incident[] | undefined;
  private round: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private readonly reads = new Map<string, Promise<readonly FleetProgressObservation[]>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly options: {
    path: string;
    sources: readonly FleetProgressSource[];
    notify: (text: string) => Promise<boolean>;
    onError: (error: unknown) => void;
  };
  constructor(options: FleetProgressObserver["options"]) {
    this.options = options;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.observe(), 30_000);
    this.timer.unref();
    void this.observe();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  observe(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.round ??= this.check()
      .catch(this.options.onError)
      .finally(() => {
        this.round = undefined;
      }));
  }
  private async save(): Promise<void> {
    const snapshot = structuredClone(this.incidents!);
    const next = this.writes.then(() => durableJson(this.options.path, JournalSchema.parse(snapshot)));
    this.writes = next.catch(() => {});
    await next;
  }
  private async check(): Promise<void> {
    if (!this.incidents) {
      const raw = await readFile(this.options.path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "[]";
        throw error;
      });
      this.incidents = JournalSchema.parse(JSON.parse(raw));
    }
    for (const source of this.options.sources) {
      let observations: readonly FleetProgressObservation[];
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          let reading = this.reads.get(source.prefix);
          if (!reading) {
            reading = Promise.resolve().then(() => source.read());
            this.reads.set(source.prefix, reading);
            void reading.finally(() => this.reads.delete(source.prefix)).catch(() => {});
          }
          observations = await Promise.race([
            reading,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(Error(`Fleet progress source ${source.prefix} unavailable`)),
                5_000,
              );
              timer.unref();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (observations.length > 256 || observations.some((o) => !o.id.startsWith(`${source.prefix}:`)))
          throw Error("Invalid fleet progress source");
      } catch (error) {
        this.options.onError(error);
        continue; // Unknown does not resolve an incident.
      }
      for (const observation of observations) {
        if (!observation.stalled || this.incidents.some((i) => i.id === observation.id)) continue;
        // Retain open incidents; prune oldest completed episodes only.
        if (this.incidents.length >= 256) {
          const old = this.incidents.findIndex((i) => i.recovery !== undefined);
          if (old < 0) throw Error("Fleet progress incident capacity reached");
          this.incidents.splice(old, 1);
        }
        const incident: Incident = {
          id: observation.id,
          message: observation.message,
          openedAt: new Date().toISOString(),
          alert: "claimed",
        };
        this.incidents.push(incident);
        await this.save(); // A crash/uncertain dispatch must not replay the opening alert.
        this.dispatch(incident, false);
      }
      for (const incident of this.incidents) {
        if (!incident.id.startsWith(`${source.prefix}:`) || incident.recovery !== undefined) continue;
        if (observations.some((o) => o.id === incident.id && o.stalled)) continue;
        incident.recoveredAt = new Date().toISOString();
        incident.recovery = "claimed";
        await this.save();
        this.dispatch(incident, true);
      }
    }
  }
  private dispatch(incident: Incident, recovery: boolean): void {
    const text = (
      recovery
        ? `Fleet progress recovered: ${incident.id} is no longer stalled. Original incident: ${incident.message}`
        : incident.message
    ).slice(0, 4000);
    // The existing route records an owner notice before native delivery. Its original
    // receipt may remain uncertain; claimed state never causes another dispatch.
    void Promise.resolve()
      .then(() => this.options.notify(text))
      .then(async (accepted) => {
        incident[recovery ? "recovery" : "alert"] = accepted ? "submitted" : "unavailable";
        await this.save();
      })
      .catch(this.options.onError);
  }
}
