import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost, outputJson, type Writable } from "./io.ts";

const PLAY_USAGE = "Usage: clankie play <status|stop>";

export interface PlayCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
}

export async function runPlayCommand(args: readonly string[], options: PlayCommandOptions): Promise<number> {
  const action = args[0];
  if (action !== "status" && action !== "stop") throw new Error(PLAY_USAGE);
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
