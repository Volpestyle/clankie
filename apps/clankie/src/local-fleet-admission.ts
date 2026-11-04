import type { FleetProofRefusalReason } from "@clankie/protocol";

/** Fixed public explanations, never kernel identities, paths or provider error text. */
const explanations: Partial<Record<FleetProofRefusalReason, string>> = {
  unsupported_platform: "This host platform does not support native local fleet proof.",
  unsupported_pid_namespace:
    "This process is outside the initial PID namespace required for local fleet proof.",
  invalid_pane: "This bridge did not claim a supported local fleet pane address.",
  pane_unavailable: "Herdr no longer reports the claimed pane.",
  pane_moved: "The claimed pane moved and now has a different native address.",
  not_member:
    "The requesting process is not in the claimed pane's native lineage or registered private seat.",
  private_seat_expired: "The worker's private native-seat registration expired or changed.",
};
const leadAction =
  "Ask the lead to inspect clankie fleet status and confirm this worker's original pane and native admission before retrying.";

/** A proven refusal. The fixed code explains it; it never supplies authority. */
export class FleetAdmissionRefusedError extends Error {
  readonly code: FleetProofRefusalReason | undefined;
  constructor(code?: FleetProofRefusalReason) {
    super(
      `${(code && explanations[code]) || "This request has no verified local fleet membership."} ${leadAction}`,
    );
    this.code = code;
  }
}

export function fleetAdmissionRefusedResponse(code?: FleetProofRefusalReason): Response {
  return Response.json(
    {
      error: "local_process_membership_required",
      ...(code === undefined ? {} : { refusal: code }),
      reason: new FleetAdmissionRefusedError(code).message,
    },
    { status: 403 },
  );
}

/**
 * An observation failed before dispatch; no membership decision or effect was made.
 * `code` is fixed diagnostic vocabulary the 503 carries as `observation`; it grants nothing.
 */
export class FleetAdmissionUnavailableError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function fleetAdmissionUnavailableResponse(
  diagnostic: { readonly observation?: string } = {},
): Response {
  return Response.json(
    {
      ...diagnostic,
      error: "fleet_admission_unavailable",
      retryable: true,
      reason:
        "Clankie could not verify this local fleet request yet. Retry shortly; if it persists, ask the lead to inspect clankie fleet status.",
    },
    { status: 503, headers: { "retry-after": "1" } },
  );
}
