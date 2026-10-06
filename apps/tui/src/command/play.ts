import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost, outputJson, type Writable } from "./io.ts";

const PLAY_USAGE =
  "Usage: clankie play <status|stop>\n       clankie play guide TEXT --conversation CONVERSATION_ID";

export interface PlayCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
}

export async function runPlayCommand(args: readonly string[], options: PlayCommandOptions): Promise<number> {
  const action = args[0];
  if (action !== "status" && action !== "stop" && action !== "guide") throw new Error(PLAY_USAGE);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  const token = credential?.token;
  if (token === undefined) {
    throw new Error("No operator credential is available; start the clankie service once first.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = commandHost({ ...options, env });
  const stdout = options.stdout ?? process.stdout;
  if (action === "guide") {
    if (args.length !== 4 || args[2] !== "--conversation" || !args[1]?.trim() || !args[3])
      throw new Error(PLAY_USAGE);
    const response = await fetchImpl(new URL("/v1/embodiment/sessions/live/guide", base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: args[1], conversationId: args[3] }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error(`clankie service returned ${response.status}: ${await response.text()}`);
    outputJson(stdout, await response.json());
    return 0;
  }
  if (action === "status") {
    const response = await fetchImpl(new URL("/v1/embodiment/sessions/live", base), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`clankie service returned ${String(response.status)}`);
    outputJson(stdout, await response.json());
    return 0;
  }
  const response = await fetchImpl(new URL("/v1/embodiment/sessions/live/stop", base), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) {
    stdout.write("Nothing is playing.\n");
    return 0;
  }
  if (!response.ok) {
    throw new Error(`clankie service returned ${String(response.status)}: ${await response.text()}`);
  }
  outputJson(stdout, await response.json());
  return 0;
}
