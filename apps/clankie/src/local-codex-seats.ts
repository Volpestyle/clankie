import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import type { HerdrBinding } from "@clankie/protocol";

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

export type LocalCodexRegistration = (() => void) & { bindSession?(threadId: string): void };

/** Private app-servers belong to a view allocated by the service, including pending startup. */
export class LocalCodexSeats {
  private readonly seats = new Map<
    number,
    { pane: string; binding: HerdrBinding; start: Promise<string | undefined>; nativeOccupantId?: string }
  >();
  private readonly binding: () => HerdrBinding | undefined;
  private readonly observeStart: (pid: number) => Promise<string | undefined>;
  constructor(binding: () => HerdrBinding | undefined, observeStart = processStart) {
    this.binding = binding;
    this.observeStart = observeStart;
  }

  register(pid: number, pane: string): LocalCodexRegistration {
    const binding = this.binding();
    if (!binding || !Number.isSafeInteger(pid) || pid <= 1 || pane.includes("/")) return () => {};
    // Capture the spawned process lifetime now; never initialize it from an incoming request.
    const entry: {
      pane: string;
      binding: HerdrBinding;
      start: Promise<string | undefined>;
      nativeOccupantId?: string;
    } = { pane, binding, start: this.observeStart(pid).catch(() => undefined) };
    this.seats.set(pid, entry);
    return Object.assign(
      () => {
        if (this.seats.get(pid) === entry) this.seats.delete(pid);
      },
      {
        bindSession: (threadId: string) => {
          if (this.seats.get(pid) !== entry || !threadId) return;
          const identity = occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: threadId });
          if (entry.nativeOccupantId !== undefined && entry.nativeOccupantId !== identity)
            this.seats.delete(pid);
          else entry.nativeOccupantId = identity;
        },
      },
    );
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
