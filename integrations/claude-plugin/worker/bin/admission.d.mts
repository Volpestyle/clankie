export function admissionRefusal(
  response: Response,
): Promise<{ retryable: true; detail: string } | undefined>;
export function requestWithAdmissionRetry(
  request: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response>;
export class FleetMembershipRefused extends Error {}
export function checkFleetMembership(response: Response): Promise<void>;
