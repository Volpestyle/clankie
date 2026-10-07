import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";
import { HoldOverrideSchema } from "@clankie/protocol/integrate";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";

const AUTO_USAGE = "Usage: clankie update auto [status|on|off]";

export const UPDATE_USAGE =
  "Usage: clankie update [--ref REF] [--override-holds --reason TEXT] [--json]\n       clankie update status [--json]\n       clankie update canary [--window-seconds N] [--sample-seconds N] [--cpu-percent N] [--health-ms N] [--json]\n       clankie update auto [status|on|off] [--json]\nOwner overrides are audited per hold. Legacy --override-hold UUID [--actor NAME] --reason TEXT is also accepted; the server records the authenticated owner.";

export function parseUpdateArgs(args: readonly string[]) {
  args = args.filter((arg) => arg !== "--json");
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
  let overrideHolds = false;
  if (!status && !canary) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--override-holds" && !overrideHolds) {
        overrideHolds = true;
        continue;
      }
      const key = args[i],
        value = args[++i];
      if (
        !value ||
        value.startsWith("-") ||
        !["--ref", "--override-hold", "--actor", "--reason"].includes(key ?? "")
      )
        throw Error(UPDATE_USAGE);
      if (key === "--ref") ref = value;
      else if (key === "--override-hold") holdIds.push(value);
      else if (key === "--actor") actor = value;
      else reason = value;
    }
  }
  if (overrideHolds && (holdIds.length || actor)) throw Error(UPDATE_USAGE);
  if (overrideHolds && !reason?.trim()) throw Error("--override-holds requires --reason TEXT");
  if ((actor || reason) && !holdIds.length && !overrideHolds)
    throw Error("--actor and --reason require a hold override");
  const overrides = holdIds.map((holdId) =>
    HoldOverrideSchema.parse({ holdId, actor: actor ?? "authenticated-owner", reason }),
  );
  if (overrideHolds) HoldOverrideSchema.shape.reason.parse(reason);
  return { canary, status, policy, ref, overrides, overrideHolds, reason };
}

export async function runUpdateCommand(
  args: readonly string[],
  options: BrowserCommandOptions & { previewRef?: string } = {},
): Promise<unknown> {
  args = args.filter((arg) => arg !== "--json");
  // Scheduled idle installs on a hosted body (ADR 0237); a managed body always takes them.
  if (args[0] === "auto") {
    const verb = args[1] ?? "status";
    if (args.length > 2 || !["status", "on", "off"].includes(verb)) throw Error(AUTO_USAGE);
    const store = new SettingsStore(defaultSettingsPath(options.env ?? process.env));
    if (verb !== "status")
      await store.update((current) => ({ ...current, host: { ...current.host, autoUpdate: verb === "on" } }));
    return { autoUpdate: (await store.load()).host.autoUpdate };
  }
  const { canary, status, policy, ref, overrides, overrideHolds, reason } = parseUpdateArgs(args);
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
      new URL(
        canary
          ? "/v1/runtime-update/canary"
          : `/v1/runtime-update${read && options.previewRef ? `?ref=${encodeURIComponent(options.previewRef)}` : ""}`,
        commandHost(options),
      ),
      {
        method: read ? "GET" : canary ? "PUT" : "POST",
        headers,
        ...(read
          ? {}
          : {
              body: JSON.stringify(
                canary
                  ? policy
                  : {
                      ref,
                      ...(overrides.length ? { overrides } : {}),
                      ...(overrideHolds ? { overrideHolds, reason } : {}),
                    },
              ),
            }),
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
