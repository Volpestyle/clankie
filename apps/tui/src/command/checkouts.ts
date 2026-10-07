import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";

export async function runCheckoutsCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<unknown> {
  const action = args[0] ?? "status";
  if (action === "decide") return decide(args, options);
  if (
    !["status", "sync", "prune"].includes(action) ||
    (action === "prune"
      ? args.length !== 5 || args[1] !== "--repository" || args[3] !== "--path"
      : (action === "status" ? ![0, 1].includes(args.length) : ![1, 3].includes(args.length)) ||
        (args.length === 3 && args[1] !== "--repository"))
  )
    throw Error(
      `Usage: clankie checkouts status | sync [--repository OWNER_CHECKOUT] | prune --repository OWNER_CHECKOUT --path WORKTREE | ${DECIDE_USAGE}`,
    );
  return request(
    action === "status" ? "" : `/${action}`,
    action === "status"
      ? undefined
      : {
          ...(args[2] ? { repository: args[2] } : {}),
          ...(action === "prune" ? { path: args[4] } : {}),
        },
    options,
  );
}

const DECIDE_USAGE =
  "decide --repository OWNER_CHECKOUT --path WORKTREE --decision worth_landing|safe_to_drop --reason TEXT";
/** Record the lead's judgment of a worktree's unlanded work (VUH-1814). */
function decide(args: readonly string[], options: BrowserCommandOptions): Promise<unknown> {
  const flags = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const [flag, value] = [args[index]!, args[index + 1]];
    if (
      !["--repository", "--path", "--decision", "--reason"].includes(flag) ||
      value === undefined ||
      flags.has(flag)
    )
      throw Error(`Usage: clankie checkouts ${DECIDE_USAGE}`);
    flags.set(flag, value);
  }
  if (flags.size !== 4) throw Error(`Usage: clankie checkouts ${DECIDE_USAGE}`);
  return request(
    "/decide",
    {
      repository: flags.get("--repository"),
      path: flags.get("--path"),
      decision: flags.get("--decision"),
      reason: flags.get("--reason"),
    },
    options,
  );
}

async function request(
  suffix: string,
  body: Record<string, unknown> | undefined,
  options: BrowserCommandOptions,
): Promise<unknown> {
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw Error("Operator credential unavailable");
  const response = await (options.fetchImpl ?? fetch)(
    new URL(`/v1/checkouts${suffix}`, commandHost(options)),
    {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok) throw Error(`Checkout operation refused (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
