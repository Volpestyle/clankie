import { randomUUID } from "node:crypto";
import {
  createDefaultCredentialStore,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { RivalsCommandSchema } from "@clankie/protocol";
import { SettingsStore, defaultSettingsPath, GameplaySettingsSchema } from "@clankie/settings";
import { commandHost } from "./io.ts";

const USAGE =
  "Usage: clankie rivals connect URL [--token-stdin] | disconnect | status | start MODE [NOTE] | objective SESSION MODE [NOTE] | observe SESSION | stop SESSION | share SESSION [GUILD CHANNEL]";

export async function runRivalsCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    settings?: SettingsStore;
    stdin?: AsyncIterable<string | Uint8Array>;
  } = {},
): Promise<Record<string, unknown>> {
  const [action = "status", ...rest] = args;
  const env = options.env ?? process.env;
  const settings = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  if (action === "connect" || action === "disconnect") {
    const tokenStdin = action === "connect" && rest.length === 2 && rest[1] === "--token-stdin";
    if (!tokenStdin && rest.length !== (action === "connect" ? 1 : 0)) throw new Error(USAGE);
    if (action === "connect") GameplaySettingsSchema.parse({ rivalsUrl: rest[0] });
    if (tokenStdin) {
      if (options.stdin === undefined && process.stdin.isTTY)
        throw new Error("Pipe the bridge token on stdin; do not type it into a command.");
      let token = "";
      for await (const chunk of options.stdin ?? process.stdin) {
        token += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(chunk);
        if (token.length > 4096) throw new Error("Invalid bridge token");
      }
      token = token.trim();
      if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token)) throw new Error("Invalid bridge token");
      await (options.operatorCredentialStore ?? createDefaultCredentialStore({ env })).set("rivals-agent", {
        type: "api",
        key: token,
      });
    }
    const updated = await settings.update((current) => {
      const { rivalsUrl: _old, ...gameplay } = current.gameplay;
      return {
        ...current,
        gameplay: { ...gameplay, ...(action === "connect" ? { rivalsUrl: rest[0]! } : {}) },
      };
    });
    return {
      outcome: "ok",
      url: updated.gameplay.rivalsUrl ?? null,
      credential: "rivals-agent",
      setup: tokenStdin
        ? "Credential stored. Changes apply live."
        : "Store the matching bridge token with /auth rivals-agent. Changes apply live.",
    };
  }
  let raw: unknown;
  if (action === "status" && rest.length === 0) raw = { action };
  else if (action === "start" && rest.length >= 1) {
    raw = { action, requestId: randomUUID(), objective: { mode: rest[0], note: rest.slice(1).join(" ") } };
  } else if (action === "objective" && rest.length >= 2) {
    raw = { action, sessionId: rest[0], objective: { mode: rest[1], note: rest.slice(2).join(" ") } };
  } else if ((action === "observe" || action === "stop") && rest.length === 1) {
    raw = { action, sessionId: rest[0] };
  } else if (action === "share" && (rest.length === 1 || rest.length === 3)) {
    raw = {
      action,
      sessionId: rest[0],
      ...(rest.length === 3 ? { guildId: rest[1], channelId: rest[2] } : {}),
    };
  } else throw new Error(USAGE);
  const parsed = RivalsCommandSchema.safeParse(raw);
  if (!parsed.success) throw new Error(USAGE);
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential)
    throw new Error("No operator credential is available; start the clankie service once first.");
  const response = await (options.fetchImpl ?? fetch)(
    new URL("/v1/rivals", commandHost({ ...options, env })),
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`clankie service returned ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}
