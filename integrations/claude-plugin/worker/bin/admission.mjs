import { setTimeout as delay } from "node:timers/promises";

export class FleetMembershipRefused extends Error {}

// Fixed proof vocabulary only: response text and unknown values must not become
// a diagnostic instruction or leak a process path/credential into worker logs.
const proofReasons = new Set([
  "unsupported_platform",
  "unsupported_pid_namespace",
  "invalid_pane",
  "closed_socket",
  "missing_binding",
  "caller_exited",
  "ancestor_exited",
  "native_initial_unavailable",
  "native_final_unavailable",
  "pane_unavailable",
  "pane_moved",
  "not_member",
  "snapshot_changed",
  "pane_changed",
  "private_seat_expired",
  "binding_changed",
  "observation_failed",
  "connection_unavailable",
  "connection_changed",
  "private_seat_lifetime_unavailable",
  "private_seat_occupant_unavailable",
]);
function proofReason(value) {
  return proofReasons.has(value) ? `Native proof reason: ${value}. ` : "";
}

export async function checkFleetMembership(response) {
  if (response.status !== 403) return;
  const value = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (value?.error === "local_process_membership_required")
    throw new FleetMembershipRefused(
      proofReason(value.refusal) +
        "This native seat is no longer admitted to the fleet. Automatic mailbox polling stopped. Ask Clankie to confirm or restore this seat's admission; repeated retries cannot grant access.",
    );
}

// Only this service contract proves that the request was refused before forwarding.
// A timeout, a generic 503, or a lost reply may follow dispatch and never permits replay.
export async function admissionRefusal(response) {
  if (response.status !== 503) return undefined;
  const value = await response
    .clone()
    .json()
    .catch(() => undefined);
  return value?.error === "fleet_admission_unavailable" && value.retryable === true
    ? {
        retryable: true,
        detail:
          proofReason(value.observation) +
          "Clankie could not verify fleet admission just now; nothing was sent. Wait briefly and retry. If it persists, report the admission check failure to Clankie; it does not mean you left the fleet.",
      }
    : undefined;
}

export async function requestWithAdmissionRetry(request, signal) {
  const response = await request();
  if (!(await admissionRefusal(response))) return response;
  try {
    await delay(1_000, undefined, signal ? { signal } : undefined);
  } catch (error) {
    // Cancellation during the wait cannot turn a proven undispatched original
    // into an uncertain receipt. Return its explicit refusal without replay.
    if (signal?.aborted) return response;
    throw error;
  }
  return request();
}
