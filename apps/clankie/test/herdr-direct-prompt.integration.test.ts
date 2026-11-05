/**
 * ADR 0334: Herdr direct prompting. An owner's message to an agent with no
 * native channel and no hook receiver is typed into its terminal only while it
 * waits with an empty input line, and is confirmed only by its own session.
 * Fleet seat control, the on-disk delivery fence, the Claude transcript parser
 * and the pane-draft reader run for real, over input lines captured from real
 * Claude panes and a Claude JSONL in the shape Claude writes. Owner sends carry
 * what the service's operator path gives them: the session the sender saw, and
 * rediscovery on (ADR 0312).
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { parseHerdrSeatTranscript } from "@clankie/agent-transcript";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import type { PeerDeliveryOptions } from "../src/captain/peer-seat-messages.ts";
import { HerdrFleetError } from "../src/herdr-fleet.ts";
import { DIRECT_PROMPT_MAX } from "../src/captain/direct-prompt.ts";
import { codexProxyControl } from "../src/captain/external-codex-control.ts";

const SESSION = "0b3c4e9a-6f61-4c2b-9d0e-6c1f1e7a2b90";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const screen = (name: string) =>
  readFileSync(new URL(`./fixtures/pane-draft/${name}.ansi`, import.meta.url), "utf8");

function fixture(
  options: {
    harness?: "claude" | "pi";
    status?: string;
    absorbs?: boolean;
    failure?: "refused" | "ambiguous";
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "direct-prompt-"));
  roots.push(root);
  const path = join(root, `${SESSION}.jsonl`);
  writeFileSync(path, "");
  const user = (content: string) =>
    appendFileSync(
      path,
      `${JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION,
        timestamp: new Date().toISOString(),
        message: { role: "user", content },
      })}\n`,
    );
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "seat",
    agent: options.harness ?? "claude",
    status: options.status ?? "idle",
    title: "worker",
    session: { source: `herdr:${options.harness ?? "claude"}`, kind: "path", value: path },
    workingDirectory: root,
  };
  const typed: string[] = [];
  let ansi = screen(`${options.harness ?? "claude"}-empty`);
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    readPane: async () => ansi,
    transcript: async () => ({
      sessionKey: path,
      entries: parseHerdrSeatTranscript("claude", readFileSync(path, "utf8")),
    }),
    promptAgent: async (_pane, text) => {
      if (options.failure === "refused") throw new HerdrFleetError("blocked", "agent_blocked", "not_sent");
      typed.push(text);
      // Claude records a pasted prompt as an ordinary user turn with its exact text.
      if (options.absorbs !== false) user(text);
      if (options.failure === "ambiguous") throw new Error("Herdr agent prompt timed out after 5000 ms");
    },
  };
  const receipts = join(root, "receipts.json");
  const control = createFleetSeatControl(
    runner,
    new Map(),
    undefined,
    undefined,
    undefined,
    receipts,
    undefined,
    undefined,
    { directPromptConfirmMs: 1_500 },
  );
  return {
    control,
    typed,
    receipts,
    /** An owner's send, as the operator path clears it. */
    send: (text: string, extra: PeerDeliveryOptions = {}) =>
      control.deliverToSeat("seat", text, undefined, {
        directPrompt: { session: path },
        rediscover: true,
        ...extra,
      }),
    draft: () => {
      ansi = screen("claude-draft");
    },
    /** The agent's session records a user turn, as if it took one late. */
    user,
  };
}

test("an idle agent with no channel receives the owner's message typed, confirmed by its session", async () => {
  const f = fixture();
  const delivery = await f.send("Rebase onto main and rerun the landing gate.");
  expect(delivery).toMatchObject({
    outcome: "delivered",
    deliveryStage: "consumed",
    state: "started",
    messageId: expect.stringMatching(/^claude:/u),
  });
  expect(f.typed).toEqual(["Rebase onto main and rerun the landing gate."]);
  expect(new DeliveryFence(f.receipts).entries()).toEqual([]);
});

test("a half-typed draft in the input line is never joined to the message", async () => {
  const f = fixture();
  f.draft();
  const delivery = await f.send("status?");
  expect(delivery).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
  expect(delivery.detail).toMatch(/half-typed/u);
  expect(f.typed).toEqual([]);
});

test.each(["working", "blocked"])("a %s agent is not typed into", async (status) => {
  const f = fixture({ status });
  expect(await f.send("status?")).toMatchObject({ outcome: "undelivered" });
  expect(f.typed).toEqual([]);
});

test.each(["x".repeat(DIRECT_PROMPT_MAX + 1), "/clear", "!rm -rf build", "# remember this"])(
  "a message that is too long or would run as a command is refused before typing",
  async (text) => {
    const f = fixture();
    expect(await f.send(text)).toMatchObject({ outcome: "undelivered" });
    expect(f.typed).toEqual([]);
  },
);

test("Herdr's own refusal clears the receipt, so the next message can go", async () => {
  const f = fixture({ failure: "refused" });
  expect(await f.send("status?")).toMatchObject({ outcome: "undelivered" });
  expect(new DeliveryFence(f.receipts).entries()).toEqual([]);
});

test("a paste whose command didn't return cleanly is still confirmed by the session", async () => {
  const f = fixture({ failure: "ambiguous" });
  expect(await f.send("status?")).toMatchObject({ outcome: "delivered", deliveryStage: "consumed" });
  expect(f.typed).toEqual(["status?"]);
});

test("a typed message its session never shows stays uncertain and is not typed again by the same send", async () => {
  const f = fixture({ absorbs: false });
  const first = await f.send("status?");
  expect(first).toMatchObject({ outcome: "unconfirmed" });
  expect(first.detail).toMatch(/Read the agent before sending it again/u);
  expect(f.typed).toEqual(["status?"]);
  // Its receipt holds the next different message until the original settles.
  expect((await f.send("and the logs?")).outcome).not.toBe("delivered");
  expect(f.typed).toEqual(["status?"]);
});

test("only a message its sender cleared, for the session it saw, is typed", async () => {
  const f = fixture();
  // A peer's, a room's or any uncleared send.
  expect((await f.control.deliverToSeat("seat", "status?")).outcome).not.toBe("delivered");
  expect((await f.send("status?", { fence: Object.assign(async () => true, {}) })).outcome).not.toBe(
    "delivered",
  );
  expect((await f.send("status?", { directPrompt: { session: "/another/session.jsonl" } })).outcome).not.toBe(
    "delivered",
  );
  expect((await f.send("status?", { delivery: "steer" })).outcome).not.toBe("delivered");
  expect(f.typed).toEqual([]);
});

test("a Codex TUI with no reachable queue receives the owner's message typed, confirmed by its rollout", async () => {
  const root = mkdtempSync(join(tmpdir(), "direct-prompt-codex-"));
  roots.push(root);
  const rollout = join(root, `rollout-2026-11-01T18-00-00-${SESSION}.jsonl`);
  writeFileSync(rollout, "");
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p2",
    terminalId: "owner-codex",
    agent: "codex",
    status: "idle",
    title: "codex",
    session: { source: "herdr:codex", kind: "id", value: SESSION },
    workingDirectory: root,
  };
  const typed: string[] = [];
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    readPane: async () => screen("codex-empty"),
    // A plain TUI: no --remote endpoint, and no shared app server for the proxy to reach.
    paneProcesses: async () => [{ pid: 4242, name: "codex", argv: ["codex"] }],
    openFiles: async () => `n${rollout}\n`,
    codexQueue: async (sessionId, text, home, endpoint, beforeDispatch) =>
      (await codexProxyControl("/nonexistent/codex", [], 100, "queue")(
        sessionId,
        text,
        home,
        endpoint,
        beforeDispatch,
      )) ?? false,
    transcript: async () => ({
      sessionKey: rollout,
      entries: parseHerdrSeatTranscript("codex", readFileSync(rollout, "utf8")),
    }),
    promptAgent: async (_pane, text) => {
      typed.push(text);
      // Codex records a pasted prompt as a user message with its exact text.
      appendFileSync(
        rollout,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            id: randomUUID(),
            role: "user",
            content: [{ type: "input_text", text }],
            internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
          },
        })}\n`,
      );
    },
  };
  const control = createFleetSeatControl(
    runner,
    new Map(),
    undefined,
    undefined,
    undefined,
    join(root, "receipts.json"),
    undefined,
    undefined,
    { directPromptConfirmMs: 1_500 },
  );
  const send = (text: string, extra: PeerDeliveryOptions = {}) =>
    control.deliverToSeat("owner-codex", text, undefined, {
      directPrompt: { session: SESSION },
      rediscover: true,
      ...extra,
    });

  // An uncleared send keeps the queue's own reason and types nothing.
  const peer = await control.deliverToSeat("owner-codex", "status?");
  expect(peer).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
  expect(peer.detail).toMatch(/Codex queue unavailable/u);
  // A chosen Queue never falls back to typing either.
  expect((await send("status?", { delivery: "queue" })).outcome).toBe("undelivered");
  expect(typed).toEqual([]);

  const typedDelivery = await send("Pull main and rerun the tests.");
  expect(typedDelivery).toMatchObject({
    outcome: "delivered",
    deliveryStage: "consumed",
    state: "started",
  });
  expect(typed).toEqual(["Pull main and rerun the tests."]);
});

// #639: the transcript reader scrubs credential-shaped spans, so a message that merely
// mentions "password: …" reads back as "[REDACTED]". It is still the message: the
// scrubbed span is the only difference allowed, and any other change fails.
const MENTIONS_SECRET = "Sign in again; the password: hunter2 expired, so ask the owner.";

test("a message that mentions a password is confirmed by its session as the reader scrubs it", async () => {
  const f = fixture();
  expect(await f.send(MENTIONS_SECRET)).toMatchObject({ outcome: "delivered", deliveryStage: "consumed" });
  expect(f.typed).toEqual([MENTIONS_SECRET]);
  expect(new DeliveryFence(f.receipts).entries()).toEqual([]);
});

test("a session turn that differs outside the scrubbed span is not the message", async () => {
  const f = fixture({ absorbs: false });
  const first = f.send(MENTIONS_SECRET);
  f.user("Sign in again; the password: hunter2 expired, so ask the lead.");
  expect(await first).toMatchObject({ outcome: "unconfirmed" });
  // The original's receipt keeps both fingerprints, and still holds the recipient.
  expect(new DeliveryFence(f.receipts).entries().map(([, receipt]) => receipt)).toEqual([
    expect.objectContaining({ fingerprint: expect.any(String), scrubbedFingerprint: expect.any(String) }),
  ]);
  expect((await f.send("and the logs?")).outcome).not.toBe("delivered");
});

test("an uncertain original that later shows up scrubbed is settled, and the next message goes", async () => {
  const f = fixture({ absorbs: false });
  expect(await f.send(MENTIONS_SECRET)).toMatchObject({ outcome: "unconfirmed" });
  // The agent took it late; its session holds it scrubbed.
  f.user(MENTIONS_SECRET);
  f.typed.length = 0;
  // The original is settled from its session, never retyped, so the next message is typed.
  // (This session still records nothing new, so the next one waits on its own receipt.)
  expect(await f.send("and the logs?")).toMatchObject({ outcome: "unconfirmed" });
  expect(f.typed).toEqual(["and the logs?"]);
});

test("a message that is mostly credential is never confirmed by its scrubbed form", async () => {
  // Credential-only: it reads back as a bare "[REDACTED]", like any other credential-only turn.
  const bare = fixture({ absorbs: false });
  const sent = bare.send("password: hunter2");
  bare.user("api_key: sk-other-0123456789");
  bare.user("password: hunter2");
  expect(await sent).toMatchObject({ outcome: "unconfirmed" });
  expect(
    new DeliveryFence(bare.receipts).entries().map(([, receipt]) => receipt.scrubbedFingerprint),
  ).toEqual([undefined]);
  // Two messages that differ only in the secret's label read back the same; too little
  // survives around it to tell them apart, so neither confirms the other.
  const labelled = fixture({ absorbs: false });
  const original = labelled.send("password: hunter2 rotated now");
  labelled.user("api_key: hunter2 rotated now");
  expect(await original).toMatchObject({ outcome: "unconfirmed" });
});

test("a refused Pi attachment never falls back to the owner-cleared terminal prompt", async () => {
  const f = fixture({ harness: "pi" });
  expect(await f.send("Do not bypass native Pi admission.")).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "unavailable",
    detail: expect.stringContaining("Native Pi attachment could not be proved"),
  });
  expect(f.typed).toEqual([]);
});
