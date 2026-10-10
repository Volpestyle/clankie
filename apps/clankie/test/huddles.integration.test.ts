import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { mintOperatorToken } from "@clankie/credential-broker";
import { HUDDLES_PATH, HuddleListSchema, HuddleSchema, type Huddle } from "@clankie/protocol/huddles";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createHuddleService, HuddleStore, type HuddleSeatTarget } from "../src/captain/huddles.ts";
import { formatHuddleBoard, runHuddleCommand } from "../../tui/src/command/huddle.ts";

/**
 * Huddles (VUH-2025, ADR 0221): the real store, service, HTTP routes and CLI.
 * The fleet is the boundary: which seats exist, the one request each seat
 * receives, and the lead's wake. Seats answer with exactly the text the
 * request asks them to send through message_clankie.
 */
const roots: string[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SEATS: HuddleSeatTarget[] = [
  { seatId: "term_a", title: "Odette", harness: "claude", workingDirectory: "/src/clankie" },
  { seatId: "term_b", title: "Tansy", harness: "claude", workingDirectory: "/src/clankie" },
  { seatId: "term_c", title: "Moss", harness: "codex", workingDirectory: "/src/clankie" },
  { seatId: "term_d", title: "Linnea", harness: "claude", workingDirectory: "/src/app" },
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-huddles-"));
  roots.push(root);
  const requests: { seatId: string; text: string; conversationId: string }[] = [];
  const wakes: { conversationId: string; text: string }[] = [];
  const huddles = createHuddleService({
    store: new HuddleStore(join(root, "huddles.json")),
    defaultConversation: () => "global-default",
    projectExists: async (project) => project === "clankie",
    seats: async (project) =>
      project === undefined ? SEATS : SEATS.filter((seat) => seat.workingDirectory === "/src/clankie"),
    deliver: async (seat, text, conversationId) => {
      requests.push({ seatId: seat.seatId, text, conversationId });
      return seat.seatId === "term_d" ? "offline" : "delivered";
    },
    wake: async (conversationId, text) => wakes.push({ conversationId, text }),
  });
  stops.push(() => huddles.stop());
  const token = mintOperatorToken();
  const app = await createClankieApp({
    captain: { ...createStubCaptain(), huddles },
    settings: new SettingsStore(join(root, "settings.json")),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "owner" } : undefined,
  });
  const client = {
    env: { CLANKIE_OPERATOR_TOKEN: token },
    host: "http://clankie.test",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
      app.app.fetch(new Request(String(url), init))) as typeof fetch,
  };
  /** A seat answering the way the request tells it to: message_clankie with one JSON block. */
  const answer = (seatId: string, huddle: Huddle, body: Record<string, unknown>) =>
    huddles.receive([seatId], `\`\`\`json\n${JSON.stringify({ huddle: huddle.id, ...body })}\n\`\`\``);
  return { root, huddles, app, client, requests, wakes, answer };
}

it("asks each seat once through the API and CLI, and compiles a landing order and blockers for the lead", async () => {
  const f = await fixture();
  expect((await f.app.app.request(HUDDLES_PATH)).status).toBe(401);

  const huddle = HuddleSchema.parse(await runHuddleCommand(["start", "--project", "clankie"], f.client));
  expect(huddle.seats.map((seat) => seat.seatId)).toEqual(["term_a", "term_b", "term_c"]);
  // One request per seat, naming the huddle and the three fields, asking it not to stop.
  expect(f.requests.map((request) => request.seatId)).toEqual(["term_a", "term_b", "term_c"]);
  for (const request of f.requests) {
    expect(request.conversationId).toBe("global-default");
    expect(request.text).toContain(huddle.id);
    expect(request.text).toContain("Do not stop or restart your work");
    expect(request.text).toMatch(/"on"[\s\S]*"blocked"[\s\S]*"landing"/u);
  }
  await expect(runHuddleCommand(["start", "--project", "nope"], f.client)).rejects.toThrow(
    /Unknown project/u,
  );

  // Ordinary output and other seats' answers are not huddle answers.
  expect(f.huddles.receive(["term_a"], "Landed VUH-1974, see commit 0128d85bc.")).toBeUndefined();
  expect(f.answer("term_z", huddle, { on: "x", blocked: null, landing: { files: [] } })).toBeUndefined();

  f.answer("term_b", huddle, {
    on: "VUH-2018 routines runner",
    blocked: "clankie heavy has 16 gates queued",
    blockerUrgent: true,
    landing: {
      files: ["apps/clankie/src/captain/captain.ts", "packages/protocol/src/routines.ts"],
      etaMinutes: 30,
    },
  });
  f.answer("term_a", huddle, {
    on: "VUH-1961 usage overlay",
    blocked: null,
    landing: {
      files: ["apps/clankie/src/captain/captain.ts", "apps/tui/src/command/usage.ts"],
      etaMinutes: 10,
    },
  });
  expect(f.wakes).toEqual([]);
  const last = f.answer("term_c", huddle, {
    on: "VUH-1866 landing gate timeout",
    blocked: "waiting for the owner to approve a release",
    landing: { files: ["scripts/check-landing.mjs"], eta: new Date(Date.now() + 20 * 60_000).toISOString() },
  })!;
  // The last answer compiles the board and wakes the lead once.
  await expect.poll(() => f.wakes.length).toBe(1);
  expect(last.landingOrder.map((step) => [step.title, step.after.map((after) => after.title)])).toEqual([
    ["Odette", []],
    ["Moss", []],
    ["Tansy", ["Odette"]],
  ]);
  expect(last.landingOrder[2]!.after[0]!.files).toEqual(["apps/clankie/src/captain/captain.ts"]);
  expect(last.blockers.map((blocker) => [blocker.title, blocker.urgent])).toEqual([
    ["Tansy", true],
    ["Moss", false],
  ]);
  expect(f.wakes[0]!.text).toContain("3 of 3 seats answered");
  expect(f.wakes[0]!.text).toContain("URGENT Tansy [term_b]: clankie heavy has 16 gates queued");
  expect(f.wakes[0]!.text).toContain("Urgent issue");
  // A later answer updates the board but never re-wakes.
  f.answer("term_a", huddle, { on: "VUH-1961 landed", blocked: null, landing: { files: [] } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.wakes).toHaveLength(1);

  // Every UI reads the same list; the CLI renders the board.
  const list = HuddleListSchema.parse(await runHuddleCommand([], f.client));
  expect(list.huddles[0]).toMatchObject({ id: huddle.id, status: "compiled" });
  const board = formatHuddleBoard(list.huddles[0]!);
  expect(board).toContain("3/3 answered");
  expect(board).toContain("Tansy");
  // Odette's later answer lands nothing, so Tansy no longer waits on her.
  expect(board).toContain("‼ clankie heavy has 16 gates queued");
  expect(board).not.toContain("← after");
  expect(JSON.stringify(list)).not.toMatch(/token|secret|bearer/iu);
});

it("closing a huddle tells the lead what arrived and who has not answered", async () => {
  const f = await fixture();
  const huddle = HuddleSchema.parse(await runHuddleCommand(["start"], f.client));
  expect(huddle.seats.map((seat) => [seat.seatId, seat.delivery])).toEqual([
    ["term_a", "delivered"],
    ["term_b", "delivered"],
    ["term_c", "delivered"],
    ["term_d", "offline"],
  ]);
  f.answer("term_a", huddle, { on: "VUH-1961", blocked: null, landing: { files: ["a.ts"] } });
  const closed = HuddleSchema.parse(await runHuddleCommand(["close", huddle.id], f.client));
  expect(closed.status).toBe("closed");
  expect(f.wakes).toHaveLength(1);
  expect(f.wakes[0]!.text).toContain("1 of 4 seats answered");
  expect(f.wakes[0]!.text).toContain("Linnea [term_d, offline]");
  // A closed huddle takes no more answers; they route as ordinary messages.
  expect(f.answer("term_b", huddle, { on: "x", blocked: null, landing: { files: [] } })).toBeUndefined();
  // The record survives a restart of the service.
  const reloaded = new HuddleStore(join(f.root, "huddles.json"));
  expect(reloaded.get(huddle.id)).toMatchObject({ status: "closed" });
});
