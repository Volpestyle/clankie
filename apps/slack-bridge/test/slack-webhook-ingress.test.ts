import { createHmac } from "node:crypto";
import type { CaptainChannelTurnResult, SlackChannelTurnRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  slackSignatureBasestring,
  SLACK_WEBHOOK_REPLAY_WINDOW_MS,
} from "../../relay/src/slack-webhook-protocol.ts";
import { SlackChannelAdapter } from "../src/slack-channel-adapter.ts";
import { SlackWebhookIngress } from "../src/slack-webhook-ingress.ts";

const SECRET = "slack-signing-secret";
const APP_USER_ID = "U0CLANKIE";
const NOW_MS = 1_775_000_000_000;

const settled: CaptainChannelTurnResult = {
  state: "settled",
  captainSessionId: "sess-1",
  turnId: "turn-1",
  response: "On it.",
};

function eventBody(eventId = "Ev1"): string {
  return JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: eventId,
    event_time: 1_775_000_000,
    authorizations: [{ user_id: APP_USER_ID }],
    event: {
      type: "app_mention",
      channel: "C1",
      user: "UJAMES",
      ts: "1775000000.000100",
      text: "<@U0CLANKIE> status?",
    },
  });
}

function sign(rawBody: Uint8Array, timestamp: string, secret = SECRET): string {
  return `v0=${createHmac("sha256", secret).update(slackSignatureBasestring(timestamp, rawBody)).digest("hex")}`;
}

function makeIngress(
  overrides: Partial<ConstructorParameters<typeof SlackWebhookIngress>[0]> = {},
  turn: { hold?: boolean } = {},
) {
  const submitted: SlackChannelTurnRequest[] = [];
  let release: (() => void) | undefined;
  let sequence = 0;
  const adapter = new SlackChannelAdapter({
    api: {
      submitSlackCaptainChannelTurn: async (request) => {
        submitted.push(request);
        if (turn.hold) await new Promise<void>((resolve) => (release = resolve));
        return settled;
      },
    },
    identity: { profileHash: "profile-abc", appUserId: APP_USER_ID },
    reply: { postMessage: () => Promise.resolve() },
    approvalSurfaceUrl: "https://clankie.bot/approvals",
    clock: () => NOW_MS,
    deliveryIdFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const ingress = new SlackWebhookIngress({
    signingSecret: SECRET,
    adapter,
    clock: () => NOW_MS,
    ...overrides,
  });
  return { ingress, submitted, release: () => release?.() };
}

function post(body: string, headers: Record<string, string>) {
  return {
    method: "POST",
    headers: new Headers(headers),
    rawBody: new TextEncoder().encode(body),
  };
}

const validTimestamp = String(Math.floor(NOW_MS / 1_000));

describe("SlackWebhookIngress", () => {
  it("acknowledges without waiting for the turn to finish", async () => {
    // The turn is held open for the whole test, so an ack that waited on it
    // would deadlock rather than merely be slow.
    const { ingress, submitted, release } = makeIngress({}, { hold: true });
    const body = eventBody();
    const raw = new TextEncoder().encode(body);

    const result = await ingress.handle(
      post(body, {
        "x-slack-request-timestamp": validTimestamp,
        "x-slack-signature": sign(raw, validTimestamp),
      }),
    );

    // Slack retries anything it does not see acknowledged within three seconds,
    // so a slow mission must never hold the response open.
    expect(result).toEqual({ status: 200, outcome: "accepted" });
    expect(submitted).toHaveLength(1);
    release();
    await ingress.settle();
  });

  it("rejects a body whose signature does not match", async () => {
    const { ingress, submitted } = makeIngress();
    const body = eventBody();
    const raw = new TextEncoder().encode(body);

    const result = await ingress.handle(
      post(body, {
        "x-slack-request-timestamp": validTimestamp,
        "x-slack-signature": sign(raw, validTimestamp, "wrong-secret"),
      }),
    );

    expect(result).toEqual({ status: 401, outcome: "rejected" });
    await ingress.settle();
    expect(submitted).toEqual([]);
  });

  it("rejects a valid signature replayed outside the window", async () => {
    const { ingress, submitted } = makeIngress();
    const body = eventBody();
    const raw = new TextEncoder().encode(body);
    const stale = String(Math.floor((NOW_MS - SLACK_WEBHOOK_REPLAY_WINDOW_MS - 1_000) / 1_000));

    const result = await ingress.handle(
      post(body, {
        "x-slack-request-timestamp": stale,
        "x-slack-signature": sign(raw, stale),
      }),
    );

    expect(result).toEqual({ status: 401, outcome: "rejected" });
    await ingress.settle();
    expect(submitted).toEqual([]);
  });

  it("refuses a signature computed over the body alone", async () => {
    const { ingress } = makeIngress();
    const body = eventBody();
    const bodyOnly = `v0=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

    const result = await ingress.handle(
      post(body, {
        "x-slack-request-timestamp": validTimestamp,
        "x-slack-signature": bodyOnly,
      }),
    );

    expect(result).toEqual({ status: 401, outcome: "rejected" });
  });

  it("rejects a delivery with no signature headers", async () => {
    const { ingress } = makeIngress();

    expect(await ingress.handle(post(eventBody(), {}))).toEqual({ status: 401, outcome: "rejected" });
  });

  it("answers the url_verification handshake without starting a turn", async () => {
    const { ingress, submitted } = makeIngress();
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const raw = new TextEncoder().encode(body);

    const result = await ingress.handle(
      post(body, {
        "x-slack-request-timestamp": validTimestamp,
        "x-slack-signature": sign(raw, validTimestamp),
      }),
    );

    expect(result).toEqual({ status: 200, outcome: "challenge", challenge: "abc123" });
    await ingress.settle();
    expect(submitted).toEqual([]);
  });

  it("rejects an oversized body before verifying it", async () => {
    const { ingress } = makeIngress({ maxBodyBytes: 16 });
    const body = eventBody();
    const raw = new TextEncoder().encode(body);

    const result = await ingress.handle(
      post(body, {
        "x-slack-request-timestamp": validTimestamp,
        "x-slack-signature": sign(raw, validTimestamp),
      }),
    );

    expect(result).toEqual({ status: 401, outcome: "rejected" });
  });

  it("refuses any method but POST", async () => {
    const { ingress } = makeIngress();

    const result = await ingress.handle({
      method: "GET",
      headers: new Headers(),
      rawBody: new Uint8Array(),
    });

    expect(result).toEqual({ status: 405, outcome: "rejected" });
  });
});
