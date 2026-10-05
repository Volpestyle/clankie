import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";
import { HoldOverrideSchema } from "@clankie/protocol/integrate";

export async function runUpdateCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<unknown> {
  const status = args.length === 1 && args[0] === "status";
  let ref = "main";
  const holdIds: string[] = [];
  let actor: string | undefined, reason: string | undefined;
  if (!status) {
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i],
        value = args[i + 1];
      if (
        !value ||
        value.startsWith("-") ||
        !["--ref", "--override-hold", "--actor", "--reason"].includes(key ?? "")
      )
        throw Error(
          "Usage: clankie update [--ref REF] [--override-hold UUID --actor NAME --reason TEXT] | status",
        );
      if (key === "--ref") ref = value;
      else if (key === "--override-hold") holdIds.push(value);
      else if (key === "--actor") actor = value;
      else reason = value;
    }
  }
  if ((actor || reason) && !holdIds.length) throw Error("--actor and --reason require --override-hold");
  const overrides = holdIds.map((holdId) => HoldOverrideSchema.parse({ holdId, actor, reason }));
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
    ...(status ? {} : { body: JSON.stringify({ ref, ...(overrides.length ? { overrides } : {}) }) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result: unknown = await response.json();
  if (!response.ok && response.status !== 409)
    throw Error(`Runtime update unavailable (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
