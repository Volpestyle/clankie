import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";
import { HoldOverrideSchema } from "@clankie/protocol/integrate";

export async function runUpdateCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<unknown> {
  const canary = args[0] === "canary";
  const status = args.length === 1 && args[0] === "status";
  const policy: Record<string, number> = {};
  if (canary) {
    const fields: Record<string, { key: string; scale: number }> = {
      "--window-seconds": { key: "windowMs", scale: 1000 },
      "--sample-seconds": { key: "sampleIntervalMs", scale: 1000 },
      "--cpu-percent": { key: "cpuPercent", scale: 1 },
      "--health-ms": { key: "healthLatencyMs", scale: 1 },
    };
    for (let i = 1; i < args.length; i += 2) {
      const field = fields[args[i] ?? ""];
      const value = Number(args[i + 1]);
      if (!field || !Number.isFinite(value) || value <= 0 || field.key in policy)
        throw Error(
          "Usage: clankie update canary [--window-seconds N] [--sample-seconds N] [--cpu-percent N] [--health-ms N]",
        );
      policy[field.key] = value * field.scale;
    }
  }
  let ref = "main";
  const holdIds: string[] = [];
  let actor: string | undefined, reason: string | undefined;
  if (!status && !canary) {
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i],
        value = args[i + 1];
      if (
        !value ||
        value.startsWith("-") ||
        !["--ref", "--override-hold", "--actor", "--reason"].includes(key ?? "")
      )
        throw Error(
          "Usage: clankie update [--ref REF] [--override-hold UUID --actor NAME --reason TEXT] | status | canary",
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
  const read = status || (canary && Object.keys(policy).length === 0);
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.token}`,
    "content-type": "application/json",
    "x-clankie-client": "cli",
  };
  if (env.CLANKIE_CONVERSATION_ID) headers["x-clankie-update-conversation"] = env.CLANKIE_CONVERSATION_ID;
  if (env.CLANKIE_SEAT_SESSION_ID) headers["x-clankie-update-seat-session"] = env.CLANKIE_SEAT_SESSION_ID;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      new URL(canary ? "/v1/runtime-update/canary" : "/v1/runtime-update", commandHost(options)),
      {
        method: read ? "GET" : canary ? "PUT" : "POST",
        headers,
        ...(read
          ? {}
          : { body: JSON.stringify(canary ? policy : { ref, ...(overrides.length ? { overrides } : {}) }) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    if (status) return { error: "update_status_unavailable", needsReconciliation: true };
    throw error;
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return { error: "update_response_unreadable", status: response.status, needsReconciliation: true };
  }
  if (status && !response.ok) return { error: "update_status_unavailable", status: response.status, result };
  if (!response.ok && response.status !== 409)
    throw Error(`Runtime update unavailable (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
