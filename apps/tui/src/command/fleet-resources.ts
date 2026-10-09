import { Agent } from "undici";
import { resourceHolderIdentity } from "@clankie/fleet-resources";
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

async function request(
  path: string,
  body: unknown,
  options: BrowserCommandOptions,
  timeoutMs?: number,
): Promise<unknown> {
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential?.token) throw new Error("No operator credential is available");
  const deadlineMs =
    timeoutMs ?? (body !== undefined ? 60_000 : path === FLEET_SIMULATORS_PATH ? 10_000 : 5_000);
  // Undici otherwise stops waiting for headers after 300 seconds, before the
  // simulator's blocking FIFO wait ends. Scope this policy to this request,
  // including response consumption; never change the process-global dispatcher.
  const dispatcher =
    timeoutMs === undefined
      ? undefined
      : new Agent({
          headersTimeout: deadlineMs,
          bodyTimeout: deadlineMs,
        });
  try {
    const init: RequestInit & { dispatcher?: Agent } = {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(dispatcher === undefined ? {} : { dispatcher }),
      signal: AbortSignal.timeout(deadlineMs),
    };
    const response = await (options.fetchImpl ?? fetch)(
      new URL(path, commandHost({ ...options, env })),
      init,
    ).catch((error: unknown) => {
      throw transportError(error);
    });
    // Rejections carry their reason as JSON (409, and 503 while the service restarts).
    if (
      !response.ok &&
      response.status !== 409 &&
      !(body !== undefined && [500, 503].includes(response.status))
    ) {
      await response.body?.cancel();
      throw new Error(`Fleet resource request failed (HTTP ${response.status})`);
    }
    return await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError)
        throw new Error("Fleet resource response is invalid", { cause: error });
      throw transportError(error);
    });
  } finally {
    await dispatcher?.destroy();
  }
}

function transportError(error: unknown): Error {
  if (error instanceof Error && error.name === "TimeoutError")
    return new Error(
      "Fleet resource request timed out. Check simulator status: a waiting ticket can resume before expiry, and an admitted lease is kept for this holder.",
      { cause: error },
    );
  let cause = error;
  let label = "unknown transport error";
  // Fetch wraps native socket/timeout errors in TypeError. Surface the native
  // name/code without including URLs, bearer headers or other request data.
  for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    label = code ? `${code}: ${cause.name}` : cause.name;
    if (!cause.cause) break;
    cause = cause.cause;
  }
  return new Error(
    `Fleet resource transport failed (${label}). Check simulator status; resume a waiting ticket with the same selection and ticketId before expiry. No acquire was retried.`,
    { cause: error },
  );
}

export async function runResourceStatusCommand(options: BrowserCommandOptions = {}) {
  return FleetResourceSnapshotSchema.parse(await request(FLEET_RESOURCES_PATH, undefined, options));
}

export async function runSimulatorCommand(
  args: readonly string[],
  options: BrowserCommandOptions & {
    progress?: (line: string) => void;
  } = {},
): Promise<unknown> {
  if (args.length === 0 || (args.length === 1 && args[0] === "status"))
    return FleetSimulatorStatusSchema.parse(await request(FLEET_SIMULATORS_PATH, undefined, options));
  const usage =
    "Usage: clankie simulator status | plan JSON | acquire JSON [--wait SECONDS] | verify JSON | touch JSON | release JSON | cancel JSON";
  let waitSeconds = 3600;
  const rest = [...args];
  const flag = rest.indexOf("--wait");
  if (flag !== -1) {
    if (rest[0] !== "acquire") throw new Error(usage);
    waitSeconds = Number(rest[flag + 1]);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) throw new Error(usage);
    rest.splice(flag, 2);
  }
  if (
    rest.length !== 2 ||
    !["plan", "acquire", "verify", "touch", "release", "cancel"].includes(rest[0] ?? "")
  )
    throw new Error(usage);
  const value: unknown = JSON.parse(rest[1]!);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Simulator request must be a JSON object");
  if ("action" in value && value.action !== rest[0]) throw new Error("Simulator command and action differ");
  const holderId = resourceHolderIdentity(options.env ?? process.env);
  const input = FleetSimulatorRequestSchema.parse({
    ...(holderId === undefined ? {} : { holderId }),
    ...value,
    action: rest[0],
    ...(rest[0] === "acquire" ? { waitMs: waitSeconds * 1000 } : {}),
  });
  let creationWarned = false;
  let idleShown = false;
  const call = async () => {
    if (input.action === "acquire") {
      const { waitMs: _waitMs, ticketId: _ticketId, ...selection } = input;
      const plan = FleetSimulatorResultSchema.parse(
        await request(FLEET_SIMULATORS_PATH, { ...selection, action: "plan" }, options),
      );
      if (plan.outcome === "rejected") return plan;
      if (plan.outcome === "waiting") options.progress?.(`waiting (${plan.reason}): ${plan.hint}`);
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
    const result = FleetSimulatorResultSchema.parse(
      await request(
        FLEET_SIMULATORS_PATH,
        input,
        options,
        input.action === "acquire" ? waitSeconds * 1000 + 60_000 : undefined,
      ),
    );
    if (input.action === "acquire" && result.outcome === "waiting" && result.ticket)
      options.progress?.(
        `Ticket ${result.ticket.id}, position ${result.ticket.position ?? "unknown"}; cancel it with simulator cancel JSON or resume with its ticketId.`,
      );
    if ((input.action === "acquire" || input.action === "verify") && result.outcome === "acquired") {
      const lease = result.lease;
      if (
        !lease.deviceId ||
        (input.holderId !== undefined && lease.holderId !== input.holderId) ||
        (input.deviceId && lease.deviceId.toUpperCase() !== input.deviceId.toUpperCase()) ||
        (input.action === "acquire" &&
          input.exact &&
          input.deviceType &&
          lease.deviceType !== input.deviceType) ||
        (input.action === "acquire" && input.runtime && lease.runtime !== input.runtime)
      )
        throw new Error(
          `Simulator grant does not match this holder/device request: lease ${lease.id}, device ${lease.deviceId ?? "unknown"}. Do not drive or release it; inspect simulator status.`,
        );
    }
    return result;
  };
  return call();
}
