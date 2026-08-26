/**
 * Live hosted-world operations the captain can invoke while a world body is
 * playing. Transport, grants, and the bearer stay inside WorldPlayerClient;
 * this is only the attach point.
 */
import { findOperation, type WorldOperationName } from "@pokeagents/world-protocol";
import type { WorldBody } from "./body.ts";

/** Multiplayer operations the gameplay mind may ask for. The play loop still owns act/observe/frame. */
export const HOSTED_WORLD_MIND_OPERATIONS = [
  "world.session",
  "world.who",
  "world.regions",
  "world.travel",
  "world.challenge",
  "world.challenges",
  "world.answer_challenge",
] as const satisfies readonly WorldOperationName[];

export type HostedWorldMindOperation = (typeof HOSTED_WORLD_MIND_OPERATIONS)[number];

const MIND_OPERATIONS = new Set<string>(HOSTED_WORLD_MIND_OPERATIONS);

export type HostedWorldInvokeResult =
  | { readonly outcome: "ok"; readonly result: unknown }
  | {
      readonly outcome: "refused";
      readonly reason: "not_playing" | "unknown_operation" | "capability_unavailable" | "world_unreachable";
      readonly detail?: string;
      readonly result?: unknown;
    };

export class HostedWorldSession {
  private body: WorldBody | undefined;

  public attach(body: WorldBody): void {
    this.body = body;
  }

  public detach(body: WorldBody): void {
    if (this.body === body) this.body = undefined;
  }

  public inspect():
    | { readonly outcome: "not_playing" }
    | {
        readonly outcome: "playing";
        readonly grantedOperations: readonly string[];
        readonly session: ReturnType<WorldBody["sessionSnapshot"]>;
      } {
    if (this.body === undefined) return { outcome: "not_playing" };
    return {
      outcome: "playing",
      grantedOperations: this.body.grantedOperationNames().filter((name) => MIND_OPERATIONS.has(name)),
      session: this.body.sessionSnapshot(),
    };
  }

  public async invoke(name: string, input: Record<string, unknown> = {}): Promise<HostedWorldInvokeResult> {
    if (this.body === undefined) return { outcome: "refused", reason: "not_playing" };
    if (!MIND_OPERATIONS.has(name) || findOperation(name) === undefined) {
      return { outcome: "refused", reason: "unknown_operation", detail: name };
    }
    if (!this.body.grantedOperationNames().includes(name)) {
      return {
        outcome: "refused",
        reason: "capability_unavailable",
        detail: `The world did not grant ${name}`,
      };
    }
    try {
      const result = await this.body.callWorld(name, input);
      return { outcome: "ok", result };
    } catch (error) {
      return {
        outcome: "refused",
        reason: "world_unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
