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
