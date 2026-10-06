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
export interface RemoteCodexCatalogResult {
  readonly paneId: string;
  readonly threadId?: string;
  readonly revision: string;
  readonly outcome: "failed";
  readonly reason: string;
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

  /**
   * Registered remote controllers currently have no isolated native config
   * provenance or durable refresh journal. Report that boundary without using
   * an account-wide config, replaying a receipt, or recreating lost authority.
   * A missing registration returns no row: the roster adds its own explicit
   * recovery failure for observed seats that this registry does not own.
   */
  async refreshCatalogs(input: {
    readonly paneId?: string;
    readonly revision: string;
    readonly signal?: AbortSignal;
  }): Promise<RemoteCodexCatalogResult[]> {
    const candidates = [...this.entries.entries()]
      .filter(([key]) => input.paneId === undefined || key === input.paneId)
      .sort(([left], [right]) => left.localeCompare(right));
    const results: RemoteCodexCatalogResult[] = [];
    for (const [paneId, entry] of candidates) {
      const result: RemoteCodexCatalogResult = {
        paneId,
        ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
        revision: input.revision,
        outcome: "failed",
        reason: "remote_codex_catalog_refresh_isolated_config_unavailable",
      };
      let reason: string | undefined;
      if (input.signal?.aborted) reason = "remote_codex_catalog_refresh_cancelled";
      else if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(input.revision))
        reason = "remote_codex_catalog_revision_invalid";
      else if (!entry.threadId || !entry.soleThread) reason = "original_remote_codex_thread_unbound";
      else {
        try {
          if (!entry.linkAlive()) reason = "original_remote_codex_link_unavailable";
          else {
            const fleet = await this.fleet(entry.launch.fleet.id);
            if (input.signal?.aborted) reason = "remote_codex_catalog_refresh_cancelled";
            else if (this.entries.get(paneId) !== entry)
              reason = "original_remote_codex_registration_changed";
            else if (!entry.linkAlive()) reason = "original_remote_codex_link_unavailable";
            else if (!isDeepStrictEqual(fleet, entry.launch.fleet))
              reason = "original_remote_codex_fleet_changed";
          }
        } catch {
          reason = "original_remote_codex_registration_unavailable";
        }
      }
      results.push(reason === undefined ? result : { ...result, reason });
    }
    return results;
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
    const checking = (entry.checking ??= entry.soleThread());
    let sole: boolean;
    try {
      sole = await checking;
    } catch {
      // An unavailable observation grants nothing, but is not evidence that
      // this original controller loaded a different thread. Keep its launch
      // registration; the next request must repeat every fresh proof.
      return false;
    } finally {
      if (entry.checking === checking) delete entry.checking;
    }
    if (!sole) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      return false;
    }
    return valid() && isDeepStrictEqual(await this.fleet(fleet.id), fleet) && valid();
  }
}
