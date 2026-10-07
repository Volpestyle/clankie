/** An observation failed before dispatch; no membership decision or effect was made. */
export class FleetAdmissionUnavailableError extends Error {}

export function fleetAdmissionUnavailableResponse(): Response {
  return Response.json(
    {
      error: "fleet_admission_unavailable",
      retryable: true,
      reason:
        "Clankie could not verify this local fleet request yet. Retry shortly; if it persists, ask the lead to inspect clankie fleet status.",
    },
    { status: 503, headers: { "retry-after": "1" } },
  );
}
