import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";

export async function runCheckoutsCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<unknown> {
  const action = args[0] ?? "status";
  if (
    !["status", "sync", "prune"].includes(action) ||
    (action === "prune"
      ? args.length !== 5 || args[1] !== "--repository" || args[3] !== "--path"
      : (action === "status" ? ![0, 1].includes(args.length) : ![1, 3].includes(args.length)) ||
        (args.length === 3 && args[1] !== "--repository"))
  )
    throw Error(
      "Usage: clankie checkouts status | sync [--repository OWNER_CHECKOUT] | prune --repository OWNER_CHECKOUT --path WORKTREE",
    );
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw Error("Operator credential unavailable");
  const response = await (options.fetchImpl ?? fetch)(
    new URL(`/v1/checkouts${action === "status" ? "" : `/${action}`}`, commandHost(options)),
    {
      method: action === "status" ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(action === "status"
        ? {}
        : {
            body: JSON.stringify({
              ...(args[2] ? { repository: args[2] } : {}),
              ...(action === "prune" ? { path: args[4] } : {}),
            }),
          }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok) throw Error(`Checkout operation refused (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
