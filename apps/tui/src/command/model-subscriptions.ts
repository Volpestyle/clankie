import { parseArgs } from "node:util";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  MODEL_SUBSCRIPTIONS_PATH,
  MODEL_SUBSCRIPTION_METHODS_PATH,
  MODEL_SUBSCRIPTION_START_PATH,
  MODEL_SUBSCRIPTION_STATUS_PATH,
  MODEL_SUBSCRIPTION_CANCEL_PATH,
  ModelSubscriptionsResponseSchema,
  ModelSubscriptionMethodsSchema,
  ModelSubscriptionStartSchema,
  ModelSubscriptionSessionRequestSchema,
  ModelSubscriptionResultSchema,
  type ModelSubscriptionsResponse,
  type ModelSubscriptionMethods,
  type ModelSubscriptionResult,
} from "@clankie/protocol/model-keys";
import { commandHost } from "./io.ts";

const USAGE = [
  "Usage: clankie model subscriptions [list|methods]",
  "       clankie model subscriptions start PROVIDER --method browser|device --model PROVIDER/MODEL",
  "       clankie model subscriptions status|cancel SESSION_UUID",
].join("\n");
export type ModelSubscriptionsCommandResult =
  | ({ readonly ok: true } & ModelSubscriptionsResponse)
  | ({ readonly ok: true } & ModelSubscriptionMethods)
  | ModelSubscriptionResult;

/** Use the running service's jobs, broker and model selection; never retry a sign-in start. */
export async function runModelSubscriptionsCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly operatorCredentialStore?: CredentialStore;
  } = {},
): Promise<ModelSubscriptionsCommandResult> {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { method: { type: "string" }, model: { type: "string" } },
  });
  const [action = "list", target] = positionals;
  let path: string;
  let body: unknown;
  if (
    ["list", "methods"].includes(action) &&
    positionals.length <= 1 &&
    values.method === undefined &&
    values.model === undefined
  ) {
    path = action === "list" ? MODEL_SUBSCRIPTIONS_PATH : MODEL_SUBSCRIPTION_METHODS_PATH;
  } else if (action === "start" && positionals.length === 2) {
    const parsed = ModelSubscriptionStartSchema.safeParse({
      providerId: target,
      method: values.method,
      model: values.model,
    });
    if (!parsed.success) throw new Error(USAGE);
    path = MODEL_SUBSCRIPTION_START_PATH;
    body = parsed.data;
  } else if (
    ["status", "cancel"].includes(action) &&
    positionals.length === 2 &&
    values.method === undefined &&
    values.model === undefined
  ) {
    const parsed = ModelSubscriptionSessionRequestSchema.safeParse({ sessionId: target });
    if (!parsed.success) throw new Error(USAGE);
    path = action === "status" ? MODEL_SUBSCRIPTION_STATUS_PATH : MODEL_SUBSCRIPTION_CANCEL_PATH;
    body = parsed.data;
  } else throw new Error(USAGE);
  try {
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
    });
    if (!credential) return { ok: false, error: "authentication_required" };
    const response = await (options.fetchImpl ?? fetch)(new URL(path, commandHost({ ...options, env })), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const value: unknown = await response.json();
    if (response.ok && action === "list")
      return { ok: true, ...ModelSubscriptionsResponseSchema.parse(value) };
    if (response.ok && action === "methods")
      return { ok: true, ...ModelSubscriptionMethodsSchema.parse(value) };
    const parsed = ModelSubscriptionResultSchema.safeParse(value);
    if (parsed.success && (response.ok || !parsed.data.ok)) return parsed.data;
    return { ok: false, error: "unavailable" };
  } catch {
    // Upstream errors can echo tokens or login interactions; return a fixed code.
    return { ok: false, error: "unavailable" };
  }
}
