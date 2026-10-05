import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { occupantIdForHerdrSession, parseHerdrAgentList } from "./captain/herdr-census.ts";
import { type HerdrBinding } from "@clankie/protocol";
import { LocalCodexStateSchema as StateSchema, isLocalCodexEndpoint } from "./local-codex-records.ts";
import type { z } from "zod";
import { pinHerdrEnvironment } from "./herdr-session.ts";
import { observeNativeBirth, nativeProcessReceipt } from "./local-fleet-process.ts";

const exec = promisify(execFile);
const processStart = async (pid: number, previous?: string): Promise<string | undefined> => {
  if (process.platform !== "darwin") {
    // Preserve existing private-launch support elsewhere. This never supplies
    // macOS socket admission or substitutes after a failed native observation.
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
  }
  const birth = await observeNativeBirth(pid);
  return birth ? nativeProcessReceipt(birth, previous) : undefined;
};

export type LocalCodexRegistration = (() => void) & {
  bindSession?(threadId: string, endpoint?: string): void | Promise<void>;
};
interface Entry {
  pane: string;
  binding: HerdrBinding;
  start: Promise<string | undefined>;
  capturedStart?: string;
  nativeOccupantId?: string;
  threadId?: string | undefined;
  endpoint?: string | undefined;
  parent?: { paneId: string; occupantId: string } | undefined;
  restored?: true;
}
interface DurableSeats {
  /** Controller-owned launch records; incoming requests never create them. */
  path: string;
  /** Fresh native foreground observation, required before admitting a restored server. */
  observeOccupant(pane: string): Promise<string | undefined>;
  warn?(message: string): void;
}

/** Private app-servers belong to a view allocated by the service, including pending startup. */
export class LocalCodexSeats {
  private readonly seats = new Map<number, Entry>();
  private readonly binding: () => HerdrBinding | undefined;
  private readonly observeStart: (pid: number, previous?: string) => Promise<string | undefined>;
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
        // An unreadable record must not stop the service from starting: restore
        // nothing and keep the file aside for inspection.
        const aside = `${durable.path}.unreadable-${Date.now()}`;
        try {
          renameSync(durable.path, aside);
        } catch {
          // Leave it in place; the next save replaces it atomically.
        }
        durable.warn?.(`Private Codex launch records were unreadable; moved to ${aside} and restored none`);
        return;
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
              ...(seat.threadId === undefined ? {} : { threadId: seat.threadId }),
              ...(seat.endpoint === undefined ? {} : { endpoint: seat.endpoint }),
              ...(seat.parent === undefined ? {} : { parent: seat.parent }),
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
      bindSession: async (threadId: string, endpoint?: string) => {
        if (this.seats.get(pid) !== entry || !threadId) return;
        const identity = occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: threadId });
        if (entry.nativeOccupantId !== undefined && entry.nativeOccupantId !== identity) return release();
        entry.nativeOccupantId = identity;
        entry.threadId = threadId;
        if (endpoint !== undefined) {
          if (!isLocalCodexEndpoint(endpoint)) throw new Error("Private Codex endpoint is invalid");
          if (entry.endpoint !== undefined && entry.endpoint !== endpoint) return release();
          entry.endpoint = endpoint;
        }
        if (!this.durable) return;
        const start = await entry.start;
        if (this.seats.get(pid) !== entry) return;
        if (!start) throw new Error("Private Codex process lifetime is unavailable");
        entry.capturedStart = start;
        if (endpoint !== undefined && entry.parent === undefined) {
          const parent = await this.captureParent(entry);
          if (this.seats.get(pid) !== entry) return;
          if (parent !== undefined) entry.parent = parent;
        }
        this.save();
      },
    });
  }

  /** Preserve a real launcher edge before a Herdr reset can discard it. */
  private async captureParent(entry: Entry): Promise<Entry["parent"]> {
    try {
      const read = async (pane: string) => {
        const { stdout } = await exec("herdr", ["agent", "get", pane], {
          env: pinHerdrEnvironment({ ...process.env }, entry.binding.socketPath),
          timeout: 2_000,
          maxBuffer: 1_048_576,
          encoding: "utf8",
        });
        const raw = JSON.parse(stdout)?.result?.agent;
        return parseHerdrAgentList(JSON.stringify({ result: { agents: [raw] } }))[0];
      };
      const child = await read(entry.pane);
      const parentPaneId = child?.parentPaneId;
      if (
        child?.paneId !== entry.pane ||
        !parentPaneId ||
        parentPaneId === entry.pane ||
        !/^w[\w]+:p[\w]+$/u.test(parentPaneId) ||
        (child.session && occupantIdForHerdrSession(child.session) !== entry.nativeOccupantId)
      )
        return undefined;
      const parent = await read(parentPaneId);
      if (parent?.paneId !== parentPaneId || parent.session === undefined) return undefined;
      const occupantId = occupantIdForHerdrSession(parent.session);
      const [latestChild, latestParent] = await Promise.all([read(entry.pane), read(parentPaneId)]);
      if (
        latestChild?.parentPaneId !== parentPaneId ||
        latestParent?.session === undefined ||
        occupantIdForHerdrSession(latestParent.session) !== occupantId ||
        (latestChild.session && occupantIdForHerdrSession(latestChild.session) !== entry.nativeOccupantId)
      )
        return undefined;
      const current = this.binding();
      return current?.socketPath === entry.binding.socketPath && current.session === entry.binding.session
        ? { paneId: parentPaneId, occupantId }
        : undefined;
    } catch {
      return undefined;
    }
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
      if (!start || (await this.observeStart(pid, start).catch(() => undefined)) !== start) continue;
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
