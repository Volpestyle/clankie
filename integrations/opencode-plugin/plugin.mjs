import { deliverNativeEvent, loadNativeContext, projectMessages } from "./runtime.mjs";

export default async function ClankieSeat({ client }) {
  const address = process.env.CLANKIE_OPENCODE_BRIDGE;
  const token = process.env.CLANKIE_OPENCODE_BRIDGE_TOKEN;
  if (!address || !token) return {};
  const url = new URL(address);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error("Invalid Clankie seat bridge");
  const stop = new AbortController();
  let sessionId = process.env.CLANKIE_OPENCODE_SESSION;
  let ready = false;
  let switched = false;
  let failed = false;
  let preparation;
  let permission = false;
  const notices = new Set();
  const notify = async (message) => {
    if (notices.has(message)) return;
    notices.add(message);
    await client.tui
      .showToast({ body: { title: "Clankie seat", message, variant: "warning", duration: 7000 } })
      .catch(() => {});
  };
  const bridge = async (action, body = {}) => {
    const response = await fetch(new URL(`/${action}`, url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error(`Clankie ${action} failed (${response.status}); no terminal fallback`);
    return response.json();
  };
  const fail = async (error) => {
    failed = true;
    ready = false;
    await bridge("failure", { sessionId, detail: String(error) }).catch(() => {});
  };
  const assertActive = () => {
    if (failed || switched || stop.signal.aborted) throw new Error("Clankie seat delivery stopped");
  };
  const bind = async (id) => {
    assertActive();
    if (sessionId && id !== sessionId) {
      switched = true;
      const error = new Error("session_switched: restart the seat to resume its exact session");
      await fail(error);
      throw error;
    }
    if (!sessionId) sessionId = id;
    if (ready) return;
    preparation ??= (async () => {
      await loadNativeContext(client, sessionId, bridge, stop.signal);
      assertActive();
      await bridge("ready", { sessionId });
      assertActive();
      ready = true;
    })().catch(async (error) => {
      await fail(error);
      throw error;
    });
    await preparation;
  };
  // A resumed session is known before any owner prompt. Defer until plugin
  // initialization returns, then arm it without issuing a bootstrap turn.
  const startup = sessionId
    ? setTimeout(() => {
        void bind(sessionId).catch(() => notify("Native context preflight failed; delivery stopped."));
      }, 0)
    : undefined;
  let syncChain = Promise.resolve();
  let syncTimer;
  let latestActivity;
  const sync = (nextActivity) => {
    latestActivity = nextActivity ?? latestActivity;
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      const activity = latestActivity;
      latestActivity = undefined;
      syncChain = syncChain
        .then(async () => {
          if (!sessionId || switched) return;
          const messages = await client.session.messages({ path: { id: sessionId }, throwOnError: true });
          const entries = projectMessages(sessionId, messages.data ?? []);
          for (let index = 0; index < entries.length || index === 0; index += 100)
            await bridge("transcript", { sessionId, entries: entries.slice(index, index + 100), activity });
        })
        .catch(async (error) => {
          await bridge("warning", { sessionId, detail: `transcript_failed: ${String(error)}` }).catch(
            () => {},
          );
          await notify("Transcript sync unavailable; native messages are retained. See the launch journal.");
        });
    }, 200);
  };
  // Start after native plugin initialization; no model call or session creation.
  const poll = async () => {
    while (!stop.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (stop.signal.aborted) return;
      if (!sessionId || !ready || switched || failed || permission) continue;
      try {
        const next = await bridge("poll", { sessionId });
        if (!next.event || !ready || switched || failed || permission) continue;
        const result = await deliverNativeEvent(client, sessionId, next.event, bridge, stop.signal);
        if (result.status === "busy") await bridge("status", { sessionId, ...result });
      } catch (error) {
        await fail(error);
        await notify("Delivery stopped; inspect the launch journal before retrying.");
      }
    }
  };
  void poll();
  return {
    dispose: async () => {
      stop.abort();
      clearTimeout(syncTimer);
      clearTimeout(startup);
    },
    config: async (config) => {
      // Runtime projection only: inherited connections cannot bypass the seat's
      // broker authorization. Never write the owner's OpenCode config.
      for (const [name, server] of Object.entries(config.mcp ?? {})) {
        if (
          /linear/iu.test(name) ||
          /(?:^|\.)linear\.app(?:[/:]|$)/iu.test(String(server.url ?? "").replace(/^https?:\/\//u, ""))
        )
          config.mcp[name] = { enabled: false };
      }
      config.mcp ??= {};
      config.mcp.clankie = {
        type: "local",
        command: ["clankie", "mcp", "--lane", "operator"],
        enabled: true,
      };
    },
    "chat.message": async (input) => {
      await bind(input.sessionID);
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      await bind(input.sessionID);
      try {
        // Every real turn, including a native wake, gets fresh identity/memory;
        // the startup preflight is never cached as the model's system prompt.
        const text = await loadNativeContext(client, sessionId, bridge, stop.signal);
        assertActive();
        output.system.push(text);
      } catch (error) {
        await fail(error);
        throw error;
      }
    },
    event: async ({ event }) => {
      const props = event.properties;
      const id = props?.sessionID ?? props?.info?.sessionID ?? props?.part?.sessionID;
      if (event.type === "session.created" && props?.info && !props.info.parentID) {
        await bind(props.info.id);
      }
      if (id !== sessionId || switched) return;
      if (event.type === "permission.asked") permission = true;
      if (event.type === "permission.replied") permission = false;
      if (event.type === "session.idle") sync("waiting");
      if (event.type === "session.status") sync(props.status.type === "idle" ? "waiting" : "responding");
      if (["message.updated", "message.part.updated"].includes(event.type)) sync(undefined);
      if (["session.error", "session.deleted"].includes(event.type)) {
        await fail(new Error(event.type));
      }
    },
  };
}
