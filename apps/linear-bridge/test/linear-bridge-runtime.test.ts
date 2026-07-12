import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  CaptainChannelTurnResult,
  LinearChannelTurnRequest,
  TrackerNarrativeWrite,
  TrackerNarrativeWriteResult,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { LinearWebhookIngress } from "../../relay/src/linear-webhook-ingress.ts";
import { RetainedLinearWebhookQueue } from "../../relay/src/linear-webhook-queue.ts";
import type { LinearChannelApi } from "../src/linear-channel-adapter.ts";
import { LinearBridgeRuntime } from "../src/runtime.ts";

describe("LinearBridgeRuntime", () => {
  it("runs the real local verifier -> adapter -> credential-free API composition", async () => {
    const payload = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/tracker-connector/test/fixtures/agent-session-created.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { webhookTimestamp: number };
    const now = payload.webhookTimestamp;
    const queue = new RetainedLinearWebhookQueue({ clock: () => now });
    const api = new RecordingApi();
    const runtime = await LinearBridgeRuntime.connect({
      transport: queue,
      api,
      signingSecret: "linear-runtime-test-secret",
      identity: {
        missionId: "mission-linear",
        taskId: "task-linear",
        workerRunId: "worker-linear",
        profileHash: "profile-linear",
        workspaceId: "organization-1",
        appUserId: "clankie-app-1",
      },
      approvalSurfaceUrl: "http://127.0.0.1:4310/approvals",
      clock: () => now,
      maxRetainedDeliveries: 1,
    });
    const ingress = new LinearWebhookIngress({
      signingSecret: "linear-runtime-test-secret",
      queue,
      clock: () => now,
    });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const deliveryId = "00000000-0000-4000-8000-000000000301";

    expect(
      ingress.handle({
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "linear-delivery": deliveryId,
          "linear-event": "AgentSessionEvent",
          "linear-signature": createHmac("sha256", "linear-runtime-test-secret")
            .update(rawBody)
            .digest("hex"),
          "linear-timestamp": String(now),
        }),
        rawBody,
      }),
    ).toEqual({ status: 200, outcome: "accepted" });

    await expect(runtime.processNext()).resolves.toBe("delivered");
    expect(api.turns).toHaveLength(1);
    expect(api.turns[0]?.deliveryId).toBe(deliveryId);
    expect(api.turns[0]?.identity.correlationId).toBe(`linear-delivery:${deliveryId}`);
    expect(api.writes.map((write) => write.action)).toEqual([
      "tracker.agent-activity.thought.create",
      "tracker.agent-activity.response.create",
    ]);

    const secondDeliveryId = "00000000-0000-4000-8000-000000000302";
    expect(
      ingress.handle({
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "linear-delivery": secondDeliveryId,
          "linear-event": "AgentSessionEvent",
          "linear-signature": createHmac("sha256", "linear-runtime-test-secret")
            .update(rawBody)
            .digest("hex"),
          "linear-timestamp": String(now),
        }),
        rawBody,
      }),
    ).toEqual({ status: 200, outcome: "accepted" });
    await expect(runtime.processNext()).resolves.toBe("retry_scheduled");
    expect(queue.snapshot()).toMatchObject({ queued: 1, inFlight: 0 });
    await runtime.close();
  });

  it("exposes runnable start and development scripts", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts).toMatchObject({
      dev: "tsx watch src/main.ts",
      start: "tsx src/main.ts",
    });
  });
});

class RecordingApi implements LinearChannelApi {
  public readonly turns: LinearChannelTurnRequest[] = [];
  public readonly writes: TrackerNarrativeWrite[] = [];

  public async submitCaptainChannelTurn(input: LinearChannelTurnRequest): Promise<CaptainChannelTurnResult> {
    this.turns.push(input);
    return {
      state: "settled",
      captainSessionId: "captain-session",
      turnId: "turn-1",
      response: "Done.",
    };
  }

  public async writeTrackerNarrative(input: TrackerNarrativeWrite): Promise<TrackerNarrativeWriteResult> {
    this.writes.push(input);
    return {
      id: `narrative-${String(this.writes.length)}`,
      action: input.action,
      appUserId: "clankie-app-1",
    };
  }
}
