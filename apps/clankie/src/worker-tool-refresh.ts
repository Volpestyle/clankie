import { randomUUID } from "node:crypto";
import type { FleetWorkerCatalogRefreshResult } from "@clankie/protocol/tool-catalog";
import type { CaptainPort } from "./captain/port.ts";
import type { createLocalCodexCatalogCoordinator } from "./captain/local-codex-catalog-coordinator.ts";
import type { RemoteCodexSeats } from "./remote-codex-seats.ts";
import type { WorkerMcp } from "./worker-mcp.ts";
import { splitFleetQualified } from "./herdr-fleet.ts";

export interface WorkerCatalogRefreshAuthority {
  guard(): Promise<void>;
  current(): boolean;
}
export type RefreshWorkerCatalogs = (
  input: { paneId?: string; restart?: boolean },
  authority?: WorkerCatalogRefreshAuthority,
) => Promise<FleetWorkerCatalogRefreshResult>;

/** Coordinates only original native controllers. A missing controller fails visibly. */
export function createWorkerToolRefresh(input: {
  captain: CaptainPort;
  local: ReturnType<typeof createLocalCodexCatalogCoordinator>;
  remote: RemoteCodexSeats;
  workerMcp: WorkerMcp;
  revision: string;
  intervalMs?: number;
}) {
  let revision = input.revision,
    stopped = false,
    ticking = false;
  type Seat = Awaited<ReturnType<NonNullable<CaptainPort["workerCatalogSeats"]>>>[number];
  type Result = FleetWorkerCatalogRefreshResult["seats"][number];
  const complete = new Map<string, string>();
  const pending = new Map<
    string,
    {
      seat: Seat;
      revision: string;
      serviceRevision: string;
      since: number;
      signaled?: boolean;
      authority?: WorkerCatalogRefreshAuthority;
    }
  >();
  const key = (seat: Seat, _target?: string) => JSON.stringify([seat.paneId, seat.seatId, seat.sessionId]);
  const guard = async (authority?: WorkerCatalogRefreshAuthority) => {
    if (stopped) throw new Error("worker_catalog_refresh_closed");
    await authority?.guard();
    if (stopped) throw new Error("worker_catalog_refresh_closed");
    if (authority?.current() === false) throw new Error("worker_catalog_refresh_authority_changed");
  };
  const run = async (
    seat: Seat,
    target: string,
    authority?: WorkerCatalogRefreshAuthority,
    restart = false,
  ): Promise<Result> => {
    const base = { paneId: seat.paneId, seatId: seat.seatId, revision: target };
    try {
      await guard(authority);
      const fresh = await input.captain.workerCatalogSeats?.();
      if (!fresh?.some((row) => key(row, target) === key(seat, target)))
        return { ...base, outcome: "failed", reason: "original_native_session_changed" };
      if (seat.harness === "codex") {
        const qualified = splitFleetQualified(seat.paneId);
        const results = qualified
          ? await input.remote.refreshCatalogs({ paneId: seat.paneId, revision: target })
          : await input.local.refresh({
              paneId: seat.paneId,
              revision: target,
              ...(authority
                ? { beforeDispatch: () => guard(authority), current: () => authority.current() }
                : {}),
            });
        const result = results.find((row) => row.paneId === seat.paneId);
        if (result && result.revision !== target)
          return { ...base, outcome: "skipped-busy", reason: "original_controller_refresh_already_pending" };
        if (!qualified && result?.reason === "original_codex_catalog_unverified") {
          if (!restart) return { ...base, outcome: "restart-needed", reason: result.reason };
          if (!authority || !input.captain.restartWorkerTools)
            return { ...base, outcome: "failed", reason: "supervised_restart_authority_required" };
          await guard(authority);
          const restarted = await input.captain.restartWorkerTools({ paneId: seat.paneId }, authority);
          return {
            ...base,
            outcome:
              restarted.outcome === "restarted"
                ? "restarted"
                : restarted.reason === "busy"
                  ? "skipped-busy"
                  : "failed",
            ...(restarted.reason ? { reason: restarted.reason } : {}),
            ...(restarted.threadId ? { threadId: restarted.threadId } : {}),
          };
        }
        return result
          ? {
              ...base,
              outcome: result.outcome,
              ...(result.threadId ? { threadId: result.threadId } : {}),
              ...(result.reason ? { reason: result.reason.slice(0, 1024) } : {}),
            }
          : {
              ...base,
              outcome: "failed",
              reason: qualified
                ? "original_remote_codex_registration_unavailable"
                : "original_local_codex_registration_unavailable",
            };
      }
      let nativeConnected = false;
      if (seat.harness === "opencode") {
        const result = await input.captain.refreshNativeWorkerCatalog?.(seat.paneId, {
          revision: target,
          beforeDispatch: () => guard(authority),
        });
        if (result?.outcome !== "refreshed")
          return {
            ...base,
            ...(result ?? { outcome: "failed", reason: "original_native_catalog_refresh_unavailable" }),
          };
        nativeConnected = true;
      }
      if (seat.harness !== "claude" && seat.harness !== "opencode")
        return { ...base, outcome: "failed", reason: "native_catalog_refresh_unsupported" };
      const qualified = splitFleetQualified(seat.paneId),
        fleet = qualified?.fleet ?? "default",
        pane = qualified?.id ?? seat.paneId;
      const held = pending.get(key(seat, target));
      const nativeStatus = fresh.find((row) => row.paneId === seat.paneId)?.status;
      if (["working", "busy", "blocked"].includes(nativeStatus ?? "")) {
        if (!held || held.revision !== target)
          pending.set(key(seat, target), {
            seat,
            revision: target,
            serviceRevision: revision,
            since: Date.now(),
            ...(authority ? { authority } : {}),
          });
        return { ...base, outcome: "skipped-busy", reason: "original_native_session_busy" };
      }
      if (!held || held.revision !== target || !held.signaled) {
        await guard(authority);
        input.workerMcp.requestCatalogRefresh(fleet, pane, target);
        pending.set(key(seat, target), {
          seat,
          revision: target,
          serviceRevision: revision,
          since: Date.now(),
          signaled: true,
          ...(authority ? { authority } : {}),
        });
      }
      const request = pending.get(key(seat, target))!;
      const status = input.workerMcp.bridgeStatus(fleet, pane);
      const health = (await input.captain.toolCatalogHealth()).seats.find(
        (row) => row.paneId === seat.paneId && row.seatId === seat.seatId,
      )?.toolCatalog;
      await guard(authority);
      if (pending.get(key(seat, target)) !== request)
        return { ...base, outcome: "skipped-busy", reason: "newer_native_catalog_refresh_pending" };
      const currentSeats = await input.captain.workerCatalogSeats?.();
      if (!currentSeats?.some((row) => key(row) === key(seat)))
        return { ...base, outcome: "failed", reason: "original_native_session_changed" };
      await guard(authority);
      const nativeVerified =
        nativeConnected ||
        (health?.status === "matched" &&
          health.sessionId === seat.sessionId &&
          health.checkedAt &&
          Date.parse(health.checkedAt) >= request.since);
      if (status.runtimeRevision === target && status.behind === false && nativeVerified) {
        return {
          ...base,
          outcome: "refreshed",
          reason: nativeConnected
            ? "original_opencode_connection_and_runtime_observed_names_unverified"
            : "original_claude_catalog_and_runtime_observed",
        };
      }
      const nativeBusy = fresh.find((row) => row.paneId === seat.paneId)?.status;
      if (Date.now() - request.since > 30_000 && !["working", "busy", "blocked"].includes(nativeBusy ?? "")) {
        return { ...base, outcome: "failed", reason: "original_native_refresh_not_verified" };
      }
      return { ...base, outcome: "skipped-busy", reason: "original_native_refresh_pending" };
    } catch {
      return {
        ...base,
        outcome: "failed",
        reason:
          authority?.current() === false
            ? "worker_catalog_refresh_authority_changed"
            : "original_native_catalog_refresh_unavailable",
      };
    }
  };
  const perform = async (
    selection: { paneId?: string; restart?: boolean },
    target: string,
    authority?: WorkerCatalogRefreshAuthority,
  ): Promise<FleetWorkerCatalogRefreshResult> => {
    const serviceRevision = revision;
    await guard(authority);
    if (selection.restart && (!selection.paneId || !authority))
      throw new Error("Supervised restart requires one exact pane and lead authority");
    const roster = await input.captain.workerCatalogSeats?.();
    if (!roster) throw new Error("worker_catalog_roster_unavailable");
    const seats = roster
      .filter((row) => selection.paneId === undefined || row.paneId === selection.paneId)
      .slice(0, 256);
    const results: Result[] = [];
    // Avoid hundreds of simultaneous native-controller probes under fleet load.
    for (const seat of seats) {
      const result = await run(seat, target, authority, selection.restart === true);
      results.push(result);
      if (result.outcome !== "skipped-busy") {
        complete.set(key(seat, target), serviceRevision);
        if (pending.get(key(seat, target))?.revision === target) pending.delete(key(seat, target));
      } else if (!selection.restart && seat.harness !== "claude")
        pending.set(key(seat, target), {
          seat,
          revision: target,
          serviceRevision: revision,
          since: Date.now(),
          ...(authority ? { authority } : {}),
        });
    }
    if (selection.paneId !== undefined && !seats.length)
      results.push({
        paneId: selection.paneId,
        revision: target,
        outcome: "failed",
        reason: "original_native_seat_unavailable",
      });
    return { schemaVersion: 1, revision: target, seats: results };
  };
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const roster = (await input.captain.workerCatalogSeats?.()) ?? [];
      const live = new Set(roster.map((row) => key(row)));
      for (const id of complete.keys()) if (!live.has(id)) complete.delete(id);
      for (const id of pending.keys()) if (!live.has(id)) pending.delete(id);
      for (const [id, held] of pending) {
        const result = await run(held.seat, held.revision, held.authority);
        if (result.outcome !== "skipped-busy" && pending.get(id) === held) {
          pending.delete(id);
          complete.set(id, held.serviceRevision);
        }
      }
      for (const seat of roster) {
        if (
          complete.get(key(seat, revision)) === revision ||
          [...pending.values()].some((row) => row.seat.paneId === seat.paneId)
        )
          continue;
        const result = await perform({ paneId: seat.paneId }, revision);
        if (result.seats.some((row) => row.outcome === "skipped-busy")) continue;
      }
    } catch {
      /* A failed read leaves original controllers and receipts untouched. */
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), input.intervalMs ?? 5_000);
  timer.unref();
  return {
    refresh: ((selection, authority) => perform(selection, randomUUID(), authority)) as RefreshWorkerCatalogs,
    expectRevision(value: string) {
      revision = value;
      input.workerMcp.expectRuntimeRevision(value);
      void tick();
    },
    close() {
      stopped = true;
      clearInterval(timer);
      input.local.close();
    },
  };
}
