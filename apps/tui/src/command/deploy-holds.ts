import { randomUUID } from "node:crypto";
import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  DEPLOY_HOLD_MAX_MINUTES,
  DeployHoldRequestSchema,
  type DeployHoldResponse,
} from "@clankie/protocol/deploy-holds";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";

export const DEPLOY_HOLDS_USAGE = `Usage: clankie update holds | hold --holder NAME --reason TEXT --minutes 1-${DEPLOY_HOLD_MAX_MINUTES} [--id UUID] [--pane ID|--seat ID] | release UUID --actor NAME --reason TEXT
A hold keeps deploys off the running service and lifts on its own when its minutes run out; merging to main never waits for one.`;

function deployHoldRequest(args: readonly string[]) {
  const [verb, ...rest] = args;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const part = rest[i]!;
    if (!part.startsWith("--")) {
      positional.push(part);
      continue;
    }
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw Error(DEPLOY_HOLDS_USAGE);
    flags.set(part, value);
  }
  const allowed: Record<string, string[]> = {
    holds: [],
    hold: ["--id", "--holder", "--reason", "--minutes", "--pane", "--seat"],
    release: ["--actor", "--reason"],
  };
  if (
    !verb ||
    !allowed[verb] ||
    [...flags.keys()].some((flag) => !allowed[verb]!.includes(flag)) ||
    positional.length !== (verb === "release" ? 1 : 0)
  )
    throw Error(DEPLOY_HOLDS_USAGE);
  if (verb === "holds") return DeployHoldRequestSchema.parse({ action: "list" });
  if (verb === "release")
    return DeployHoldRequestSchema.parse({
      action: "release",
      id: positional[0],
      actor: flags.get("--actor"),
      reason: flags.get("--reason"),
    });
  const minutes = Number(flags.get("--minutes"));
  if (!(Number.isInteger(minutes) && minutes >= 1 && minutes <= DEPLOY_HOLD_MAX_MINUTES))
    throw Error(
      `A hold needs --minutes from 1 to ${DEPLOY_HOLD_MAX_MINUTES}; it lifts on its own when they run out.`,
    );
  return DeployHoldRequestSchema.parse({
    action: "hold",
    id: flags.get("--id") ?? randomUUID(),
    holder: flags.get("--holder"),
    reason: flags.get("--reason"),
    minutes,
    ...(flags.has("--pane") ? { pane: flags.get("--pane") } : {}),
    ...(flags.has("--seat") ? { seat: flags.get("--seat") } : {}),
  });
}

/** One owner request, no retry; a lost hold response is reconciled with `clankie update holds`. */
export async function runDeployHoldsCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<DeployHoldResponse> {
  const request = deployHoldRequest(args);
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw Error("No operator credential is available");
  return new ClankieApiClient({
    baseUrl: commandHost(options),
    operatorToken: credential.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }).deployHolds(request);
}
