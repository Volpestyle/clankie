import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import { HerdrBindingSchema, type HerdrBinding } from "@clankie/protocol";

const exec = promisify(execFile);
const processStart = async (pid: number): Promise<string | undefined> => {
  try {
    const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 5_000,
      encoding: "utf8",
    });
    const start = stdout.trim();
    return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/u.test(start)
      ? start
      : undefined;
  } catch {
    return undefined;
  }
};

export type LocalCodexRegistration = (() => void) & { bindSession?(threadId: string): void | Promise<void> };

const StateSchema = z
  .object({
    version: z.literal(1),
    seats: z.array(
      z
        .object({
          pid: z.number().int().min(2),
          pane: z.string().regex(/^w[\w]+:p[\w]+$/u),
          binding: HerdrBindingSchema,
          start: z.string().min(1),
          nativeOccupantId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
interface Entry {
  pane: string;
  binding: HerdrBinding;
  start: Promise<string | undefined>;
  capturedStart?: string;
  nativeOccupantId?: string;
  restored?: true;
}
interface DurableSeats {
  /** Controller-owned launch records; incoming requests never create them. */
  path: string;
  /** Fresh native foreground observation, required before admitting a restored server. */
  observeOccupant(pane: string): Promise<string | undefined>;
}

/** Private app-servers belong to a view allocated by the service, including pending startup. */
export class LocalCodexSeats {
  private readonly seats = new Map<number, Entry>();
  private readonly binding: () => HerdrBinding | undefined;
  private readonly observeStart: (pid: number) => Promise<string | undefined>;
  private readonly durable: DurableSeats | undefined;
  constructor(binding: () => HerdrBinding | undefined, observeStart = processStart, durable?: DurableSeats) {
    this.binding = binding;
    this.observeStart = observeStart;
    this.durable = durable;
    if (durable) {
      let stored: z.infer<typeof StateSchema>;
      try {
        stored = StateSchema.parse(JSON.parse(readFileSync(durable.path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("Private Codex launch records are unreadable", { cause: error });
      }
      for (const { pid, start, ...seat } of stored.seats)
        this.seats.set(pid, { ...seat, start: Promise.resolve(start), capturedStart: start, restored: true });
    }
  }

  private save(): void {
    if (!this.durable) return;
    const seats = [...this.seats].flatMap(([pid, seat]) =>
      seat.capturedStart && seat.nativeOccupantId
        ? [
            {
              pid,
              pane: seat.pane,
              binding: seat.binding,
              start: seat.capturedStart,
              nativeOccupantId: seat.nativeOccupantId,
            },
          ]
        : [],
    );
    const path = this.durable.path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(StateSchema.parse({ version: 1, seats }))}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  register(pid: number, pane: string): LocalCodexRegistration {
    const binding = this.binding();
    if (!binding || !Number.isSafeInteger(pid) || pid <= 1 || pane.includes("/")) return () => {};
    // Capture the spawned process lifetime now; never initialize it from an incoming request.
    const entry: Entry = { pane, binding, start: this.observeStart(pid).catch(() => undefined) };
    this.seats.set(pid, entry);
    this.save();
    const release = () => {
      if (this.seats.get(pid) !== entry) return;
      this.seats.delete(pid);
      this.save();
    };
    return Object.assign(release, {
      bindSession: async (threadId: string) => {
        if (this.seats.get(pid) !== entry || !threadId) return;
        const identity = occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: threadId });
        if (entry.nativeOccupantId !== undefined && entry.nativeOccupantId !== identity) return release();
        entry.nativeOccupantId = identity;
        if (!this.durable) return;
        const start = await entry.start;
        if (this.seats.get(pid) !== entry) return;
        if (!start) throw new Error("Private Codex process lifetime is unavailable");
        entry.capturedStart = start;
        this.save();
      },
    });
  }

  async allows(
    ancestors: readonly number[],
    pane: string,
    binding: HerdrBinding,
    nativeOccupantId?: string,
  ): Promise<boolean> {
    for (const pid of ancestors) {
      const seat = this.seats.get(pid);
      if (
        !seat ||
        seat.pane !== pane ||
        seat.binding.socketPath !== binding.socketPath ||
        seat.binding.session !== binding.session
      )
        continue;
      if (nativeOccupantId !== undefined && seat.nativeOccupantId !== nativeOccupantId) continue;
      const start = await seat.start;
      if (!start || (await this.observeStart(pid).catch(() => undefined)) !== start) continue;
      if (
        seat.restored &&
        (!seat.nativeOccupantId ||
          (await this.durable?.observeOccupant(pane).catch(() => undefined)) !== seat.nativeOccupantId)
      )
        continue;
      const current = this.binding();
      if (
        this.seats.get(pid) === seat &&
        (nativeOccupantId === undefined || seat.nativeOccupantId === nativeOccupantId) &&
        current?.socketPath === binding.socketPath &&
        current?.session === binding.session
      )
        return true;
    }
    return false;
  }
}
