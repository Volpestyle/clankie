import { DeviceSelfResponseSchema, type DeviceSelfResponse } from "../../../packages/protocol/src/index.ts";

export type RelayDeviceAuthDenial = "invalid" | "expired" | "revoked" | "unavailable";

export type RelayDeviceAuthorization =
  | { readonly authorized: true; readonly device: DeviceSelfResponse }
  | { readonly authorized: false; readonly denial: RelayDeviceAuthDenial };

/**
 * Auth port for relay requests. Implementations must resolve current device
 * state on every call; a signed token alone is identity, never live authority.
 */
export interface RelayDeviceAuthorizer {
  authorize(bearerToken: string): Promise<RelayDeviceAuthorization>;
}

export interface ControlPlaneDeviceAuthorizerOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Reuses the control-plane's VUH-727 device-session boundary. `/v1/devices/self`
 * verifies the HMAC session token and reads the durable device projection, so
 * revocation takes effect on the next relay request or tail poll.
 */
export class ControlPlaneDeviceAuthorizer implements RelayDeviceAuthorizer {
  private readonly endpoint: URL;
  private readonly fetcher: typeof globalThis.fetch;

  public constructor(options: ControlPlaneDeviceAuthorizerOptions) {
    this.endpoint = new URL("/v1/devices/self", requireHttpBase(options.baseUrl));
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  public async authorize(bearerToken: string): Promise<RelayDeviceAuthorization> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        headers: { authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { authorized: false, denial: "unavailable" };
    }
    if (response.status === 503) return { authorized: false, denial: "unavailable" };
    if (!response.ok) {
      const denial = await denialFrom(response);
      return { authorized: false, denial };
    }
    try {
      return { authorized: true, device: DeviceSelfResponseSchema.parse(await response.json()) };
    } catch {
      return { authorized: false, denial: "unavailable" };
    }
  }
}

async function denialFrom(response: Response): Promise<Exclude<RelayDeviceAuthDenial, "unavailable">> {
  try {
    const body = (await response.json()) as { readonly error?: unknown };
    if (body.error === "revoked") return "revoked";
    if (body.error === "expired") return "expired";
  } catch {
    // Content-free invalid denial below; never retain the raw response.
  }
  return "invalid";
}

function requireHttpBase(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Control-plane URL must use http or https");
  }
  return url;
}
