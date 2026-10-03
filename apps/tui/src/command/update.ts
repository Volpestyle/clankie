import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";

export async function runUpdateCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<unknown> {
  const status = args.length === 1 && args[0] === "status";
  let ref = "main";
  if (!status && args.length !== 0) {
    if (args.length !== 2 || args[0] !== "--ref" || !args[1] || args[1].startsWith("-"))
      throw Error("Usage: clankie update [--ref REF] | status");
    ref = args[1];
  }
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential?.token) throw Error("No operator credential is available");
  // No retry: a lost response may have accepted the durable operation. Read status instead.
  const response = await (options.fetchImpl ?? fetch)(new URL("/v1/runtime-update", commandHost(options)), {
    method: status ? "GET" : "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    ...(status ? {} : { body: JSON.stringify({ ref }) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result: unknown = await response.json();
  if (!response.ok && response.status !== 409)
    throw Error(`Runtime update unavailable (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
