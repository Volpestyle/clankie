import { createHash, randomUUID } from "node:crypto";
import { SafetyApprovalSchema, type SafetyApproval, type SafetySettings } from "@clankie/protocol";
import { safetyDecision } from "@clankie/settings";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { TurnContext } from "./captain/tools.ts";

export function safetyScope(lane: string, turn: TurnContext): string {
  return `${lane}:${turn.room ?? turn.targetId ?? "unattributed"}:${turn.actorId ?? "owner"}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class SafetyBoundary {
  private readonly requests = new Map<string, SafetyApproval>();
  private readonly load: () => Promise<SafetySettings>;
  private readonly now: () => number;
  constructor(load: () => Promise<SafetySettings>, now = () => Date.now()) {
    this.load = load;
    this.now = now;
  }

  private sweep(): void {
    for (const [id, request] of this.requests)
      if (Date.parse(request.expiresAt) <= this.now()) this.requests.delete(id);
  }

  status(): Promise<SafetySettings> {
    return this.load();
  }

  async check(scope: string, tool: string, args: Record<string, unknown>): Promise<void> {
    const safety = await this.load();
    const decision = safetyDecision(safety, tool);
    if (decision === "allow") return;
    if (decision === "deny") throw new Error(`safety_denied: ${tool}. No action was performed.`);
    this.sweep();
    const payload = canonical({ scope, tool, arguments: args, safety });
    if (Buffer.byteLength(payload) > 64 * 1024) throw new Error("safety_request_too_large");
    const fingerprint = createHash("sha256").update(payload).digest("hex");
    let request = [...this.requests.values()].find(
      (saved) => saved.fingerprint === fingerprint && saved.status !== "consumed",
    );
    if (request?.status === "approved") {
      request.status = "consumed";
      return;
    }
    if (request?.status === "rejected")
      throw new Error(`safety_rejected: ${request.id}. No action was performed.`);
    if (!request) {
      if (this.requests.size >= 100) throw new Error("safety_request_limit: review pending requests first");
      request = SafetyApprovalSchema.parse({
        id: randomUUID(),
        scope,
        tool,
        arguments: JSON.parse(canonical(args)),
        fingerprint,
        expiresAt: new Date(this.now() + 15 * 60_000).toISOString(),
        status: "pending",
      });
      this.requests.set(request.id, request);
    }
    throw new Error(
      `safety_approval_required: ${JSON.stringify(request)}. Show this exact draft to the owner. Nothing executed. Owner command: clankie safety approve ${request.id} ${request.fingerprint}`,
    );
  }

  list(): SafetyApproval[] {
    this.sweep();
    return [...this.requests.values()].map((request) => structuredClone(request));
  }

  async answer(
    id: string,
    fingerprint: string,
    approve: boolean,
    guard?: () => Promise<void>,
  ): Promise<SafetyApproval> {
    const safety = await this.load();
    await guard?.();
    this.sweep();
    const request = this.requests.get(id);
    if (!request || request.status !== "pending") throw new Error("safety_request_not_pending");
    const current = createHash("sha256")
      .update(canonical({ scope: request.scope, tool: request.tool, arguments: request.arguments, safety }))
      .digest("hex");
    if (request.fingerprint !== fingerprint || (approve && current !== fingerprint))
      throw new Error("safety_request_changed");
    request.status = approve ? "approved" : "rejected";
    return structuredClone(request);
  }
}

export function safetyExtension(boundary: SafetyBoundary, scope: () => string): InlineExtension {
  return {
    name: "owner-safety",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event) => {
        try {
          await boundary.check(scope(), event.toolName, event.input as Record<string, unknown>);
          return undefined;
        } catch (error) {
          return { block: true, reason: error instanceof Error ? error.message : String(error) };
        }
      });
    },
  };
}
