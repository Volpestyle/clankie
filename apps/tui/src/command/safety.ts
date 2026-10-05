import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  SAFETY_PATH,
  SAFETY_APPROVALS_PATH,
  SafetyApprovalAnswerSchema,
  SafetyApprovalsSchema,
  SafetyStatusSchema,
  SafetyUpdateSchema,
} from "@clankie/protocol";
import { SafetySettingsSchema, workSafetySettings } from "@clankie/settings";
import type { BrowserCommandOptions } from "./browser.ts";
import { commandHost } from "./io.ts";

const USAGE =
  "Usage: clankie safety [status] | preset work|default | set JSON | approvals | approve|reject ID FINGERPRINT";

export function safetyCommandRequest(args: readonly string[]): { path: string; body?: unknown } {
  const verb = args[0] ?? "status";
  let path = SAFETY_PATH;
  let body: unknown;
  if (verb === "status" && args.length <= 1) {
    body = undefined;
  } else if (verb === "preset" && args.length === 2 && ["work", "default"].includes(args[1]!)) {
    body = args[1] === "work" ? workSafetySettings() : SafetySettingsSchema.parse({});
  } else if (verb === "set" && args.length === 2) {
    body = SafetyUpdateSchema.parse(JSON.parse(args[1]!));
  } else if (verb === "approvals" && args.length === 1) {
    path = SAFETY_APPROVALS_PATH;
  } else if (["approve", "reject"].includes(verb) && args.length === 3) {
    path = SAFETY_APPROVALS_PATH;
    body = SafetyApprovalAnswerSchema.parse({
      id: args[1],
      fingerprint: args[2],
      approve: verb === "approve",
    });
  } else throw new Error(USAGE);
  return { path, ...(body === undefined ? {} : { body }) };
}

export async function runSafetyCommand(args: readonly string[], options: BrowserCommandOptions = {}) {
  const { path, body } = safetyCommandRequest(args);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential?.token)
    throw new Error("Owner operator credential required for safety settings and approvals");
  const response = await (options.fetchImpl ?? fetch)(new URL(path, commandHost({ ...options, env })), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(`Safety request failed (${response.status}): ${JSON.stringify(result)}`);
  return path === SAFETY_PATH
    ? SafetyStatusSchema.parse(result)
    : args[0] === "approvals"
      ? SafetyApprovalsSchema.parse(result)
      : result;
}
