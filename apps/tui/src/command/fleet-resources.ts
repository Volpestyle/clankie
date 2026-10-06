import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  FLEET_RESOURCES_PATH,
  FLEET_SIMULATORS_PATH,
  FleetResourceSnapshotSchema,
  FleetSimulatorRequestSchema,
  FleetSimulatorResultSchema,
  FleetSimulatorStatusSchema,
} from "@clankie/protocol";
import type { BrowserCommandOptions } from "./browser.ts";
import { commandHost } from "./io.ts";

async function request(path: string, body: unknown, options: BrowserCommandOptions): Promise<unknown> {
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential?.token) throw new Error("No operator credential is available");
  const response = await (options.fetchImpl ?? fetch)(new URL(path, commandHost({ ...options, env })), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(body === undefined ? 5_000 : 120_000),
  });
  if (!response.ok && response.status !== 409)
    throw new Error(`Fleet resource request failed (HTTP ${response.status})`);
  return await response.json().catch(() => {
    throw new Error("Fleet resource response is invalid");
  });
}

export async function runResourceStatusCommand(options: BrowserCommandOptions = {}) {
  return FleetResourceSnapshotSchema.parse(await request(FLEET_RESOURCES_PATH, undefined, options));
}

export async function runSimulatorCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<unknown> {
  if (args.length === 0 || (args.length === 1 && args[0] === "status"))
    return FleetSimulatorStatusSchema.parse(await request(FLEET_SIMULATORS_PATH, undefined, options));
  if (args.length !== 2 || !["acquire", "touch", "release"].includes(args[0] ?? ""))
    throw new Error("Usage: clankie simulator status | acquire JSON | touch JSON | release JSON");
  const value: unknown = JSON.parse(args[1]!);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Simulator request must be a JSON object");
  if ("action" in value && value.action !== args[0]) throw new Error("Simulator command and action differ");
  const input = FleetSimulatorRequestSchema.parse({ ...value, action: args[0] });
  return FleetSimulatorResultSchema.parse(await request(FLEET_SIMULATORS_PATH, input, options));
}
