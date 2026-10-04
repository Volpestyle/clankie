// Native Pi 0.87.1 extension API only. This module never imports the captain's
// patched Pi dependency, creates a session, submits editor text, or runs a model.
const PI_WORKER_VERSION = "0.87.1";
export const PI_WORKER_MESSAGE = "clankie-worker-message";
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_TEXT = 128 * 1024;

export function createPiWorkerRuntime(pi, controller) {
  let context;
  let identity;
  let initialized = false;
  let initializing = false;
  let retired = false;
  let generation = 0;
  let settlements = 0;
  let lastSettled = 0;
  let activeSend;
  let lastMessage;
  let foreignInput = false;
  const dialogs = new Map();
  const listeners = [];
  const wakes = new Set();
  const wake = () => {
    for (const resolve of wakes) resolve();
  };
  const stop = () => {
    if (retired) return;
    retired = true;
    generation += 1;
    for (const remove of listeners) remove();
    wake();
    controller.close();
  };
  const on = (event, handler) => listeners.push(pi.on(event, handler));
  const currentIdentity = (ctx) => ({
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionDirectory: ctx.sessionManager.getSessionDir(),
    header: ctx.sessionManager.getHeader(),
    cwd: ctx.cwd,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    effort: ctx.thinkingLevel,
  });
  const bound = (epoch = generation) => {
    if (retired || !controller.connected() || !context || context.mode !== "tui" || epoch !== generation)
      throw new Error("Original native Pi control unavailable");
    if (identity && JSON.stringify(currentIdentity(context)) !== JSON.stringify(identity)) {
      stop();
      throw new Error("Native Pi session or selected model changed");
    }
    return context;
  };
  const snapshot = () => {
    const ctx = bound();
    if (!initialized) throw new Error("Native Pi is not initialized");
    if (ctx.isProjectTrusted() !== true || dialogs.size) return "blocked";
    // Pi's hasPendingMessages counts user-message queues, not custom-message
    // queues. Keep our own unresolved native invocation visible as working.
    return ctx.isIdle() && !ctx.hasPendingMessages() && !activeSend ? "idle" : "working";
  };
  const waitFor = async (predicate, timeoutMs = 10_000) => {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1), 60_000);
    while (!predicate()) {
      if (retired || !controller.connected()) throw new Error("Native Pi control retired");
      if (Date.now() >= deadline) throw new Error("Native Pi observation was not confirmed");
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wakes.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(100, deadline - Date.now()));
        wakes.add(done);
      });
    }
  };
  on("session_start", (event, ctx) => {
    if (context || event.reason !== "startup" || ctx.mode !== "tui") return stop();
    context = ctx;
    generation += 1;
    wake();
  });
  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "session_shutdown",
  ])
    on(event, stop);
  on("ui_prompt_start", (event) => {
    const key = JSON.stringify([event.kind, event.title]);
    dialogs.set(key, (dialogs.get(key) ?? 0) + 1);
    wake();
  });
  on("ui_prompt_end", (event) => {
    const key = JSON.stringify([event.kind, event.title]);
    const count = dialogs.get(key);
    // An unmatched end means observation was incomplete. Do not infer clear.
    if (!count) return stop();
    if (count === 1) dialogs.delete(key);
    else dialogs.set(key, count - 1);
    wake();
  });
  on("message_start", (event, ctx) => {
    if (!initialized) return;
    if (JSON.stringify(currentIdentity(ctx)) !== JSON.stringify(identity)) return stop();
    const message = event.message;
    const own =
      message.role === "custom" &&
      message.customType === PI_WORKER_MESSAGE &&
      message.details?.sessionId === identity.sessionId &&
      message.details?.requestId === activeSend?.messageId &&
      message.content === activeSend?.text &&
      message.display === true;
    if (own) {
      activeSend.observed = true;
      lastMessage = activeSend.messageId;
      foreignInput = false;
      lastSettled = settlements;
      wake();
    } else if (message.role === "user" || message.role === "custom") {
      // Equal owner text is never a receipt. Other input can share a native
      // agent run, so its later assistant output cannot be attributed to us.
      if (lastMessage || activeSend) foreignInput = true;
    }
  });
  on("agent_settled", (_event, ctx) => {
    if (!initialized) return;
    if (JSON.stringify(currentIdentity(ctx)) !== JSON.stringify(identity)) return stop();
    settlements += 1;
    wake();
  });

  return {
    async initialize(input) {
      if (initializing || initialized) throw new Error("Pi control initializes only once");
      initializing = true;
      await waitFor(() => context !== undefined);
      const epoch = generation;
      await controller.authorize("initialize");
      const ctx = bound(epoch);
      const selected = currentIdentity(ctx);
      if (
        !idPattern.test(selected.sessionId) ||
        typeof selected.sessionFile !== "string" ||
        !selected.sessionFile.startsWith("/") ||
        selected.cwd !== input.cwd ||
        selected.header?.type !== "session" ||
        selected.header.id !== selected.sessionId ||
        selected.header.cwd !== selected.cwd ||
        selected.header.version !== 3 ||
        (input.sessionId !== undefined && input.sessionId !== selected.sessionId) ||
        (input.sessionFile !== undefined && input.sessionFile !== selected.sessionFile) ||
        (input.model !== undefined && input.model !== selected.model) ||
        (input.effort !== undefined && input.effort !== selected.effort) ||
        ctx.isProjectTrusted() !== true
      )
        throw new Error("Native Pi launch, trust, or requested capability mismatch");
      identity = selected;
      initialized = true;
      return {
        ...identity,
        mode: ctx.mode,
        version: PI_WORKER_VERSION,
        runtime: {
          executable: process.execPath,
          argv: process.argv.slice(0, 2),
          node: process.versions.node,
        },
      };
    },
    async status() {
      return snapshot();
    },
    async send(input) {
      if (activeSend) return { outcome: "unavailable", detail: "Native invocation is still unresolved" };
      if (
        !idPattern.test(input?.messageId ?? "") ||
        typeof input.text !== "string" ||
        !input.text.length ||
        input.text.length > MAX_TEXT ||
        !["followUp", "steer"].includes(input.deliverAs ?? "followUp")
      )
        throw new Error("Invalid Pi message");
      let claimed = false;
      let attempted = false;
      const invocation = { messageId: input.messageId, text: input.text, observed: false };
      try {
        const epoch = generation;
        if (snapshot() === "blocked") return { outcome: "unavailable", detail: "Owner decision is pending" };
        await controller.authorize("send");
        bound(epoch);
        if (snapshot() === "blocked") return { outcome: "unavailable", detail: "Owner decision is pending" };
        activeSend = invocation;
        await controller.claim({
          sessionId: identity.sessionId,
          messageId: input.messageId,
          text: input.text,
        });
        claimed = true;
        const ctx = bound(epoch);
        if (snapshot() === "blocked") throw new Error("Owner decision arrived before native dispatch");
        // isIdle=false also covers compaction/retry boundaries. Queue only
        // while the native agent exposes an active, non-aborted run signal.
        if (!ctx.isIdle() && (!ctx.signal || ctx.signal.aborted))
          throw new Error("Native Pi is between agent runs or compacting");
        attempted = true;
        pi.sendMessage(
          {
            customType: PI_WORKER_MESSAGE,
            content: input.text,
            display: true,
            details: { requestId: input.messageId, sessionId: identity.sessionId },
          },
          { triggerTurn: true, deliverAs: input.deliverAs ?? "followUp" },
        );
        // void return proves nothing. Only the correlated native message event
        // confirms the queue was pulled into the agent loop, not model exposure.
        await waitFor(() => invocation.observed, input.timeoutMs);
        bound(epoch);
        await controller.receipt({
          sessionId: identity.sessionId,
          messageId: input.messageId,
          outcome: "accepted",
        });
        bound(epoch);
        activeSend = undefined;
        return { outcome: "accepted", messageId: input.messageId, state: "started" };
      } catch {
        if (claimed && !attempted) {
          try {
            await controller.receipt({
              sessionId: identity.sessionId,
              messageId: input.messageId,
              outcome: "not-sent",
            });
          } catch {
            /* Lost acknowledgement retains the controller's fence. */
          }
        }
        if (attempted)
          return {
            outcome: "unconfirmed",
            messageId: input.messageId,
            detail: "Native message observation unavailable; no automatic resend",
          };
        activeSend = undefined;
        return { outcome: "unavailable", detail: "Native Pi refused dispatch before invocation" };
      }
    },
    async settlement(input) {
      const ctx = bound();
      if (
        !initialized ||
        input?.messageId !== lastMessage ||
        settlements <= lastSettled ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        activeSend ||
        dialogs.size ||
        foreignInput
      )
        return { state: "pending" };
      const epoch = generation;
      const observedSettlement = settlements;
      await controller.authorize("history");
      bound(epoch);
      if (
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        activeSend ||
        dialogs.size ||
        foreignInput ||
        settlements !== observedSettlement
      )
        return { state: "pending" };
      const entries = ctx.sessionManager.getBranch().slice(-500);
      const index = entries.findLastIndex(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === PI_WORKER_MESSAGE &&
          entry.details?.requestId === lastMessage &&
          entry.details?.sessionId === identity.sessionId,
      );
      if (index < 0) return { state: "pending" };
      const after = entries.slice(index + 1);
      if (
        after.some(
          (entry) =>
            entry.type === "custom_message" || (entry.type === "message" && entry.message?.role === "user"),
        )
      )
        return { state: "pending" };
      const assistant = after.findLast(
        (entry) => entry.type === "message" && entry.message?.role === "assistant",
      )?.message;
      if (!assistant || !["stop", "length", "error", "aborted"].includes(assistant.stopReason))
        return { state: "pending" };
      const text = (Array.isArray(assistant.content) ? assistant.content : [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text.slice(-32_768))
        .join("")
        .slice(-32_768);
      bound(epoch);
      if (
        !ctx.isIdle() ||
        ctx.hasPendingMessages() ||
        activeSend ||
        dialogs.size ||
        foreignInput ||
        settlements !== observedSettlement
      )
        return { state: "pending" };
      return {
        state: "completed",
        ok: assistant.stopReason === "stop",
        text,
        stopReason: assistant.stopReason,
      };
    },
    async interrupt(input = {}) {
      const epoch = generation;
      const ctx = bound(epoch);
      if (snapshot() !== "working" || ctx.isIdle() || !ctx.signal) return false;
      await controller.authorize("interrupt");
      bound(epoch);
      if (snapshot() !== "working" || ctx.isIdle() || !ctx.signal) return false;
      const nativeSignal = ctx.signal;
      const before = settlements;
      ctx.abort();
      try {
        await waitFor(() => nativeSignal.aborted && settlements > before && ctx.isIdle(), input.timeoutMs);
        bound(epoch);
        return true;
      } catch {
        return false;
      }
    },
    close: stop,
  };
}
