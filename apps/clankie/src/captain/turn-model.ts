import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { TurnModelUsage } from "@clankie/protocol/model-keys";
import {
  TurnModelCallSchema,
  type TurnModelCall,
  type TurnRoutingDecision,
} from "@clankie/protocol/turn-model";
import type { RoutedSelection } from "./model.ts";

type Observation = { modelCall: TurnModelCall } | { routingDecision: TurnRoutingDecision };

/** One session's serial provider attempts. Subscribers belong to the active owner run. */
export class TurnModelRecorder {
  private readonly observers = new Set<(event: Observation) => void>();
  private sequence = 0;
  private call: TurnModelCall | undefined;
  private readonly current: () => RoutedSelection;
  private readonly used: () => TurnModelUsage | undefined;

  public constructor(current: () => RoutedSelection, used: () => TurnModelUsage | undefined) {
    this.current = current;
    this.used = used;
  }

  public subscribe(observer: (event: Observation) => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  private emit(event: Observation): void {
    for (const observer of this.observers) observer(event);
  }

  public decision(routingDecision: TurnRoutingDecision): void {
    this.emit({ routingDecision });
  }

  public start(requestedRef: string): void {
    const current = this.current();
    this.call = {
      id: randomUUID(),
      sequence: ++this.sequence,
      phase: "requested",
      preference: current.preference ?? current.selection.ref,
      modelUsage: { requestedRef, actual: null, source: "unavailable" },
    };
    this.emit({ modelCall: this.call });
  }

  public response(status: number): void {
    if (this.call === undefined) return;
    this.call = {
      ...this.call,
      phase: status >= 200 && status < 300 ? "responded" : "failed",
      modelUsage:
        status >= 200 && status < 300 ? (this.used() ?? this.call.modelUsage) : this.call.modelUsage,
    };
    this.emit({ modelCall: this.call });
  }

  public complete(message: AssistantMessage): void {
    if (this.call === undefined) return;
    const tokens = TurnModelCallSchema.shape.tokens.safeParse({
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      total: message.usage.totalTokens,
    });
    const modelCall: TurnModelCall = {
      ...this.call,
      phase: message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "completed",
      // Pi initializes missing usage to zeros; those defaults do not attest a free call.
      ...(tokens.success && (tokens.data?.total ?? 0) > 0 ? { tokens: tokens.data } : {}),
    };
    this.emit({ modelCall });
    this.call = undefined;
  }
}

/** Register after the unchanged serving-identity extension so response attestation is available. */
export function captainTurnModelExtension(recorder: TurnModelRecorder): InlineExtension {
  return {
    name: "captain-turn-model",
    hidden: true,
    factory(pi) {
      pi.on("before_provider_request", (_event, context) => {
        if (context.model !== undefined) recorder.start(`${context.model.provider}/${context.model.id}`);
      });
      pi.on("after_provider_response", (event) => {
        recorder.response(event.status);
      });
      pi.on("message_end", (event) => {
        if (event.message.role === "assistant") recorder.complete(event.message as AssistantMessage);
      });
    },
  };
}
