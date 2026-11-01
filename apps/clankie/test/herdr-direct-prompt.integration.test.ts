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

const SESSION = "0b3c4e9a-6f61-4c2b-9d0e-6c1f1e7a2b90";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const screen = (name: string) =>
  readFileSync(new URL(`./fixtures/pane-draft/${name}.ansi`, import.meta.url), "utf8");

function fixture(options: { status?: string; absorbs?: boolean; failure?: "refused" | "ambiguous" } = {}) {
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
    agent: "claude",
    status: options.status ?? "idle",
    title: "worker",
    session: { source: "herdr:claude", kind: "path", value: path },
    workingDirectory: root,
  };
  const typed: string[] = [];
  let ansi = screen("claude-empty");
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
