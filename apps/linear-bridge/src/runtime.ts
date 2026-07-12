import { LinearWebhookLocalBridge } from "../../relay/src/linear-webhook-bridge.ts";
import type {
  LinearWebhookBridgeOutcome,
  LinearWebhookEvidenceSink,
} from "../../relay/src/linear-webhook.ts";
import type { LinearWebhookOutboundTransport } from "../../relay/src/linear-webhook-queue.ts";
import {
  LinearChannelAdapter,
  type LinearChannelAdapterIdentity,
  type LinearChannelApi,
  type LinearChannelEvidenceSink,
} from "./linear-channel-adapter.ts";

export interface LinearBridgeRuntimeOptions {
  readonly transport: LinearWebhookOutboundTransport;
  readonly api: LinearChannelApi;
  readonly signingSecret: string | Uint8Array;
  readonly identity: LinearChannelAdapterIdentity;
  readonly approvalSurfaceUrl: string;
  readonly clock?: () => number;
  readonly idleDelayMs?: number;
  readonly maxRetainedDeliveries?: number;
  readonly relayEvidence?: LinearWebhookEvidenceSink;
  readonly channelEvidence?: LinearChannelEvidenceSink;
}

/** Runnable credential-free composition of the outbound verifier and channel adapter. */
export class LinearBridgeRuntime {
  private readonly connection: Awaited<ReturnType<LinearWebhookLocalBridge["dial"]>>;
  private readonly adapter: LinearChannelAdapter;
  private readonly idleDelayMs: number;

  private constructor(
    connection: Awaited<ReturnType<LinearWebhookLocalBridge["dial"]>>,
    adapter: LinearChannelAdapter,
    idleDelayMs: number,
  ) {
    this.connection = connection;
    this.adapter = adapter;
    this.idleDelayMs = idleDelayMs;
  }

  public static async connect(options: LinearBridgeRuntimeOptions): Promise<LinearBridgeRuntime> {
    const idleDelayMs = options.idleDelayMs ?? 100;
    if (!Number.isInteger(idleDelayMs) || idleDelayMs < 1) {
      throw new Error("Linear bridge idle delay must be a positive integer");
    }
    const verifier = new LinearWebhookLocalBridge({
      signingSecret: options.signingSecret,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.relayEvidence === undefined ? {} : { evidence: options.relayEvidence }),
    });
    const adapter = new LinearChannelAdapter({
      api: options.api,
      identity: options.identity,
      approvalSurfaceUrl: options.approvalSurfaceUrl,
      ...(options.maxRetainedDeliveries === undefined
        ? {}
        : { maxRetainedDeliveries: options.maxRetainedDeliveries }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.channelEvidence === undefined ? {} : { evidence: options.channelEvidence }),
    });
    const connection = await verifier.dial(options.transport);
    return new LinearBridgeRuntime(connection, adapter, idleDelayMs);
  }

  public processNext(): Promise<LinearWebhookBridgeOutcome> {
    return this.connection.processNext(async (event) => {
      await this.adapter.consume(event);
    });
  }

  public async run(signal?: AbortSignal): Promise<void> {
    try {
      while (signal?.aborted !== true) {
        const outcome = await this.processNext();
        if (outcome === "idle") await waitForNextPoll(this.idleDelayMs, signal);
      }
    } finally {
      await this.connection.close();
    }
  }

  public close(): Promise<void> {
    return this.connection.close();
  }
}

function waitForNextPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
