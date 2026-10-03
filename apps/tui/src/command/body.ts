import { resolveOperatorCredential } from "@clankie/credential-broker";
import { BodyLeaseRequestSchema } from "@clankie/protocol";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";

/** JSON request uses the same strict discriminated contract as the authenticated API. */
export async function runBodyCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<unknown> {
  const status = args.length === 0 || (args.length === 1 && args[0] === "status");
  if (!status && (args.length !== 2 || args[0] !== "request"))
    throw new Error(
      "Usage: clankie body status | request JSON (action, resource, conversationId and action-specific fields)",
    );
  const request = status ? undefined : BodyLeaseRequestSchema.parse(JSON.parse(args[1]!));
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential?.token) throw new Error("No operator credential is available");
  const response = await (options.fetchImpl ?? fetch)(
    new URL("/v1/body-leases", commandHost({ ...options, env })),
    {
      method: status ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(request === undefined ? {} : { body: JSON.stringify(request) }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok && response.status !== 409)
    throw new Error(`Body lease request failed (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
