// OpenCode 2 worker runtime. It consumes only the native TUI plugin context
// (`context.client` for this TUI's own server, `context.ui.router`,
// `context.keymap`), never a discovered HTTP endpoint or operator credentials.
// The controller owns admission; this module never retries or resends.

// The OpenCode 2 TUI plugin context members a worker calls. OpenCode publishes
// no capability list, so admission probes these exactly; the service also
// requires a validated release floor for semantics no probe can see.
const REQUIRED_CALLS = [
  "ui.router.current",
  "ui.router.navigate",
  "keymap.dispatch",
  "client.session.create",
  "client.session.get",
  "client.session.active",
  "client.session.prompt",
  "client.session.interrupt",
  "client.session.form.list",
  "client.permission.list",
  "client.message.list",
  "client.model.list",
  "client.mcp.list",
];

/** A named refusal when this OpenCode lacks the V2 worker surface, else undefined. */
export function workerSurfaceRefusal(context) {
  const at = (path) =>
    path
      .split(".")
      .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), context);
  const missing = REQUIRED_CALLS.filter((path) => typeof at(path) !== "function");
  const version = typeof context?.app?.version === "string" ? context.app.version.slice(0, 40) : "unknown";
  return missing.length
    ? `OpenCode ${version} lacks the Clankie worker surface: ${missing.join(", ")}`
    : undefined;
}

const sessionPattern = /^ses_[A-Za-z0-9]{8,128}$/u;
const messagePattern = /^msg_[A-Za-z0-9]{8,128}$/u;
const MAX_TEXT = 128 * 1024;
const isTracker = (name, server) => {
  let host = "";
  try {
    host = new URL(server?.url ?? "").hostname;
  } catch {
    /* Local MCP command. */
  }
  const command = Array.isArray(server?.command) ? server.command.join(" ") : "";
  return (
    /linear/iu.test(name) ||
    host === "linear.app" ||
    host.endsWith(".linear.app") ||
    /\blinear-mcp\b|@linear\//iu.test(command)
  );
};

/** The worker MCP projection, applied by the server part through `ctx.mcp.transform`. */
export function projectWorkerMcp(editor) {
  for (const [name, server] of editor.list()) {
    if (name !== "clankie" && isTracker(name, server))
      editor.update(name, (config) => {
        config.disabled = true;
      });
  }
  editor.set("clankie", { type: "local", command: ["clankie", "mcp", "--fleet"], disabled: false });
}

/** Text of the assistant turn, bounded from its tail. */
function assistantText(messages) {
  return messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .slice(-32_768);
}

/**
 * `controller` is the TUI module's bridge: connected(), watchRoute(observe),
 * authorize(action), claim({sessionId,messageId,text}), receipt({...}).
 */
export function createOpenCode2WorkerRuntime(context, controller) {
  const lifetime = new AbortController();
  let sessionId;
  let directory;
  let initializing = false;
  let initialized = false;
  let retired = false;
  let switched = false;
  let generation = 0;
  let routeKey;
  let sending = false;
  let refreshing = false;
  const route = () => {
    const current = context.ui.router.current();
    return current?.type === "session" && typeof current.sessionID === "string"
      ? current.sessionID
      : undefined;
  };
  const observeRoute = () => {
    const current = context.ui.router.current();
    const key = JSON.stringify([current?.type, current?.sessionID]);
    if (key !== routeKey) {
      routeKey = key;
      generation += 1;
      if (initialized && route() !== sessionId) switched = true;
    }
  };
  // The router is a Solid store in the host's runtime; the TUI module supplies
  // a computation on that runtime. A batch may coalesce intermediate routes, so
  // this is an observed change fence, not a transaction with server admission.
  const stopRoute = controller.watchRoute(observeRoute);
  const alive = () => {
    observeRoute();
    if (retired || lifetime.signal.aborted || !controller.connected())
      throw new Error("OpenCode worker endpoint is unavailable");
    if (switched) throw new Error("The owner changed the displayed session; this control is retired");
  };
  const bound = (expectedGeneration) => {
    alive();
    if (!initialized || route() !== sessionId || generation !== expectedGeneration)
      throw new Error("The displayed native session changed");
  };
  const options = () => ({
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
  });
  const location = () => ({ location: { directory } });
  const snapshot = async () => {
    alive();
    const before = generation;
    bound(before);
    const selected = await context.client.session.get({ sessionID: sessionId }, options());
    bound(before);
    if (selected?.id !== sessionId) throw new Error("Native session lookup disagrees with the TUI");
    const active = await context.client.session.active(options());
    bound(before);
    const permissions = await context.client.permission.list({ sessionID: sessionId }, options());
    bound(before);
    const forms = await context.client.session.form.list({ sessionID: sessionId }, options());
    bound(before);
    const permissionData = permissions?.data ?? permissions;
    const formData = forms?.data ?? forms;
    if (
      active === null ||
      typeof active !== "object" ||
      !Array.isArray(permissionData) ||
      !Array.isArray(formData)
    )
      throw new Error("Native status or owner decisions unavailable");
    const held = permissionData.length > 0 || formData.length > 0;
    return {
      generation: before,
      state: held ? "blocked" : Object.hasOwn(active, sessionId) ? "working" : "idle",
      catalogBusy: held || Object.keys(active).length > 0,
    };
  };
  const projection = async (expectedGeneration) => {
    const servers = await context.client.mcp.list(location(), options());
    bound(expectedGeneration);
    const data = servers?.data ?? servers;
    if (!Array.isArray(data)) throw new Error("Native MCP status unavailable");
    return data;
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
      if (typeof input?.cwd !== "string" || !input.cwd.startsWith("/"))
        throw new Error("Worker directory must be absolute");
      directory = input.cwd;
      let model;
      if (input.model !== undefined) {
        const split = input.model.indexOf("/");
        if (split < 1 || split === input.model.length - 1) throw new Error("Model must be provider/model");
        model = { providerID: input.model.slice(0, split), id: input.model.slice(split + 1) };
        const models = await context.client.model.list(location(), options());
        alive();
        if (generation !== before) throw new Error("Native route changed during model lookup");
        const found = (models?.data ?? []).find(
          (entry) => entry.providerID === model.providerID && entry.id === model.id,
        );
        if (!found) throw new Error("Selected model/provider is unavailable in this native runtime");
        if (
          input.effort !== undefined &&
          !(Array.isArray(found.variants) && found.variants.some((variant) => variant?.id === input.effort))
        )
          throw new Error("Selected native model does not support this variant");
        if (input.effort !== undefined) model.variant = input.effort;
      } else if (input.effort !== undefined) {
        throw new Error("A native variant requires an explicit model");
      }
      if (input.resumeSessionId !== undefined) throw new Error("OpenCode 2 worker resume is unavailable");
      if (context.ui.router.current()?.type !== "home")
        throw new Error("Fresh native view is not at its initial home");
      // Only the first awaited setup creates a session: the host mounts no
      // route, and so no prompt or draft, until plugin setup settles.
      const created = await context.client.session.create(
        {
          title: input.title,
          location: { directory },
          ...(model === undefined ? {} : { model }),
        },
        options(),
      );
      alive();
      if (generation !== before || context.ui.router.current()?.type !== "home")
        throw new Error("Native route changed while creating the session; no navigation or brief");
      if (!sessionPattern.test(created?.id ?? "")) throw new Error("Native session creation failed");
      sessionId = created.id;
      context.ui.router.navigate({ type: "session", sessionID: sessionId });
      observeRoute();
      if (route() !== sessionId) throw new Error("Created session is not displayed");
      const selectedGeneration = generation;
      const selected = await context.client.session.get({ sessionID: sessionId }, options());
      alive();
      if (
        selected?.id !== sessionId ||
        selected?.location?.directory !== directory ||
        route() !== sessionId ||
        generation !== selectedGeneration
      )
        throw new Error("Native session is not displayed after initialization");
      initialized = true;
      // The server part's projection must be live before any brief: the worker
      // MCP is present and no inherited personal tracker stays enabled.
      const servers = await projection(selectedGeneration);
      if (!servers.some((server) => server?.name === "clankie"))
        throw new Error("Native worker MCP projection is unavailable");
      return { sessionId, version: context.app.version };
    },
    async status() {
      return (await snapshot()).state;
    },
    async refreshToolCatalog() {
      if (sending || refreshing) return { outcome: "skipped-busy", reason: "native-action-pending" };
      refreshing = true;
      try {
        const initial = await snapshot();
        if (initial.state !== "idle" || initial.catalogBusy)
          return { outcome: "skipped-busy", reason: "native-session-busy" };
        await controller.authorize("refreshToolCatalog");
        bound(initial.generation);
        const fresh = await snapshot();
        bound(initial.generation);
        if (fresh.state !== "idle" || fresh.catalogBusy)
          return { outcome: "skipped-busy", reason: "native-session-busy" };
        // Observe the existing connection only; mcp.connect would replace the
        // client under a call that starts during the request.
        const servers = await projection(initial.generation);
        const clankie = servers.find((server) => server?.name === "clankie");
        if (clankie?.status?.status !== "connected")
          return { outcome: "failed", reason: "native-mcp-refresh-unconfirmed" };
        return { outcome: "refreshed", reason: "original-native-clankie-connection-observed" };
      } catch {
        return { outcome: "failed", reason: "original-native-control-unavailable" };
      } finally {
        refreshing = false;
      }
    },
    async settlement(input) {
      if (!messagePattern.test(input?.messageId ?? "")) return { state: "pending" };
      const before = await snapshot();
      if (before.state !== "idle") return { state: "pending" };
      await controller.authorize("history");
      bound(before.generation);
      const result = await context.client.message.list(
        { sessionID: sessionId, order: "desc", limit: 100 },
        options(),
      );
      bound(before.generation);
      if (!Array.isArray(result?.data)) throw new Error("Native completion history unavailable");
      const messages = [...result.data].reverse();
      const start = messages.findIndex((message) => message.id === input.messageId);
      if (start < 0) return { state: "pending" };
      // A turn ends at its idle marker; a steered message joins the running turn.
      const end = messages.findIndex((message, index) => index > start && message.type === "idle");
      if (end < 0) return { state: "pending" };
      const marker = messages[end];
      const ok = marker.outcome === "succeeded";
      return {
        state: "completed",
        ok,
        text: assistantText(messages.slice(start + 1, end)),
        ...(ok ? {} : { stopReason: String(marker.error?.type ?? marker.outcome ?? "native-error") }),
      };
    },
    async send(input) {
      if (sending || refreshing)
        return { outcome: "unavailable", detail: "Another native action is pending" };
      const delivery = input?.delivery ?? "queue";
      if (
        !messagePattern.test(input?.messageId ?? "") ||
        typeof input.text !== "string" ||
        input.text.length === 0 ||
        input.text.length > MAX_TEXT ||
        !["steer", "queue"].includes(delivery)
      )
        throw new Error("Invalid worker message");
      sending = true;
      let claimed = false;
      let attempted = false;
      try {
        const initial = await snapshot();
        if (initial.state === "blocked") return { outcome: "unavailable", detail: initial.state };
        await controller.authorize("send");
        bound(initial.generation);
        const fresh = await snapshot();
        bound(initial.generation);
        if (fresh.state === "blocked") return { outcome: "unavailable", detail: fresh.state };
        await controller.claim({ sessionId, messageId: input.messageId, text: input.text });
        claimed = true;
        bound(initial.generation);
        attempted = true;
        // Durable admission into the session inbox. The client id makes a
        // repeated admission return the original item rather than a second one.
        const item = await context.client.session.prompt(
          { sessionID: sessionId, id: input.messageId, text: input.text, delivery },
          options(),
        );
        bound(initial.generation);
        if (item?.id !== input.messageId || item?.sessionID !== sessionId || item?.delivery !== delivery)
          throw new Error("Native inbox did not acknowledge admission");
        await controller.receipt({ sessionId, messageId: input.messageId, outcome: "accepted" });
        bound(initial.generation);
        return {
          outcome: "accepted",
          messageId: input.messageId,
          state: fresh.state === "working" ? (delivery === "steer" ? "steered" : "queued") : "started",
        };
      } catch (error) {
        if (claimed && !attempted)
          await controller.receipt({ sessionId, messageId: input.messageId, outcome: "not-sent" });
        if (attempted) {
          // Keep the durable claim: a later error may follow server admission.
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
      const result = await context.client.session.interrupt({ sessionID: sessionId }, options());
      bound(initial.generation);
      return result?.interrupted === true;
    },
    async exit() {
      await snapshot();
      await controller.authorize("exit");
      alive();
      // This TUI exits itself; its private server's lease ends with it. No PID
      // signal, terminal input or pane close can reach another occupant.
      context.keymap.dispatch("app.exit");
      return true;
    },
    close() {
      retired = true;
      lifetime.abort();
      stopRoute();
      // Only control ends. No session deletion, permission answer, prompt
      // mutation, or native process/pane shutdown is performed here.
    },
  };
}
