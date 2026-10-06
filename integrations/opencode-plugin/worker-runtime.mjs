import { projectMessages } from "./runtime.mjs";

// This module consumes the native TUI's SDKv2 client, never a discovered HTTP
// endpoint or the operator plugin's credentials. The controller owns admission.
export const WORKER_OPENCODE_VERSION = "1.18.18";
const sessionPattern = /^ses_[A-Za-z0-9]{8,128}$/u;
const messagePattern = /^msg_[A-Za-z0-9]{8,128}$/u;
const MAX_TEXT = 128 * 1024;
const plainRecord = (value) =>
  value !== null &&
  typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function nativeStatus(value, absent = false) {
  if (absent) return "idle";
  if (!plainRecord(value)) throw new Error("Malformed native session status");
  if (value.type === "idle" || value.type === "busy") return value.type;
  if (
    value.type === "retry" &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt >= 0 &&
    typeof value.message === "string" &&
    Number.isSafeInteger(value.next) &&
    value.next >= 0
  )
    return "retry";
  throw new Error("Malformed native session status");
}

export function createOpenCodeWorkerRuntime(api, controller) {
  let sessionId;
  let initializing = false;
  let initialized = false;
  let retired = false;
  let switched = false;
  let generation = 0;
  let routeKey;
  let sending = false;
  let refreshing = false;
  let activityGeneration = 0;
  let activityObserved = false;
  let activityObserverInvalid = false;
  const activeNativeSessions = new Set();
  const stopActivity = [];
  try {
    if (typeof api.event?.on === "function") {
      // Pinned TuiEventBus uses SDKv2 Event, whose session.status payload is
      // properties.{sessionID,status}. Observe all sessions sharing this MCP
      // client, including children. Keep only a monotonic activity fence, not
      // tool arguments, owner questions, or another session's content.
      for (const type of ["session.status", "permission.asked", "question.asked"]) {
        const stop = api.event.on(type, (event) => {
          activityGeneration += 1;
          if (type !== "session.status") return;
          try {
            const id = event.properties?.sessionID;
            if (!sessionPattern.test(id ?? "")) throw new Error("Invalid native activity event");
            const status = nativeStatus(event.properties.status);
            if (status === "idle") activeNativeSessions.delete(id);
            else activeNativeSessions.add(id);
          } catch {
            activityObserverInvalid = true;
            activityObserved = false;
          }
        });
        if (typeof stop !== "function") throw new Error("Native activity observer unavailable");
        stopActivity.push(stop);
      }
      activityObserved = !activityObserverInvalid;
    }
  } catch {
    // An unavailable observer only disables refresh, preserving existing native
    // delivery/control. Its failure must never be treated as proof of idle.
  }
  let selectedModel;
  let selectedVariant;
  const route = () => {
    const current = api.route.current;
    return current?.name === "session" && typeof current.params?.sessionID === "string"
      ? current.params.sessionID
      : undefined;
  };
  const observeRoute = () => {
    const current = api.route.current;
    const key = JSON.stringify([current?.name, current?.params?.sessionID]);
    if (key !== routeKey) {
      routeKey = key;
      generation += 1;
      if (initialized && route() !== sessionId) switched = true;
    }
  };
  // The host plugin supplies its shared Solid runtime, not a second Solid copy.
  // Solid batches may coalesce intermediate states; this is an observed change
  // fence, not an atomic transaction with native server acceptance.
  const stopRoute = controller.watchRoute(observeRoute);
  const alive = () => {
    observeRoute();
    if (retired || api.lifecycle.signal.aborted || !controller.connected())
      throw new Error("OpenCode worker endpoint is unavailable");
    if (api.app.version !== WORKER_OPENCODE_VERSION)
      throw new Error(`OpenCode worker requires exactly ${WORKER_OPENCODE_VERSION}`);
    if (switched) throw new Error("The owner changed the displayed session; this control is retired");
  };
  const bound = (expectedGeneration) => {
    alive();
    if (!initialized || route() !== sessionId || generation !== expectedGeneration)
      throw new Error("The displayed native session changed");
  };
  const options = () => ({
    throwOnError: true,
    signal: AbortSignal.any([api.lifecycle.signal, AbortSignal.timeout(10_000)]),
  });
  const assertWorkerProjection = () => {
    const worker = api.state.config?.mcp?.clankie;
    if (
      worker?.type !== "local" ||
      worker.enabled !== true ||
      JSON.stringify(worker.command) !== JSON.stringify(["clankie", "mcp", "--fleet"])
    )
      throw new Error("Native worker MCP projection is unavailable");
    for (const [name, server] of Object.entries(api.state.config.mcp)) {
      if (server.enabled === false) continue;
      const host = (() => {
        try {
          return new URL(server.url).hostname;
        } catch {
          return "";
        }
      })();
      if (
        /linear/iu.test(name) ||
        host === "linear.app" ||
        host.endsWith(".linear.app") ||
        /\blinear-mcp\b|@linear\//iu.test(Array.isArray(server.command) ? server.command.join(" ") : "")
      )
        throw new Error("Inherited personal tracker is not isolated");
    }
  };
  const snapshot = async () => {
    alive();
    const before = generation;
    bound(before);
    if (!api.state.ready) throw new Error("Native TUI state is not ready");
    assertWorkerProjection();
    const selected = await api.client.session.get({ sessionID: sessionId }, options());
    bound(before);
    if (selected.data?.id !== sessionId) throw new Error("Native session lookup disagrees with the TUI");
    const statuses = await api.client.session.status({}, options());
    bound(before);
    if (!plainRecord(statuses.data)) throw new Error("Native status unavailable");
    const permissions = await api.client.permission.list({}, options());
    bound(before);
    const questions = await api.client.question.list({}, options());
    bound(before);
    if (!Array.isArray(permissions.data) || !Array.isArray(questions.data))
      throw new Error("Native owner decisions unavailable");
    const held =
      permissions.data.some((entry) => entry.sessionID === sessionId) ||
      questions.data.some((entry) => entry.sessionID === sessionId) ||
      api.state.session.permission(sessionId).length > 0 ||
      api.state.session.question(sessionId).length > 0;
    // Native SessionStatus removes idle entries. An absent entry in a successful
    // complete status response is idle; a missing/error response is unavailable.
    const status = nativeStatus(statuses.data[sessionId], !Object.hasOwn(statuses.data, sessionId));
    return {
      generation: before,
      state: held ? "blocked" : status === "idle" ? "idle" : "working",
      catalogBusy:
        permissions.data.length > 0 ||
        questions.data.length > 0 ||
        Object.values(statuses.data).some((entry) => nativeStatus(entry) !== "idle"),
    };
  };

  return {
    async initialize(input) {
      alive();
      if (initializing || initialized) throw new Error("A worker launch can initialize only once");
      initializing = true;
      const before = generation;
      await controller.authorize("initialize");
      alive();
      if (generation !== before) throw new Error("Native route changed during initialization");
      if (input.model !== undefined) {
        const split = input.model.indexOf("/");
        if (split < 1 || split === input.model.length - 1) throw new Error("Model must be provider/model");
        selectedModel = { providerID: input.model.slice(0, split), modelID: input.model.slice(split + 1) };
        const providers = await api.client.provider.list({}, options());
        alive();
        if (generation !== before) throw new Error("Native route changed during model lookup");
        const provider = providers.data?.all?.find((entry) => entry.id === selectedModel.providerID);
        const model = provider?.models?.[selectedModel.modelID];
        if (!model || !providers.data?.connected?.includes(selectedModel.providerID))
          throw new Error("Selected model/provider is unavailable in this native runtime");
        if (input.effort !== undefined && !Object.hasOwn(model.variants ?? {}, input.effort))
          throw new Error("Selected native model does not support this variant");
        selectedVariant = input.effort;
      } else if (input.effort !== undefined) {
        throw new Error("A native variant requires an explicit model");
      }
      if (input.resumeSessionId !== undefined) {
        if (!sessionPattern.test(input.resumeSessionId) || route() !== input.resumeSessionId)
          throw new Error("Native --session did not select the exact saved session");
        sessionId = input.resumeSessionId;
      } else {
        if (api.route.current.name !== "home")
          throw new Error("Fresh native view is not at its initial home");
        // Only called during the named TUI plugin's FIRST awaited initialization.
        // Pinned app.tsx does not mount Home/Session (and thus a prompt/draft)
        // until pluginHost.start resolves. Never called on reload or reattach.
        const created = await api.client.session.create(
          { directory: input.cwd, title: input.title },
          options(),
        );
        alive();
        if (generation !== before || api.route.current.name !== "home")
          throw new Error("Native route changed while creating the session; no navigation or brief");
        if (!sessionPattern.test(created.data?.id ?? "")) throw new Error("Native session creation failed");
        sessionId = created.data.id;
        api.route.navigate("session", { sessionID: sessionId });
        observeRoute();
        if (route() !== sessionId) throw new Error("Created session is not displayed");
      }
      const selectedGeneration = generation;
      const selected = await api.client.session.get({ sessionID: sessionId }, options());
      alive();
      if (
        selected.data?.id !== sessionId ||
        selected.data?.directory !== input.cwd ||
        route() !== sessionId ||
        generation !== selectedGeneration
      )
        throw new Error("Native session is not displayed after initialization");
      initialized = true;
      return { sessionId, version: api.app.version };
    },
    async status() {
      return (await snapshot()).state;
    },
    async refreshToolCatalog() {
      if (sending || refreshing) return { outcome: "skipped-busy", reason: "native-action-pending" };
      if (!activityObserved) return { outcome: "failed", reason: "native-mcp-refresh-unsupported" };
      if (activeNativeSessions.size) return { outcome: "skipped-busy", reason: "native-session-busy" };
      refreshing = true;
      try {
        const activity = activityGeneration;
        const initial = await snapshot();
        if (initial.state !== "idle" || initial.catalogBusy || activityGeneration !== activity)
          return { outcome: "skipped-busy", reason: "native-session-busy" };
        if (typeof api.client.mcp?.status !== "function")
          return { outcome: "failed", reason: "native-mcp-refresh-unsupported" };
        const fresh = await snapshot();
        bound(initial.generation);
        if (fresh.state !== "idle" || fresh.catalogBusy || activityGeneration !== activity)
          return { outcome: "skipped-busy", reason: "native-session-busy" };
        // Admission runs after async preparation, immediately before observing
        // the existing native connection. Its guard belongs to the original
        // controller, not this plugin's cached launch parameters.
        await controller.authorize("refreshToolCatalog");
        bound(initial.generation);
        assertWorkerProjection();
        if (!activityObserved) return { outcome: "failed", reason: "native-mcp-refresh-unsupported" };
        if (activeNativeSessions.size || activityGeneration !== activity)
          return { outcome: "skipped-busy", reason: "native-session-busy" };
        // Check the native TUI's synchronous owner-decision/turn snapshot again
        // immediately before observing this worker's configured MCP client.
        const localStatus = api.state.session.status(sessionId);
        if (
          nativeStatus(localStatus, localStatus === undefined) !== "idle" ||
          api.state.session.permission(sessionId).length > 0 ||
          api.state.session.question(sessionId).length > 0
        )
          return { outcome: "skipped-busy", reason: "native-session-busy" };
        // The pinned native tools/list_changed handler reads new definitions
        // through the existing client. mcp.connect replaces and closes that
        // client without an atomic activity guard, so refresh must never call
        // it. Observation preserves a call that starts during this await.
        const statuses = await api.client.mcp.status({}, options());
        bound(initial.generation);
        if (!activityObserved) return { outcome: "failed", reason: "native-mcp-refresh-unsupported" };
        if (activeNativeSessions.size || activityGeneration !== activity)
          return { outcome: "skipped-busy", reason: "native-session-busy" };
        const currentStatus = api.state.session.status(sessionId);
        if (
          nativeStatus(currentStatus, currentStatus === undefined) !== "idle" ||
          api.state.session.permission(sessionId).length > 0 ||
          api.state.session.question(sessionId).length > 0
        )
          return { outcome: "skipped-busy", reason: "native-session-busy" };
        if (statuses.data?.clankie?.status !== "connected")
          return { outcome: "failed", reason: "native-mcp-refresh-unconfirmed" };
        // This proves only the original connection. The service separately
        // requires the bridge's actual tools/list observation at its revision;
        // the native SDK does not expose exact model-visible MCP tool names.
        return { outcome: "refreshed", reason: "original-native-clankie-connection-observed" };
      } catch {
        // Native errors may include provider/configuration details. The fleet
        // result names the bounded failure without copying any raw error.
        return { outcome: "failed", reason: "original-native-control-unavailable" };
      } finally {
        refreshing = false;
      }
    },
    async history() {
      const before = await snapshot();
      await controller.authorize("history");
      bound(before.generation);
      const result = await api.client.session.messages({ sessionID: sessionId, limit: 100 }, options());
      bound(before.generation);
      if (!Array.isArray(result.data)) throw new Error("Native history unavailable");
      return projectMessages(sessionId, result.data);
    },
    async settlement(input) {
      if (!messagePattern.test(input?.messageId ?? "")) return { state: "pending" };
      const before = await snapshot();
      if (before.state !== "idle") return { state: "pending" };
      await controller.authorize("history");
      bound(before.generation);
      const result = await api.client.session.messages({ sessionID: sessionId, limit: 100 }, options());
      bound(before.generation);
      if (!Array.isArray(result.data)) throw new Error("Native completion history unavailable");
      const reply = result.data.findLast(
        ({ info }) =>
          info.sessionID === sessionId &&
          info.role === "assistant" &&
          info.parentID === input.messageId &&
          typeof info.time?.completed === "number" &&
          (info.error || (info.finish && !["tool-calls", "unknown"].includes(info.finish))),
      );
      if (!reply) return { state: "pending" };
      const text = projectMessages(sessionId, [reply])
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.text)
        .join("")
        .slice(-32_768);
      return {
        state: "completed",
        ok: !reply.info.error,
        text,
        ...(reply.info.error ? { stopReason: String(reply.info.error.name ?? "native-error") } : {}),
      };
    },
    async send(input) {
      if (sending || refreshing)
        return { outcome: "unavailable", detail: "Another native action is pending" };
      if (
        !messagePattern.test(input.messageId ?? "") ||
        typeof input.text !== "string" ||
        input.text.length === 0 ||
        input.text.length > MAX_TEXT
      )
        throw new Error("Invalid worker message");
      sending = true;
      let claimed = false;
      let attempted = false;
      try {
        const initial = await snapshot();
        if (initial.state !== "idle") return { outcome: "unavailable", detail: initial.state };
        await controller.authorize("send");
        bound(initial.generation);
        const fresh = await snapshot();
        bound(initial.generation);
        if (fresh.state !== "idle") return { outcome: "unavailable", detail: fresh.state };
        await controller.claim({ sessionId, messageId: input.messageId, text: input.text });
        claimed = true;
        bound(initial.generation);
        // Local owner decisions can arrive while the durable claim is written.
        const localStatus = api.state.session.status(sessionId);
        if (
          api.state.session.permission(sessionId).length ||
          api.state.session.question(sessionId).length ||
          nativeStatus(localStatus, localStatus === undefined) !== "idle"
        )
          throw new Error("An owner decision arrived before dispatch");
        attempted = true;
        const result = await api.client.session.promptAsync(
          {
            sessionID: sessionId,
            messageID: input.messageId,
            ...(selectedModel === undefined ? {} : { model: selectedModel }),
            ...(selectedVariant === undefined ? {} : { variant: selectedVariant }),
            parts: [{ type: "text", text: input.text }],
          },
          options(),
        );
        bound(initial.generation);
        if (result.error || result.response?.status !== 204)
          throw new Error("Native asynchronous prompt did not acknowledge acceptance");
        await controller.receipt({ sessionId, messageId: input.messageId, outcome: "accepted" });
        bound(initial.generation);
        return { outcome: "accepted", messageId: input.messageId, state: "queued" };
      } catch (error) {
        if (claimed && !attempted)
          await controller.receipt({ sessionId, messageId: input.messageId, outcome: "not-sent" });
        if (attempted) {
          // Keep the controller's durable claim. Even a later error may follow
          // server acceptance; neither this runtime nor reconnection resends.
          return { outcome: "unconfirmed", messageId: input.messageId, detail: String(error) };
        }
        return { outcome: "unavailable", detail: String(error) };
      } finally {
        sending = false;
      }
    },
    async interrupt() {
      const initial = await snapshot();
      if (initial.state !== "working") return false;
      await controller.authorize("interrupt");
      bound(initial.generation);
      const current = await snapshot();
      bound(initial.generation);
      if (current.state !== "working") return false;
      const result = await api.client.session.abort({ sessionID: sessionId }, options());
      bound(initial.generation);
      return result.data === true;
    },
    async exit() {
      const initial = await snapshot();
      if (typeof api.keymap?.dispatchCommand !== "function")
        throw new Error("Native TUI exit command unavailable");
      await controller.authorize("exit");
      bound(initial.generation);
      // This TUI exits itself. No PID signal, terminal input or conditional
      // pane.close workaround can reach a different pane occupant.
      return api.keymap.dispatchCommand("app.exit");
    },
    close() {
      retired = true;
      stopRoute();
      for (const stop of stopActivity) {
        try {
          stop();
        } catch {
          // The original control is already retired. Keep removing its other
          // observers; one host unsubscribe failure cannot retain admission.
        }
      }
      // Only control ends. No session deletion, permission answer, prompt
      // mutation, or native process/pane shutdown is performed here.
    },
  };
}
