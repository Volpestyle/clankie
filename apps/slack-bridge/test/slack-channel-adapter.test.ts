import type { CaptainChannelTurnResult, SlackChannelTurnRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import type { SlackEventCallback } from "../../relay/src/slack-webhook-protocol.ts";
import {
  SlackChannelAdapter,
  type SlackChannelEvidence,
  type SlackChannelOutcome,
} from "../src/slack-channel-adapter.ts";

const APP_USER_ID = "U0CLANKIE";

function event(overrides: Partial<SlackEventCallback["event"]> = {}, top: Partial<SlackEventCallback> = {}) {
  return {
    type: "event_callback" as const,
    team_id: "T1",
    event_id: "Ev1",
    event_time: 1_775_000_000,
    authorizations: [{ user_id: APP_USER_ID }],
    event: {
      type: "app_mention" as const,
      channel: "C1",
      user: "UJAMES",
      ts: "1775000000.000100",
      text: "<@U0CLANKIE> take a look at the failing migration",
      ...overrides,
    },
    ...top,
  } satisfies SlackEventCallback;
}

const settled: CaptainChannelTurnResult = {
  state: "settled",
  captainSessionId: "sess-1",
  turnId: "turn-1",
  response: "On it.",
};

function makeAdapter(
  result: CaptainChannelTurnResult = settled,
  overrides: Partial<ConstructorParameters<typeof SlackChannelAdapter>[0]> = {},
) {
  const submitted: SlackChannelTurnRequest[] = [];
  const posted: Array<{ channelId: string; threadTs: string; text: string }> = [];
  const evidence: SlackChannelEvidence[] = [];
  let sequence = 0;
  const adapter = new SlackChannelAdapter({
    api: {
      submitSlackCaptainChannelTurn: (request) => {
        submitted.push(request);
        return Promise.resolve(result);
      },
    },
    identity: { profileHash: "profile-abc", appUserId: APP_USER_ID },
    reply: {
      postMessage: (input) => {
        posted.push(input);
        return Promise.resolve();
      },
    },
    approvalSurfaceUrl: "https://clankie.bot/approvals",
    clock: () => 1_775_000_000_000,
    deliveryIdFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    evidence: (entry) => evidence.push(entry),
    ...overrides,
  });
  return { adapter, submitted, posted, evidence };
}

describe("SlackChannelAdapter", () => {
  it("turns a mention into one captain turn keyed on the thread", async () => {
    const { adapter, submitted, posted } = makeAdapter();

    const outcome = await adapter.handle(event());

    expect(outcome).toEqual({ status: "handled", disposition: "response" });
    expect(submitted[0]).toMatchObject({
      identity: { teamId: "T1", appUserId: APP_USER_ID, profileHash: "profile-abc" },
      conversation: { channelId: "C1", threadTs: "1775000000.000100", isDirectMessage: false },
      trigger: { kind: "app_mention", eventId: "Ev1", actorId: "UJAMES" },
    });
    expect(posted).toEqual([{ channelId: "C1", threadTs: "1775000000.000100", text: "On it." }]);
  });

  it("keeps a thread reply on the thread's own address", async () => {
    const { adapter, submitted } = makeAdapter();

    await adapter.handle(event({ type: "message", thread_ts: "1775000000.000001", ts: "1775000000.000200" }));

    expect(submitted[0]?.conversation.threadTs).toBe("1775000000.000001");
    expect(submitted[0]?.trigger.kind).toBe("thread_reply");
  });

  it("treats a direct message as addressed", async () => {
    const { adapter, submitted } = makeAdapter();

    await adapter.handle(event({ type: "message", channel_type: "im" }));

    expect(submitted[0]?.conversation.isDirectMessage).toBe(true);
    expect(submitted[0]?.trigger.kind).toBe("direct_message");
  });

  it("ignores an ordinary channel message nobody addressed to him", async () => {
    const { adapter, submitted } = makeAdapter();

    const outcome = await adapter.handle(
      event({ type: "message", text: "anyone up for lunch?", thread_ts: undefined }),
    );

    expect(outcome).toEqual({ status: "ignored", reason: "not_addressed" });
    expect(submitted).toEqual([]);
  });

  it("ignores bot messages and his own words", async () => {
    const { adapter, submitted } = makeAdapter();

    expect(await adapter.handle(event({ bot_id: "B1" }))).toEqual({
      status: "ignored",
      reason: "bot_message",
    });
    expect(await adapter.handle(event({ user: APP_USER_ID }, { event_id: "Ev2" }))).toEqual({
      status: "ignored",
      reason: "self_message",
    });
    expect(submitted).toEqual([]);
  });

  it("ignores an event authorized for a different app", async () => {
    const { adapter, submitted } = makeAdapter();

    const outcome = await adapter.handle(event({}, { authorizations: [{ user_id: "U0OTHERBOT" }] }));

    expect(outcome).toEqual({ status: "ignored", reason: "app_identity_mismatch" });
    expect(submitted).toEqual([]);
  });

  it("ignores message subtypes such as edits and joins", async () => {
    const { adapter, submitted } = makeAdapter();

    const outcome = await adapter.handle(event({ type: "message", subtype: "message_changed" }));

    expect(outcome).toEqual({ status: "ignored", reason: "unsupported_event" });
    expect(submitted).toEqual([]);
  });

  it("submits a retried delivery exactly once", async () => {
    const { adapter, submitted } = makeAdapter();

    const first = await adapter.handle(event());
    const retry = await adapter.handle(event());

    expect(first.status).toBe("handled");
    expect(retry).toEqual({ status: "ignored", reason: "duplicate_delivery" });
    expect(submitted).toHaveLength(1);
  });

  it("caps a channel inside the window", async () => {
    const { adapter, submitted } = makeAdapter(settled, { maxEventsPerChannel: 2 });

    await adapter.handle(event({}, { event_id: "Ev1" }));
    await adapter.handle(event({}, { event_id: "Ev2" }));
    const capped = await adapter.handle(event({}, { event_id: "Ev3" }));

    expect(capped).toEqual({ status: "ignored", reason: "channel_cap" });
    expect(submitted).toHaveLength(2);
  });

  it("links to the approval surface instead of taking approval in-thread", async () => {
    const { adapter, posted } = makeAdapter({
      state: "waiting_user",
      captainSessionId: "sess-1",
      turnId: "turn-1",
      prompt: "Deploying to production needs a sign-off.",
      approvalRequired: true,
    });

    const outcome = await adapter.handle(event());

    expect(outcome).toEqual({ status: "handled", disposition: "approval_requested" });
    expect(posted[0]?.text).toContain("https://clankie.bot/approvals");
  });

  it("relays an ordinary question without an approval link", async () => {
    const { adapter, posted } = makeAdapter({
      state: "waiting_user",
      captainSessionId: "sess-1",
      turnId: "turn-1",
      prompt: "Which branch did you mean?",
      approvalRequired: false,
    });

    const outcome = await adapter.handle(event());

    expect(outcome).toEqual({ status: "handled", disposition: "elicitation" });
    expect(posted[0]?.text).toBe("Which branch did you mean?");
  });

  it("writes nothing when he chose not to answer", async () => {
    const { adapter, posted } = makeAdapter({
      state: "silent",
      captainSessionId: "sess-1",
      turnId: "turn-1",
    });

    const outcome = await adapter.handle(event());

    expect(outcome).toEqual({ status: "handled", disposition: "silent" });
    expect(posted).toEqual([]);
  });

  it("says something went wrong rather than going quiet, and never leaks the code", async () => {
    const { adapter, posted } = makeAdapter({ state: "failed", code: "captain_session_exploded" });

    const outcome = await adapter.handle(event());

    expect(outcome).toEqual({ status: "handled", disposition: "failed" });
    expect(posted[0]?.text).not.toContain("captain_session_exploded");
    expect(posted[0]?.text.length).toBeGreaterThan(0);
  });

  it("records a failed reply without failing the turn", async () => {
    const { adapter, evidence } = makeAdapter(settled, {
      reply: { postMessage: () => Promise.reject(new Error("slack down")) },
    });

    const outcome: SlackChannelOutcome = await adapter.handle(event());

    expect(outcome.status).toBe("handled");
    expect(evidence.map((entry) => entry.outcome)).toContain("reply_failed");
  });

  it("emits evidence without the message body", async () => {
    const { adapter, evidence } = makeAdapter();

    await adapter.handle(event());

    expect(evidence.map((entry) => entry.outcome)).toEqual(["captain_submitted", "handled"]);
    expect(JSON.stringify(evidence)).not.toContain("failing migration");
  });
});
