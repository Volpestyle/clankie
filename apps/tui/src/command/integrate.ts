import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  IntegrationRequestSchema,
  type HoldOverride,
  type IntegrationRequest,
  type IntegrationResponse,
} from "@clankie/protocol/integrate";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";

const usage =
  "Usage: clankie integrate [run] SHA... [--app SHA]... [--push] [--id UUID] [--no-wait] | status UUID | push UUID | revert PASSED_UUID [--push] | holds | hold --holder NAME --reason TEXT [--pane ID|--seat ID] | release UUID --actor NAME --reason TEXT\nOwner override: --override-hold UUID --actor NAME --reason TEXT (repeat --override-hold for every hold)";

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
    if (
      !["--app", "--id", "--holder", "--reason", "--actor", "--pane", "--seat", "--override-hold"].includes(
        part,
      )
    )
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
  const overrides: HoldOverride[] = (flags.get("--override-hold") ?? []).map((holdId) => {
    if (!actor || !reason) throw Error("A hold override requires --actor and --reason");
    return { holdId, actor, reason };
  });
  const allowed: Record<string, string[]> = {
    run: ["--app", "--id", "--push", "--no-wait", "--override-hold", "--actor", "--reason"],
    revert: ["--id", "--push", "--no-wait", "--override-hold", "--actor", "--reason"],
    status: [],
    push: ["--override-hold", "--actor", "--reason"],
    holds: [],
    hold: ["--id", "--holder", "--reason", "--pane", "--seat"],
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
      overrides,
    };
  } else if (["status", "push", "release"].includes(verb)) {
    if (rest.length !== 1) throw Error(usage);
    input = {
      action: verb,
      id: rest[0],
      ...(verb === "push" ? { overrides } : verb === "release" ? { actor, reason } : {}),
    };
  } else {
    if (rest.length) throw Error(usage);
    input =
      verb === "holds"
        ? { action: "holds" }
        : {
            action: "hold",
            id: one("--id") ?? randomUUID(),
            holder: one("--holder"),
            reason,
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
    ["queued", "composing", "installing", "gating", "pushing"].includes(result.batch.state)
  ) {
    await setTimeout(1_000);
    result = await client.integrate({ action: "status", id: request.id });
  }
  return result;
}
