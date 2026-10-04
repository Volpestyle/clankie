import { HOSTED_OPERATOR_PATH } from "../../../packages/protocol/src/hosted-operator.ts";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH,
  OperatorConversationServiceResultSchema,
  type OperatorDeliveredFileDownloadRequest,
  type OperatorConversationServiceDispatch,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "../../../packages/protocol/src/index.ts";

export interface CaptainConversationDispatchOptions {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Authenticated, schema-validating hop to the captain-owned registry service. */
export function createCaptainConversationDispatch(
  options: CaptainConversationDispatchOptions,
): OperatorConversationServiceDispatch {
  if (options.bearerToken.trim().length < 16) throw new Error("Captain bearer token is too short");
  const endpoint = new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, requireHttpBase(options.baseUrl));
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (request, signal) => {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: dispatchSignal(signal),
    });
    if (!response.ok) throw new Error(`Captain conversation service returned HTTP ${response.status}`);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
}

export type DeviceConversationRequest = Extract<
  OperatorConversationServiceRequest,
  { op: "send" | "input_get" | "input_answer" | "input_cancel" }
>;
export type DeviceConversationDispatch = (
  request: DeviceConversationRequest,
  authority: { readonly deviceToken: string; readonly controlScope?: "hosted" },
  signal?: AbortSignal,
) => Promise<OperatorConversationServiceResult>;

/** Only a status survives an upstream refusal; body and credential never enter errors. */
export class DeviceConversationRefusal extends Error {
  public readonly status: number;
  public constructor(status: number) {
    super("Conversation owner upstream refused");
    this.status = status;
  }
}

/** Original signed identity, to the SAME direct service that authorizes devices. */
export function createDeviceConversationDispatch(options: {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): DeviceConversationDispatch {
  const base = requireHttpBase(options.baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("Device conversation URL must be a direct control-plane origin");
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (request, authority, signal) => {
    if (!["send", "input_get", "input_answer", "input_cancel"].includes(request.op))
      throw new Error("Unsupported device conversation operation");
    const hosted = authority.controlScope === "hosted";
    const requestSignal = dispatchSignal(signal);
    requestSignal.throwIfAborted();
    const response = await fetcher(
      new URL(hosted ? HOSTED_OPERATOR_PATH : OPERATOR_CONVERSATION_DISPATCH_PATH, base),
      {
        method: "POST",
        headers: { authorization: `Bearer ${authority.deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify(
          hosted
            ? { method: "POST", path: OPERATOR_CONVERSATION_DISPATCH_PATH, body: JSON.stringify(request) }
            : request,
        ),
        signal: requestSignal,
        redirect: "error",
        cache: "no-store",
      },
    );
    requestSignal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404, 409, 429, 503].includes(response.status))
        throw new DeviceConversationRefusal(response.status);
      throw new Error("Conversation owner upstream unavailable");
    }
    const result = OperatorConversationServiceResultSchema.parse(await response.json());
    requestSignal.throwIfAborted();
    if (result.op !== request.op) throw new Error("Unexpected conversation owner response");
    return result;
  };
}

function dispatchSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(30_000);
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

/** Authenticated raw-byte hop; the device bearer never reaches the captain. */
export function createCaptainFileDownload(options: CaptainConversationDispatchOptions) {
  if (options.bearerToken.trim().length < 16) throw new Error("Captain bearer token is too short");
  const endpoint = new URL(OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH, requireHttpBase(options.baseUrl));
  const fetcher = options.fetch ?? globalThis.fetch;
  return (request: OperatorDeliveredFileDownloadRequest): Promise<Response> =>
    fetcher(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
}

function requireHttpBase(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Captain URL must use http or https");
  }
  return url;
}
