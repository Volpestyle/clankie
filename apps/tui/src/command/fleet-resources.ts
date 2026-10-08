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
    // The service answers an acquire within about 20 seconds (`booting` if the
    // device is still starting); simulator status includes a CoreSimulator listing.
    signal: AbortSignal.timeout(
      body !== undefined ? 60_000 : path === FLEET_SIMULATORS_PATH ? 10_000 : 5_000,
    ),
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error(
        "Fleet resource request timed out. Any lease the service admitted is kept for this seat; run `clankie simulator status`, or acquire again to get it.",
      );
    throw error;
  });
  // Rejections carry their reason as JSON (409, and 503 while the service restarts).
  if (
    !response.ok &&
    response.status !== 409 &&
    !(body !== undefined && [500, 503].includes(response.status))
  )
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
  options: BrowserCommandOptions & {
    progress?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<unknown> {
  if (args.length === 0 || (args.length === 1 && args[0] === "status"))
    return FleetSimulatorStatusSchema.parse(await request(FLEET_SIMULATORS_PATH, undefined, options));
  const usage =
    "Usage: clankie simulator status | plan JSON | acquire JSON [--wait SECONDS] | touch JSON | release JSON";
  let waitSeconds = 0;
  const rest = [...args];
  const flag = rest.indexOf("--wait");
  if (flag !== -1) {
    if (rest[0] !== "acquire") throw new Error(usage);
    waitSeconds = Number(rest[flag + 1]);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) throw new Error(usage);
    rest.splice(flag, 2);
  }
  if (rest.length !== 2 || !["plan", "acquire", "touch", "release"].includes(rest[0] ?? ""))
    throw new Error(usage);
  const value: unknown = JSON.parse(rest[1]!);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Simulator request must be a JSON object");
  if ("action" in value && value.action !== rest[0]) throw new Error("Simulator command and action differ");
  const input = FleetSimulatorRequestSchema.parse({ ...value, action: rest[0] });
  let creationWarned = false;
  let idleShown = false;
  const call = async () => {
    if (input.action === "acquire") {
      const plan = FleetSimulatorResultSchema.parse(
        await request(FLEET_SIMULATORS_PATH, { ...input, action: "plan" }, options),
      );
      if (plan.outcome === "rejected") return plan;
      if (plan.outcome === "planned") {
        if (plan.choice === "create" && !creationWarned) {
          options.progress?.(
            "No idle matching simulator is available; if admitted now, acquire will create a new device. Its first boot is expensive and can slow the Mac.",
          );
          creationWarned = true;
        }
        if (!idleShown) {
          options.progress?.(
            `Idle timeout is ${plan.simulatorIdleMs / 1000} seconds; touch the lease while using it, and release when finished.`,
          );
          idleShown = true;
        }
      }
    }
    return FleetSimulatorResultSchema.parse(await request(FLEET_SIMULATORS_PATH, input, options));
  };
  let result = await call();
  // Acquire is idempotent per seat: polling it re-reads this seat's lease, or
  // admits it once a slot frees. Nothing is left behind if waiting stops.
  const deadline = Date.now() + waitSeconds * 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = "";
  while ((result.outcome === "waiting" || result.outcome === "booting") && Date.now() < deadline) {
    const line =
      result.outcome === "waiting"
        ? `waiting (${result.reason}): ${result.hint}`
        : `booting ${result.lease.deviceName ?? "simulator"} ${result.lease.deviceId ?? ""} (${result.lease.phase})`.trim();
    if (line !== last) options.progress?.(line);
    last = line;
    await sleep(Math.min(result.retryAfterMs ?? 5_000, Math.max(0, deadline - Date.now())));
    result = await call();
  }
  return result;
}
