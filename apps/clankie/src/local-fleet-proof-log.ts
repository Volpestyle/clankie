import type { Socket } from "node:net";
import type { createLogger } from "@clankie/observability";
import type { LocalFleetProofDiagnostic } from "./local-fleet-proof.ts";
import type { LocalFleetProofRequestContext } from "./local-fleet-link.ts";
import type { FleetHealthMetrics } from "./fleet-health-metrics.ts";
import { fleetProcessHelper, observeSocketProcess, type NativeSocketOwner } from "./local-fleet-process.ts";

// Diagnostic-only history. Never supplied as an expected owner or used for admission.
const callers = new WeakMap<Socket, { owner: NativeSocketOwner; observedAt: string }>();
const sampled = new WeakMap<Socket, Promise<{ owner: NativeSocketOwner; observedAt: string } | undefined>>();
let sampleMinute = -1;
let sampleCount = 0;
let inFlight = 0;

async function refusalCaller(socket: Socket) {
  const known = callers.get(socket);
  if (known) return { ...known, attribution: "previous_kernel_observation" as const };
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== sampleMinute) {
    sampleMinute = minute;
    sampleCount = 0;
  }
  // Cold refusals may precede all normal socket snapshots. Sample at most once
  // per connection, 12 new connections/minute and two concurrent native reads.
  let pending = sampled.get(socket);
  const reused = pending !== undefined;
  if (!pending && sampleCount < 12 && inFlight < 2) {
    sampleCount++;
    inFlight++;
    const endpoint = { remotePort: socket.remotePort, localPort: socket.localPort };
    pending = observeSocketProcess(
      socket,
      fleetProcessHelper(),
      undefined,
      undefined,
      undefined,
      AbortSignal.timeout(1000),
    )
      .then((snapshot) =>
        snapshot &&
        !socket.destroyed &&
        socket.readable &&
        socket.writable &&
        socket.remotePort === endpoint.remotePort &&
        socket.localPort === endpoint.localPort
          ? { owner: snapshot.owner, observedAt: new Date().toISOString() }
          : undefined,
      )
      .catch(() => undefined)
      .finally(() => {
        inFlight--;
      });
    sampled.set(socket, pending);
  }
  const fresh = await pending;
  return fresh
    ? {
        ...fresh,
        attribution: reused ? ("previous_kernel_observation" as const) : ("kernel_observed" as const),
      }
    : undefined;
}

/** Fixed proof vocabulary; bounded private request attribution excludes paths, argv and credentials. */
export function localProofDiagnostics(
  logger: Pick<ReturnType<typeof createLogger>, "warn" | "debug">,
  operation: "fleet" | "project",
  metrics?: Pick<FleetHealthMetrics, "observeProof">,
) {
  const failures = new Map<
    string,
    { event: Extract<LocalFleetProofDiagnostic, { source: "native" }>["event"]; observedAt: string }
  >();
  // First observed kernel exit for the exact lifetime, not the time exit began.
  // Private diagnostics only; these identities never enter metrics or worker responses.
  const exitingSince = new Map<string, string>();
  // The last native or transport reason seen for each request, so a refusal with no reason of
  // its own (native_initial_unavailable) says which observation failed (#574).
  const lastNative = new Map<string, string>();
  return (observation: LocalFleetProofDiagnostic, pane?: string, context?: LocalFleetProofRequestContext) => {
    if (observation.source === "socket_owner") {
      if (context)
        callers.set(context.socket, { owner: observation.owner, observedAt: new Date().toISOString() });
      return;
    }
    if (observation.source === "native" && context) {
      if (
        (observation.event.ancestryFailure || observation.event.exitingProcess) &&
        !observation.event.retry
      ) {
        const observedAt = new Date().toISOString();
        failures.set(context.requestId, { event: observation.event, observedAt });
        if (observation.event.exitingProcess) {
          const key = JSON.stringify(observation.event.exitingProcess);
          if (!exitingSince.has(key)) exitingSince.set(key, observedAt);
          while (exitingSince.size > 512) exitingSince.delete(exitingSince.keys().next().value!);
        }
      }
      // Bound diagnostic history; a reused connection does not reuse a failure.
      while (failures.size > 512) failures.delete(failures.keys().next().value!);
    }
    if (context && (observation.source === "native" || observation.source === "transport")) {
      lastNative.set(
        context.requestId,
        observation.source === "native"
          ? `${observation.checkpoint}:${observation.event.stage}:${observation.event.reason}`
          : `transport:${observation.reason}`,
      );
      while (lastNative.size > 512) lastNative.delete(lastNative.keys().next().value!);
    }
    if (observation.source === "proof_success" && context) {
      failures.delete(context.requestId);
      lastNative.delete(context.requestId);
    }
    metrics?.observeProof(operation, observation, pane);
    if (observation.source === "proof_success") return;
    // A refusal is a warning. Native and project checkpoints arrive on every
    // proof request, several a second on a busy fleet, so they are debug (VUH-2393).
    logger[observation.source === "proof" ? "warn" : "debug"](
      {
        event: observation.source === "proof" ? "fleet.local_proof.refused" : "fleet.local_proof.diagnostic",
        operation,
        ...(observation.source !== "proof" && context
          ? { requestId: context.requestId, connectionId: context.connectionId }
          : {}),
        ...(observation.source === "native" || observation.source === "project"
          ? {
              source: observation.source,
              ...(observation.source === "native" ? { checkpoint: observation.checkpoint } : {}),
              ...observation.event,
            }
          : observation),
      },
      "Local fleet proof observation",
    );
    if (observation.source !== "proof" || !context) return;
    const fields = {
      event: "fleet.local_proof.refusal_context",
      operation,
      reason: observation.reason,
      requestId: context.requestId,
      connectionId: context.connectionId,
      method: context.method,
      route: context.route,
      ...(pane && /^w\w{1,64}:p\w{1,64}$/u.test(pane) ? { claimedPane: pane } : {}),
      ...(context.bridgeId ? { claimedBridgeId: context.bridgeId } : {}),
      ...(context.socket.remotePort ? { clientPort: context.socket.remotePort } : {}),
      ...(context.socket.localPort ? { serverPort: context.socket.localPort } : {}),
    };
    const failure = failures.get(context.requestId);
    failures.delete(context.requestId);
    const native = lastNative.get(context.requestId);
    lastNative.delete(context.requestId);
    const ancestry = failure?.event.ancestryFailure;
    const exitingProcess = failure?.event.exitingProcess;
    const callerRead = ancestry
      ? Promise.resolve({
          owner: { pid: ancestry.claimantPid, birth: ancestry.claimantBirth },
          observedAt: failure!.observedAt,
          attribution: "failure_time_kernel_observation" as const,
        })
      : exitingProcess
        ? Promise.resolve(undefined)
        : refusalCaller(context.socket);
    return callerRead.then((caller) => {
      logger.warn(
        {
          ...fields,
          callerAttribution: caller?.attribution ?? "unknown",
          ...(native === undefined ? {} : { lastNativeReason: native }),
          ...(exitingProcess
            ? {
                exitingProcess: {
                  ...exitingProcess,
                  firstObservedAt: exitingSince.get(JSON.stringify(exitingProcess)),
                  observedAt: failure!.observedAt,
                },
              }
            : {}),
          ...(ancestry
            ? {
                claimantStatus: ancestry.claimantStatus,
                failedChainIndex: ancestry.chainIndex,
                failedPid: ancestry.failedPid,
                ancestryPhase: ancestry.phase,
                ancestryErrno: failure!.event.errno,
              }
            : {}),
          ...(caller
            ? {
                callerPid: caller.owner.pid,
                callerBirth: caller.owner.birth,
                callerObservedAt: caller.observedAt,
              }
            : {}),
        },
        "Local fleet proof refusal request attribution",
      );
    });
  };
}
