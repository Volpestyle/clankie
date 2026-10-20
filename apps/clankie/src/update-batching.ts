/**
 * Batched self-updates for a source checkout (VUH-2393). Clankie used to update
 * his own install after nearly every landing: 250 cutovers from 2026-10-06 to
 * 2026-10-17, 15 to 70 a day, each restarting the service and the Discord
 * bodies with it. An update that follows `main` now applies at once only when
 * the body is idle or this service has run for the batching interval;
 * otherwise it is recorded and the newest `main` is applied when either becomes
 * true, so a run of landings costs one restart. An explicit ref (a rollback, a
 * pinned commit), a hold override or `now` applies at once, as before.
 *
 * A deferred update is applied later under the service's own authority, the
 * way a hosted body's scheduled install is (ADR 0237), and passes the same deploy
 * holds, canary and rollback. Its record names who asked.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RepeatedWarnings } from "@clankie/observability";
import type {
  DeferredRuntimeUpdate,
  RuntimeUpdater,
  RuntimeUpdateStatus,
  UpdateAuthority,
} from "../../tui/bin/runtime-updater.ts";
import { parseUpdateInitiator, type RuntimeUpdateInitiator } from "../../tui/bin/runtime-update.ts";
import { boundedString, object, readPrivateJson, writePrivateJson } from "../../tui/bin/update-files.ts";

/** At most one batched update per this much service uptime, unless the body is idle. */
export const DEFAULT_UPDATE_BATCH_MS = 2 * 60 * 60_000;
const CHECK_INTERVAL_MS = 60_000;

type UpdateResult = RuntimeUpdateStatus & { readonly accepted: boolean };

/** The spellings of "follow main" a request uses; anything else names a target and applies at once. */
const FOLLOWS_MAIN = new Set(["main", "origin/main", "refs/heads/main", "refs/remotes/origin/main"]);

export interface UpdateBatchingOptions {
  readonly updater: RuntimeUpdater;
  /** `~/.clankie/updates/deferred.json`, beside the update journal. */
  readonly path: string;
  readonly intervalMs?: number;
  /** When this service instance started; the interval counts from its boot. */
  readonly bootedAt: number;
  /** No captain turn, activity share or voice call, and no worker agent working. */
  readonly idle: () => Promise<boolean>;
  /** The full update path for a deferred update: deploy holds, then the updater. */
  readonly apply: (ref: string, authority: UpdateAuthority) => Promise<UpdateResult>;
  readonly logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  readonly now?: () => number;
  readonly checkIntervalMs?: number;
}

function readDeferredUpdate(path: string): DeferredRuntimeUpdate | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = object(readPrivateJson(path));
    const time = (key: string) => {
      const text = boundedString(value[key], 64);
      if (!Number.isFinite(Date.parse(text))) throw Error("Invalid deferred update time");
      return text;
    };
    if (value.ref !== "main" || !Number.isSafeInteger(value.requests) || Number(value.requests) < 1)
      throw Error("Invalid deferred update");
    return {
      ref: "main",
      firstRequestedAt: time("firstRequestedAt"),
      lastRequestedAt: time("lastRequestedAt"),
      dueAt: time("dueAt"),
      requests: value.requests as number,
      initiator: parseUpdateInitiator(value.initiator),
    };
  } catch {
    // A damaged record defers nothing; the next request writes a fresh one.
    return undefined;
  }
}

/** Wraps a checkout updater so that following `main` batches; everything else passes through. */
export function batchRuntimeUpdates(options: UpdateBatchingOptions): RuntimeUpdater & {
  check(): Promise<string>;
  close(): void;
} {
  const { updater, path } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_UPDATE_BATCH_MS;
  const now = options.now ?? Date.now;
  const blocked = new RepeatedWarnings({ windowMs: 30 * 60_000 });
  let checking = false;

  const clear = () => rmSync(path, { force: true });
  const status = (): RuntimeUpdateStatus => {
    const deferred = readDeferredUpdate(path);
    return { ...updater.status(), ...(deferred === undefined ? {} : { deferred }) };
  };
  const applied = async (run: Promise<UpdateResult>): Promise<UpdateResult> => {
    const result = await run;
    // An accepted update takes the newest `main`, which covers every deferred request.
    if (result.accepted) clear();
    return result;
  };
  const defer = (initiator: RuntimeUpdateInitiator): DeferredRuntimeUpdate => {
    const at = new Date(now()).toISOString();
    const previous = readDeferredUpdate(path);
    const deferred: DeferredRuntimeUpdate = {
      ref: "main",
      firstRequestedAt: previous?.firstRequestedAt ?? at,
      lastRequestedAt: at,
      dueAt: new Date(options.bootedAt + intervalMs).toISOString(),
      requests: (previous?.requests ?? 0) + 1,
      initiator,
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // A write that died mid-way leaves its temporary behind; it is never the record.
    rmSync(join(dirname(path), `.${basename(path)}.next`), { force: true });
    writePrivateJson(path, deferred);
    return deferred;
  };

  const check = async (): Promise<string> => {
    if (checking) return "busy";
    checking = true;
    try {
      const deferred = readDeferredUpdate(path);
      if (deferred === undefined) return "none";
      if (updater.status().pending !== undefined) return "in-flight";
      if (now() < Date.parse(deferred.dueAt) && !(await options.idle())) return "waiting";
      // Nothing new on main: drop the batch rather than restart into the same commit.
      const target = await updater.preview?.("main");
      if (target !== undefined && target.commitCount === 0) {
        clear();
        return "current";
      }
      const result = await options.apply("main", {
        guard: async () => {
          if (readDeferredUpdate(path)?.firstRequestedAt !== deferred.firstRequestedAt)
            throw Error("Deferred update was cancelled or replaced");
        },
        current: () => true,
        initiator: deferred.initiator,
      });
      if (result.accepted) {
        clear();
        options.logger.info(
          {
            event: "runtime.update.batched",
            pending: result.pending,
            requests: deferred.requests,
            firstRequestedAt: deferred.firstRequestedAt,
          },
          "Applying the batched update",
        );
        return "applied";
      }
      const reason = result.blockedReason ?? "not-accepted";
      if (blocked.admit(reason).write)
        options.logger.info({ event: "runtime.update.batch_waiting", reason }, "Batched update is waiting");
      return "blocked";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const { write, suppressed } = blocked.admit(detail);
      // A deploy hold or a failed fetch is a wait, not a fault; the next check retries.
      if (write)
        options.logger.info(
          { event: "runtime.update.batch_waiting", error: detail, ...(suppressed > 0 ? { suppressed } : {}) },
          "Batched update is waiting",
        );
      return "waiting";
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), options.checkIntervalMs ?? CHECK_INTERVAL_MS);
  timer.unref();

  return {
    ...(updater.queuesIntegrationWait ? { queuesIntegrationWait: true } : {}),
    runtime: updater.runtime,
    status,
    ...(updater.preview === undefined ? {} : { preview: updater.preview }),
    ...(updater.reconcile === undefined ? {} : { reconcile: updater.reconcile }),
    ...(updater.retainRuntimes === undefined ? {} : { retainRuntimes: updater.retainRuntimes }),
    async request(ref, authority, request) {
      if (request?.now === true || !FOLLOWS_MAIN.has(ref) || (authority.overriddenHolds?.length ?? 0) > 0)
        return await applied(updater.request(ref, authority));
      await authority.guard();
      if (!authority.current()) throw Error("Update authority expired");
      if (now() - options.bootedAt >= intervalMs || (await options.idle()))
        return await applied(updater.request(ref, authority));
      const deferred = defer(authority.initiator ?? { kind: "operator" });
      return { ...status(), deferred, accepted: false };
    },
    cancelDeferred() {
      const deferred = readDeferredUpdate(path);
      clear();
      return (updater.cancelDeferred?.() ?? false) || deferred !== undefined;
    },
    check,
    close: () => clearInterval(timer),
  };
}
