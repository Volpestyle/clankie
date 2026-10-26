/** A deploy waiting on integration holds is an intent, not a long-lived HTTP request. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { RuntimeUpdater } from "../../tui/bin/runtime-updater.ts";
import { parseUpdateInitiator } from "../../tui/bin/runtime-update.ts";
import { readPrivateJson, privateDirectory } from "../../tui/bin/update-files.ts";
import { DeployHolds, DeployHeldError, durableJson } from "./deploy-holds.ts";

const Intent = z.object({
  id: z.uuid(),
  ref: z.string().min(1).max(256),
  initiator: z.unknown().transform(parseUpdateInitiator),
  /** Accumulated failed attempts, durable so a restart loop cannot retry forever. */
  failures: z.number().int().min(0).default(0),
});

/** A waiting update whose attempts keep failing is dropped, which releases the integrate dispatcher. */
export const INTEGRATION_UPDATE_MAX_FAILURES = 5;

export function integrationSafeUpdates(options: {
  updater: RuntimeUpdater;
  holds: DeployHolds;
  path: string;
  onError: (error: unknown) => void;
  /** Tells the lead that a waiting update gave up and no longer holds the integrate queue. */
  onGaveUp?: (message: string) => void;
  intervalMs?: number;
}): RuntimeUpdater & { check(): Promise<void>; close(): void } {
  const read = () => (existsSync(options.path) ? Intent.parse(readPrivateJson(options.path)) : undefined);
  const clear = () => rmSync(options.path, { force: true });
  const status = () => {
    const intent = read();
    const value = options.updater.status();
    return {
      ...value,
      ...(intent && !value.pending
        ? { pending: intent.id, waitingForIntegration: { id: intent.id, ref: intent.ref } }
        : {}),
    };
  };
  let closed = false;
  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => {
    if (closed) return Promise.resolve();
    return (checking ??= (async () => {
      const intent = read();
      if (!intent) return;
      if (options.updater.status().pending) return;
      const guard = async () => {
        if (closed || read()?.id !== intent.id) throw Error("Waiting update was cancelled or replaced");
      };
      const failed = async (error: unknown) => {
        const current = read();
        if (closed || current?.id !== intent.id || error instanceof DeployHeldError) return;
        const failures = current.failures + 1;
        if (failures < INTEGRATION_UPDATE_MAX_FAILURES) {
          await durableJson(options.path, { ...current, failures }, guard);
          return;
        }
        clear();
        const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
        options.onGaveUp?.(
          `Runtime update to ${intent.ref} failed ${failures} times while waiting for integration (${reason}). It was dropped and no longer holds the integrate queue; request it again once the ref resolves.`,
        );
      };
      await options.holds
        .landing(
          `integration-update:${intent.id}`,
          [],
          async () => {
            await guard();
            const target = await options.updater.preview?.(intent.ref);
            if (target?.newCommit === options.updater.runtime.commit) {
              await guard();
              clear();
              return;
            }
            // An intent is already authenticated and durable, like a deferred source update.
            // Ordinary/canary holds are checked again; an earlier override is never reused.
            const result = await options.updater.request(intent.ref, {
              guard,
              current: () => !closed && read()?.id === intent.id,
              initiator: intent.initiator,
            });
            if (result.accepted || result.upToDate) {
              if (read()?.id === intent.id) clear();
            }
          },
          { guard },
        )
        .catch(async (error: unknown) => {
          await failed(error).catch(() => undefined);
          throw error;
        });
    })()
      .catch((error: unknown) => {
        if (!closed && read() && !(error instanceof DeployHeldError)) options.onError(error);
      })
      .finally(() => {
        checking = undefined;
      }));
  };
  const timer = setInterval(() => void check(), options.intervalMs ?? 15_000);
  timer.unref();
  return {
    ...options.updater,
    queuesIntegrationWait: true,
    status,
    async request(ref, authority, request) {
      await authority.guard();
      if (!authority.current()) throw Error("Update authority expired");
      const existing = read();
      if (existing) return { ...status(), accepted: false };
      const holds = (await options.holds.list()).filter(
        (hold) =>
          hold.integrationBatchId &&
          !authority.overriddenHolds?.some((overridden) => overridden.id === hold.id),
      );
      if (!holds.length) return options.updater.request(ref, authority, request);
      // Refuse an unresolvable ref now; a durable intent must not retry one forever.
      await options.updater.preview?.(ref).catch((error: unknown) => {
        const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
        throw Error(`Update ref "${ref}" could not be resolved now: ${reason}`);
      });
      const intent = {
        id: randomUUID(),
        ref,
        initiator: authority.initiator ?? { kind: "operator" as const },
      };
      // The caller holds the registry lock, so this admission and the batch fence are atomic.
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
      privateDirectory(dirname(options.path));
      await durableJson(options.path, intent, async () => {
        await authority.guard();
        if (!authority.current()) throw Error("Update authority expired");
      });
      return { ...status(), accepted: false };
    },
    cancelDeferred() {
      const waiting = read() !== undefined;
      clear();
      return (options.updater.cancelDeferred?.() ?? false) || waiting;
    },
    check,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
