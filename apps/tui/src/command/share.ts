import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

/** Local owner control. Viewer credentials are separate, read-only and short-lived. */
export async function runShareCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  } = {},
): Promise<{ ok: boolean; body: unknown }> {
  let request: unknown;
  if (args.length === 0 || (args.length === 1 && args[0] === "list")) request = { action: "list" };
  else if (args[0] === "request" && args.length === 2) request = JSON.parse(args[1]!);
  else throw new Error("Usage: clankie share [list | request JSON]");
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) throw new Error("Sharing needs the operator credential. Run clankie doctor.");
  const response = await (options.fetchImpl ?? fetch)(
    `${commandHost({ ...options, env })}/v1/activity/shares`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    },
  );
  return { ok: response.ok, body: await response.json() };
}
