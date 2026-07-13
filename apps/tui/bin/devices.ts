import { z } from "zod";
import { DeviceListItemSchema, type DeviceListItem } from "@clankie/protocol";
import { DEFAULT_CONTROL_PLANE_URL } from "./pairing-offer.ts";

// Narrow operator client for device management (VUH-727): list paired devices
// and revoke one. Authenticated as the operator (`CLANKIE_OPERATOR_TOKEN`) over
// the same bearer path as `clankie pair`. Fails closed with content-free,
// actionable messages; never surfaces a response body or token in an error.

export const DEVICES_PATH = "/v1/devices";

const DeviceListSchema = z.array(DeviceListItemSchema);

export type { DeviceListItem };

export type DevicesCommandStatus = "unavailable" | "unauthorized" | "not_found" | "malformed" | "interrupted";

export class DevicesCommandError extends Error {
  public readonly status: DevicesCommandStatus;

  public constructor(status: DevicesCommandStatus) {
    super(devicesFailureMessage(status));
    this.name = "DevicesCommandError";
    this.status = status;
  }
}

export function devicesFailureMessage(status: DevicesCommandStatus): string {
  switch (status) {
    case "unavailable":
      return "Device service unavailable. Start the Clankie control plane and retry.";
    case "unauthorized":
      return "Operator token required. Set CLANKIE_OPERATOR_TOKEN and retry.";
    case "not_found":
      return "No such device. Run `clankie devices` to list current devices.";
    case "malformed":
      return "Device service returned an unexpected response. Update Clankie or retry.";
    case "interrupted":
      return "Device request did not complete in time. Retry.";
  }
}

export interface DevicesRequestOptions {
  readonly controlPlaneUrl?: string;
  readonly operatorToken?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requireOperatorToken(options: DevicesRequestOptions): string {
  const token = options.operatorToken?.trim();
  if (token === undefined || token.length === 0) throw new DevicesCommandError("unauthorized");
  return token;
}

async function operatorFetch(
  path: string,
  method: "GET" | "POST",
  options: DevicesRequestOptions,
): Promise<Response> {
  const token = requireOperatorToken(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(path, options.controlPlaneUrl ?? DEFAULT_CONTROL_PLANE_URL);
  try {
    return await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted === true || isAbortError(error)) throw new DevicesCommandError("interrupted");
    throw new DevicesCommandError("unavailable");
  }
}

/** List paired devices. Throws {@link DevicesCommandError} on every failure. */
export async function listDevices(options: DevicesRequestOptions = {}): Promise<DeviceListItem[]> {
  const response = await operatorFetch(DEVICES_PATH, "GET", options);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new DevicesCommandError("unauthorized");
    throw new DevicesCommandError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const parsed = DeviceListSchema.safeParse(payload);
  if (!parsed.success) throw new DevicesCommandError("malformed");
  return parsed.data;
}

/** Revoke one device by id. Returns the updated device row. */
export async function revokeDevice(
  deviceId: string,
  options: DevicesRequestOptions = {},
): Promise<DeviceListItem> {
  const response = await operatorFetch(
    `${DEVICES_PATH}/${encodeURIComponent(deviceId)}/revoke`,
    "POST",
    options,
  );
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new DevicesCommandError("unauthorized");
    if (response.status === 404) throw new DevicesCommandError("not_found");
    throw new DevicesCommandError("unavailable");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const parsed = DeviceListItemSchema.safeParse(payload);
  if (!parsed.success) throw new DevicesCommandError("malformed");
  return parsed.data;
}

/** Render granted capabilities compactly, e.g. `chat+steer+observe`. */
export function grantSummary(device: DeviceListItem): string {
  const parts: string[] = [];
  if (device.grants.chat) parts.push("chat");
  if (device.grants.steer) parts.push("steer");
  if (device.grants.terminalObserve) parts.push("observe");
  if (device.grants.terminalControl) parts.push("control");
  return parts.length > 0 ? parts.join("+") : "none";
}
