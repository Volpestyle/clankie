import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import type { LaneSession } from "./captain-types.ts";
import type { DiscordSessionAccess } from "./room-skill-tools.ts";
import {
  ConversationRunStalledError,
  type ConversationServiceRun,
  waitForConversationRun,
} from "./conversation-run.ts";

const COMPACTION_STALLED = "clankie-compaction-stalled";

/** Durable lanes share cache eviction, cancellation and compaction recovery. */
export function createDurableSessions(ctx: {
  readonly sessions: Map<string, Promise<LaneSession>>;
  readonly buildSession: (
    lane: CaptainSessionLaneV2,
    manager: SessionManager,
    systemTools: boolean,
    cwd: string,
    sideConversation?: boolean,
    conversationId?: string,
    run?: ConversationServiceRun,
    access?: DiscordSessionAccess,
  ) => Promise<LaneSession>;
  readonly recoveryContext: (conversationId: string) => string;
}) {
  return function durableSession(
    key: string,
    lane: CaptainSessionLaneV2,
    dir: string,
    systemTools: boolean,
    cwd: string,
    sideConversation = false,
    run?: ConversationServiceRun,
    /** Start a new session file instead of resuming; older files stay on disk. */
    fresh = false,
    conversationId = key.startsWith("operator:") || key.startsWith("ask-social:")
      ? key.slice(key.indexOf(":") + 1)
      : undefined,
    /** A Discord room loop's grant, fixed by its key (ADR 0291). */
    access?: DiscordSessionAccess,
  ): Promise<LaneSession> {
    run?.signal.throwIfAborted();
    if (fresh) {
      const previous = ctx.sessions.get(key);
      ctx.sessions.delete(key);
      void previous?.then(
        (lane) => lane.session.dispose(),
        () => undefined,
      );
    }
    let pending = ctx.sessions.get(key);
    if (pending === undefined) {
      const created = (async () => {
        let manager: SessionManager;
        if (fresh) manager = SessionManager.create(cwd, dir);
        else
          try {
            manager = SessionManager.continueRecent(cwd, dir);
          } catch {
            manager = SessionManager.create(cwd, dir);
          }
        // A cache eviction alone would continueRecent() the same oversized file.
        // Keep the abandoned session as evidence and seed a new one from the log.
        if (
          manager
            .getEntries()
            .some((entry) => entry.type === "custom" && entry.customType === COMPACTION_STALLED)
        ) {
          if (conversationId === undefined) throw new Error("Compaction recovery needs its conversation log");
          const abandonedSessionId = manager.getSessionId();
          manager = SessionManager.create(cwd, dir);
          manager.appendCustomMessageEntry(COMPACTION_STALLED, ctx.recoveryContext(conversationId), false, {
            abandonedSessionId,
          });
        }
        return ctx.buildSession(
          lane,
          manager,
          systemTools,
          cwd,
          sideConversation,
          key.startsWith("operator:") ? key.slice("operator:".length) : undefined,
          run,
          access,
        );
      })();
      ctx.sessions.set(key, created);
      void created.catch(() => {
        if (ctx.sessions.get(key) === created) ctx.sessions.delete(key);
      });
      pending = created;
    }
    if (run === undefined) return pending;
    const selected = pending;
    const onAbort = (): void => {
      if (ctx.sessions.get(key) === selected) ctx.sessions.delete(key);
      // The dependency may ignore its signal. If it finishes later, this lane
      // belongs to the abandoned run and cannot return to the session cache.
      void selected.then(
        (lane) => {
          if (run.signal.reason instanceof ConversationRunStalledError && run.signal.reason.compacting) {
            // Pi may finish an aborted preflight compaction and continue prompt().
            // Fence this abandoned session before aborting it; it must make no
            // later model request while the fresh lane drains queued inputs.
            const reason = run.signal.reason;
            lane.session.agent.streamFunction = () => {
              throw reason;
            };
            lane.session.sessionManager.appendCustomEntry(COMPACTION_STALLED, {
              reason: run.signal.reason.message,
            });
          }
          void lane.session.abort().catch(() => {
            console.warn("Abandoned durable session could not be aborted", key);
          });
          lane.session.dispose();
        },
        () => undefined,
      );
    };
    run.signal.addEventListener("abort", onAbort, { once: true });
    run.onClose(() => run.signal.removeEventListener("abort", onAbort));
    if (run.signal.aborted) onAbort();
    return waitForConversationRun(selected, run.signal).then((lane) => {
      run.signal.throwIfAborted();
      return lane;
    });
  };
}
