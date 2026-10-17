import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";
import { HoldOverrideSchema } from "@clankie/protocol/integrate";
import { HOST_SETTINGS_PATH, HostSettingsSnapshotSchema } from "@clankie/protocol/owner-settings";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";
import {
  SCHEDULED_RELEASE_CUTOVER_PATH,
  ScheduledReleaseCutoverRequestSchema,
} from "@clankie/protocol/body-release";

const AUTO_USAGE = "Usage: clankie update auto [status|on|off]";

export const UPDATE_USAGE =
  "Usage: clankie update [now] [--ref REF] [--override-holds --reason TEXT] [--json]\n       clankie update status|cancel [--json]\n       clankie update canary [--window-seconds N] [--sample-seconds N] [--cpu-percent N] [--health-ms N] [--json]\n       clankie update auto [status|on|off] [--json]\nTerminal output explains holds and update progress; --json or piped output stays structured.\nVerified superseded canary holds release after a full passing replacement canary; independent holds remain blocking until explicitly released or overridden. Owner overrides are audited per hold. Legacy --override-hold UUID [--actor NAME] --reason TEXT is also accepted; the server records the authenticated owner.\nUse status after acceptance or a disconnect. Do not resend an uncertain update or restart services. A recorded pre-cutover failure may retry, subject to holds.\nA source checkout batches updates that follow main: while the body is busy and the service has run under two hours (CLANKIE_UPDATE_BATCH_MINUTES), the request is deferred and the newest main applies once the body is idle or the batch is due. `now` applies at once; `cancel` drops a deferred batch. An explicit --ref or a hold override always applies at once.";

export function parseUpdateArgs(args: readonly string[]) {
  args = args.filter((arg) => arg !== "--json");
  const now = args[0] === "now";
  if (now) args = args.slice(1);
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
  if (now && (status || canary)) throw Error(UPDATE_USAGE);
  return { canary, status, policy, ref, overrides, overrideHolds, reason, now };
}

export async function runUpdateCommand(
  args: readonly string[],
  options: BrowserCommandOptions & OwnerSettingsApiOptions & { previewRef?: string } = {},
): Promise<unknown> {
  args = args.filter((arg) => arg !== "--json");
  // Scheduled idle installs on a hosted body (ADR 0237); a managed body always takes them.
  if (args[0] === "auto") {
    const verb = args[1] ?? "status";
    if (
      (args.length > 2 && !(args.length === 4 && args[2] === "--expected-revision")) ||
      !["status", "on", "off"].includes(verb)
    )
      throw Error(AUTO_USAGE);
    const api = await ownerSettingsApi(options);
    const state = await api.get(HOST_SETTINGS_PATH, HostSettingsSnapshotSchema);
    const revisionArg = args.indexOf("--expected-revision");
    const expectedRevision = revisionArg === -1 ? state.revision : args[revisionArg + 1];
    const updated =
      verb === "status"
        ? state
        : await api.write(
            HOST_SETTINGS_PATH,
            {
              schemaVersion: 1,
              expectedRevision,
              changes: { autoUpdate: verb === "on" },
            },
            HostSettingsSnapshotSchema,
          );
    return {
      autoUpdate: updated.host.autoUpdate,
      revision: updated.revision,
      managed: updated.autoUpdateManaged,
      effective: updated.autoUpdateEffective,
    };
  }
  if (args[0] === "cancel") {
    if (args.length !== 1) throw Error(UPDATE_USAGE);
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (!credential?.token) throw Error("No operator credential is available");
    const response = await (options.fetchImpl ?? fetch)(
      new URL("/v1/runtime-update/deferred", commandHost(options)),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${credential.token}`, "x-clankie-client": "cli" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    // allow-swallowed-rejection -- an unreadable body still reports its HTTP status below
    const result = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok)
      throw Error(`Batched update cancel unavailable (${response.status}): ${JSON.stringify(result)}`);
    return result;
  }
  let cutover: { operationId: string; instanceId: string } | undefined;
  if (args[0] === "cutover") {
    if (args.length !== 5 || args[1] !== "--operation" || args[3] !== "--instance")
      throw Error("Usage: clankie update cutover --operation UUID --instance UUID");
    cutover = ScheduledReleaseCutoverRequestSchema.parse({ operationId: args[2], instanceId: args[4] });
  }
  const { canary, status, policy, ref, overrides, overrideHolds, reason, now } = parseUpdateArgs(
    cutover ? [] : args,
  );
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
        cutover
          ? SCHEDULED_RELEASE_CUTOVER_PATH
          : canary
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
                cutover ??
                  (canary
                    ? policy
                    : {
                        ref,
                        ...(overrides.length ? { overrides } : {}),
                        ...(overrideHolds ? { overrideHolds, reason } : {}),
                        ...(now ? { now } : {}),
                      }),
              ),
            }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    if (status) return { error: "update_status_unavailable", needsReconciliation: true };
    throw Error(
      `Update result is uncertain. Reconnect and run clankie update status; do not resend the update or restart services. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return { error: "update_response_unreadable", status: response.status, needsReconciliation: true };
  }
  if (response.status === 503 && (result as { error?: string })?.error === "service_shutting_down")
    return { error: "service_shutting_down", needsReconciliation: true };
  if (status && !response.ok)
    return { error: "update_status_unavailable", status: response.status, result, needsReconciliation: true };
  if (!response.ok && response.status !== 409)
    throw Error(`Runtime update unavailable (${response.status}): ${JSON.stringify(result)}`);
  return result;
}
