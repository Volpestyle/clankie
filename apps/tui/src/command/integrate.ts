import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  DEPLOY_HOLD_MAX_MINUTES,
  IntegrationRequestSchema,
  type IntegrationRequest,
  type IntegrationResponse,
} from "@clankie/protocol/integrate";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";

const usage = `Usage: clankie integrate [run] SHA... [--app SHA]... [--push] [--id UUID] [--no-wait] | status [UUID] | push UUID | revert PASSED_UUID [--push] | holds | hold --holder NAME --reason TEXT --minutes 1-${DEPLOY_HOLD_MAX_MINUTES} [--pane ID|--seat ID] | release UUID --actor NAME --reason TEXT
A hold keeps deploys off the running service and lifts on its own when its minutes run out; landing on main never waits for one.`;

function integrationRequest(args: readonly string[]): { request: IntegrationRequest; wait: boolean } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const part = args[i]!;
    if (!part.startsWith("--")) {
      positional.push(part);
      continue;
    }
    if (["--push", "--no-wait"].includes(part)) {
      flags.set(part, ["true"]);
      continue;
    }
    if (!["--app", "--id", "--holder", "--reason", "--actor", "--pane", "--seat", "--minutes"].includes(part))
      throw Error(usage);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error(usage);
    flags.set(part, [...(flags.get(part) ?? []), value]);
  }
  const one = (key: string) => flags.get(key)?.at(-1);
  let [verb = "run", ...rest] = positional;
  if (/^[a-f0-9]{7,64}$/u.test(verb)) {
    rest = [verb, ...rest];
    verb = "run";
  }
  const actor = one("--actor"),
    reason = one("--reason");
  const allowed: Record<string, string[]> = {
    run: ["--app", "--id", "--push", "--no-wait"],
    revert: ["--id", "--push", "--no-wait"],
    status: [],
    push: [],
    holds: [],
    hold: ["--id", "--holder", "--reason", "--minutes", "--pane", "--seat"],
    release: ["--actor", "--reason"],
  };
  if (!allowed[verb] || [...flags.keys()].some((flag) => !allowed[verb]!.includes(flag))) throw Error(usage);
  let input: unknown;
  if (verb === "run" || verb === "revert") {
    if (verb === "revert" && rest.length !== 1) throw Error(usage);
    input = {
      action: "run",
      id: one("--id") ?? randomUUID(),
      core: verb === "run" ? rest : [],
      ...(verb === "revert" ? { restore: rest[0] } : flags.has("--app") ? { app: flags.get("--app") } : {}),
      push: flags.has("--push"),
    };
  } else if (["status", "push", "release"].includes(verb)) {
    if (verb === "status" ? rest.length > 1 : rest.length !== 1) throw Error(usage);
    input = {
      action: verb,
      ...(rest[0] ? { id: rest[0] } : {}),
      ...(verb === "release" ? { actor, reason } : {}),
    };
  } else {
    if (rest.length) throw Error(usage);
    const minutes = Number(one("--minutes"));
    if (verb === "hold" && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= DEPLOY_HOLD_MAX_MINUTES))
      throw Error(
        `A hold needs --minutes from 1 to ${DEPLOY_HOLD_MAX_MINUTES}; it lifts on its own when they run out.`,
      );
    input =
      verb === "holds"
        ? { action: "holds" }
        : {
            action: "hold",
            id: one("--id") ?? randomUUID(),
            holder: one("--holder"),
            reason,
            minutes,
            ...(one("--pane") ? { pane: one("--pane") } : {}),
            ...(one("--seat") ? { seat: one("--seat") } : {}),
          };
  }
  return { request: IntegrationRequestSchema.parse(input), wait: !flags.has("--no-wait") };
}

export async function runIntegrationCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<IntegrationResponse> {
  const { request, wait } = integrationRequest(args);
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw Error("No operator credential is available");
  const client = new ClankieApiClient({
    baseUrl: commandHost(options),
    operatorToken: credential.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  // One mutation, no retry; a lost response is reconciled with the printed request ID.
  if (request.action === "run")
    process.stderr.write(
      `Integration batch ${request.id}; reconcile with clankie integrate status ${request.id}\n`,
    );
  let result = await client.integrate(request);
  while (
    wait &&
    request.action === "run" &&
    result.batch &&
    ["queued", "composing", "installing", "gating", "isolating", "pushing"].includes(result.batch.state)
  ) {
    await setTimeout(1_000);
    result = await client.integrate({ action: "status", id: request.id });
  }
  return result;
}
