import { HOSTED_OPERATOR_PATH } from "../../../packages/protocol/src/hosted-operator.ts";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH,
  OperatorConversationServiceResultSchema,
  parseProtocolResponse,
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
    if (!response.ok) {
      if (await upstreamRestarting(response)) throw new ConversationServiceRestarting();
      throw new Error(`Captain conversation service returned HTTP ${response.status}`);
    }
    return parseProtocolResponse(OperatorConversationServiceResultSchema, await response.json());
  };
}

/**
 * The service answered `503 service_restarting` (VUH-2626). Devices retry it
 * like a dropped connection, so the relay keeps the code rather than folding
 * it into an upstream failure (VUH-2663).
 */
export class ConversationServiceRestarting extends Error {
  public constructor() {
    super("Clankie is restarting");
    this.name = "ConversationServiceRestarting";
  }
}

/** Reads only a 503's error code; any other failed body is discarded unread. */
async function upstreamRestarting(response: Response): Promise<boolean> {
  if (response.status !== 503) {
    await response.body?.cancel();
    return false;
  }
  // allow-swallowed-rejection -- a body that is not JSON carries no error code; the status still fails the request
  const body: unknown = await response.json().catch(() => undefined);
  return typeof body === "object" && body !== null && "error" in body && body.error === "service_restarting";
}

export type DeviceConversationRequest = Extract<
  OperatorConversationServiceRequest,
  {
    op:
      | "send"
      | "pending_messages"
      | "stop_task"
      | "input_list"
      | "input_get"
      | "input_answer"
      | "input_cancel"
      | "project_proposal_get"
      | "project_proposal_confirm"
      | "project_proposal_tweak"
      | "work_item_write"
      | "work_item_write_receipt"
      | "tracker_sync"
      | "evidence_fetch"
      | "fleet_room"
      | "autonomy";
  }
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
    if (
      ![
        "send",
        "pending_messages",
        "stop_task",
        "input_list",
        "input_get",
        "input_answer",
        "input_cancel",
        "project_proposal_get",
        "project_proposal_confirm",
        "project_proposal_tweak",
        "work_item_write",
        "work_item_write_receipt",
        "tracker_sync",
        "evidence_fetch",
        "fleet_room",
        "autonomy",
      ].includes(request.op)
    )
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
      if (await upstreamRestarting(response)) throw new ConversationServiceRestarting();
      if ([400, 401, 403, 404, 409, 429, 503].includes(response.status))
        throw new DeviceConversationRefusal(response.status);
      throw new Error("Conversation owner upstream unavailable");
    }
    const result = parseProtocolResponse(OperatorConversationServiceResultSchema, await response.json());
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
