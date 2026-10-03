import { isDeepStrictEqual } from "node:util";
import type { HerdrFleet } from "./herdr-fleet.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";

export interface RemoteCodexLaunch {
  readonly fleet: HerdrFleet;
  readonly pane: string;
  readonly binding: ProjectProcessProof["binding"];
  readonly shell: ProjectProcessProof["shell"];
  /** Captured from the handle returned by the service's native CreateProcess call. */
  readonly server: {
    readonly pid: number;
    readonly startTime: string;
    readonly executable: string;
    readonly port: number;
  };
}
export interface RemoteCodexRegistration {
  release(): void;
  bindThread(threadId: string, soleThread: () => Promise<boolean>): void;
  observeThread(threadId: string): void;
}
interface Entry {
  readonly launch: RemoteCodexLaunch;
  readonly linkAlive: () => boolean;
  threadId?: string;
  observedThreadId?: string;
  soleThread?: () => Promise<boolean>;
  checking?: Promise<boolean>;
}

/** In-memory, service-launch-only authority. Never reconstruct entries from requests or stored PIDs. */
export class RemoteCodexSeats {
  private readonly entries = new Map<string, Entry>();
  private readonly fleet: (id: string) => Promise<HerdrFleet | undefined>;
  constructor(fleet: (id: string) => Promise<HerdrFleet | undefined>) {
    this.fleet = fleet;
  }

  register(launch: RemoteCodexLaunch, linkAlive: () => boolean): RemoteCodexRegistration {
    const key = `${launch.fleet.id}/${launch.pane}`;
    const entry: Entry = { launch: structuredClone(launch), linkAlive };
    const release = () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
    // A new allocation cannot preserve a previous allocation's authority.
    this.entries.delete(key);
    if (
      launch.fleet.ssh.shell === "powershell" &&
      /^w[\w]+:p[\w]+$/u.test(launch.pane) &&
      launch.binding.session === launch.fleet.session &&
      launch.binding.socketPath &&
      Number.isSafeInteger(launch.server.pid) &&
      launch.server.pid > 4 &&
      launch.server.startTime &&
      launch.server.executable &&
      linkAlive()
    )
      this.entries.set(key, entry);
    return {
      release,
      bindThread: (threadId, soleThread) => {
        if (this.entries.get(key) !== entry || !threadId) return;
        if (
          (entry.threadId !== undefined && entry.threadId !== threadId) ||
          (entry.observedThreadId !== undefined && entry.observedThreadId !== threadId)
        )
          return release();
        entry.threadId = threadId;
        entry.soleThread ??= soleThread;
      },
      observeThread: (threadId) => {
        if (
          (entry.threadId !== undefined && threadId !== entry.threadId) ||
          (entry.observedThreadId !== undefined && threadId !== entry.observedThreadId)
        )
          release();
        else entry.observedThreadId = threadId;
      },
    };
  }

  /** The observer may ask only for a service-registered server, before reading its native state. */
  server(fleet: HerdrFleet, pane: string): RemoteCodexLaunch["server"] | undefined {
    const entry = this.entries.get(`${fleet.id}/${pane}`);
    return entry?.threadId && entry.linkAlive() && isDeepStrictEqual(entry.launch.fleet, fleet)
      ? { ...entry.launch.server }
      : undefined;
  }

  async allows(
    fleet: HerdrFleet,
    view: ProjectProcessProof,
    server: RemoteCodexLaunch["server"],
  ): Promise<boolean> {
    const key = `${fleet.id}/${view.pane}`;
    const entry = this.entries.get(key);
    const valid = () =>
      entry !== undefined &&
      this.entries.get(key) === entry &&
      entry.linkAlive() &&
      !view.nativeSessionPending &&
      view.fleet === fleet.id &&
      isDeepStrictEqual(entry.launch.fleet, fleet) &&
      isDeepStrictEqual(entry.launch.binding, view.binding) &&
      isDeepStrictEqual(entry.launch.shell, view.shell) &&
      isDeepStrictEqual(entry.launch.server, server) &&
      entry.threadId !== undefined &&
      view.nativeOccupantId ===
        occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: entry.threadId });
    if (!valid() || !entry?.soleThread) return false;
    // Only overlapping reads share work. Completed answers are never cached.
    const checking = (entry.checking ??= entry.soleThread().catch(() => false));
    const sole = await checking;
    if (entry.checking === checking) delete entry.checking;
    if (!sole) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      return false;
    }
    return valid() && isDeepStrictEqual(await this.fleet(fleet.id), fleet) && valid();
  }
}
