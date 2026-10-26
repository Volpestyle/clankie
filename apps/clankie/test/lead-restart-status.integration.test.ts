import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { FLEET_LEAD_RESTART_PATH, parseProtocolResponse } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { registerLeadRestartRoutes } from "../src/app/lead-restart-routes.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { createLeadSeatRelaunch } from "../src/captain/lead-seat-relaunch.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { fleetStatus, formatLeadRestartLines } from "../../tui/src/command/fleet.ts";
import { fleetSettingsClient } from "../../tui/test/fixtures/fleet-settings-client.ts";
import { leadChatFixture } from "./fixtures/lead-chats.ts";
import { PreviousLeadRestartStatusSchema } from "./fixtures/lead-restart-status-v1.ts";

function statusReader(captain: Parameters<typeof registerLeadRestartRoutes>[1]["captain"]) {
  const app = new Hono();
  registerLeadRestartRoutes(app, {
    captain,
    authenticateOperator: createBearerAuthenticator("scratch-owner", { operatorId: "owner" }),
  });
  return async () => {
    const response = await app.request(FLEET_LEAD_RESTART_PATH, {
      headers: { authorization: "Bearer scratch-owner" },
    });
    expect(response.status).toBe(200);
    return response.json();
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  { tokens: 249_999, ageMs: 12 * 3_600_000 - 1, due: false },
  { tokens: 250_000, ageMs: 1_000, due: true },
  { tokens: 50_000, ageMs: 12 * 3_600_000, due: true },
])("checks the accepted lead budget at $tokens tokens / $ageMs ms", async ({ tokens, ageMs, due }) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-26T12:00:00Z");
  const f = await leadChatFixture(false, cleanup, {
    nativeSourceProof: true,
    defaultLead: true,
    leadRestartCheckMs: 25,
    beforeOpen: async (sessionId) => {
      const path = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-scratch", `${sessionId}.jsonl`);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        [
          { type: "user", timestamp: new Date(Date.now() - ageMs).toISOString() },
          { type: "assistant", message: { usage: { input_tokens: tokens } } },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
    },
  });
  await expect
    .poll(() => f.captain.leadRestartStatus!())
    .toMatchObject({ check: { contextTokens: tokens, due } });
  const response = await statusReader(f.captain)();
  const previousRead = parseProtocolResponse(PreviousLeadRestartStatusSchema, response);
  expect(previousRead.check).toMatchObject({ contextTokens: tokens, due });
  expect(response.unknownCheck).toBeUndefined();
  if (process.env.RESTART_COMPAT_OUTPUT)
    await appendFile(
      process.env.RESTART_COMPAT_OUTPUT,
      JSON.stringify({ scenario: "known", response, previousRead }) + "\n",
    );
  // No launcher in this census fixture: due checks refuse before asking for a brief.
  if (due)
    await expect
      .poll(() => f.captain.leadRestartStatus!())
      .toMatchObject({ waiting: { lastReason: "no_launch" } });
  else expect((await f.captain.leadRestartStatus!()).waiting).toBeUndefined();
});

// Production rounds, source proof, transcript discovery, persisted wait and
// authenticated status route. The named machine times out; uniqueness stays strict.
it.each(["source_unproven", "ambiguous", "missing", "empty"])(
  "records and exposes %s, and tells the owner once across two hours",
  async (scenario) => {
    const reason = scenario === "source_unproven" ? "source_unproven" : "usage_unreadable";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-26T12:00:00Z");
    const candidates: string[] = [];
    const f = await leadChatFixture(false, cleanup, {
      nativeSourceProof: true,
      defaultLead: true,
      leadRestartCheckMs: 25,
      ...(reason === "source_unproven" ? { slowFleetMs: 1 } : {}),
      beforeOpen: async (sessionId) => {
        if (scenario === "source_unproven" || scenario === "missing") return;
        for (const profile of scenario === "ambiguous" ? [".claude", ".claude-stale"] : [".claude"]) {
          const path = join(homedir(), profile, "projects", "-scratch", `${sessionId}.jsonl`);
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, "{}\n");
          candidates.push(path);
        }
      },
    });
    const status = statusReader(f.captain);
    await expect.poll(status).toMatchObject({
      budget: { contextTokens: 250_000, ageHours: 12 },
      unknownCheck: { at: expect.stringMatching(/^2026-10-26T12:00:0/u) },
      waiting: { lastReason: reason },
    });
    const first = await status();
    expect(first.check).toBeUndefined();
    const previousRead = parseProtocolResponse(PreviousLeadRestartStatusSchema, first);
    expect(previousRead.check).toBeUndefined();
    expect(previousRead.waiting?.lastReason).toBe(reason);
    if (process.env.RESTART_COMPAT_OUTPUT)
      await appendFile(
        process.env.RESTART_COMPAT_OUTPUT,
        JSON.stringify({ scenario, response: first, previousRead }) + "\n",
      );
    expect(formatLeadRestartLines(first)[0]).toContain("budget unknown");
    if (reason === "source_unproven") expect(first.waiting.lastDetail).toContain("inventory pc");
    else {
      for (const path of candidates) expect(first.waiting.lastDetail).toContain(path);
      if (scenario === "missing") expect(first.waiting.lastDetail).toContain("projects");
    }
    vi.setSystemTime("2026-10-26T14:00:00Z");
    await expect
      .poll(status)
      .toMatchObject({ waiting: { noticedAt: expect.stringMatching(/^2026-10-26T14:00:0/u) } });
    const noticedAt = (await status()).waiting.noticedAt;
    await f.captain.close();
    const reopened = f.open();
    await expect
      .poll(() => reopened.leadRestartStatus!())
      .toMatchObject({ waiting: { lastReason: reason, noticedAt } });
    const log = await readFile(join(f.root, "conversations", "global-default", "events.jsonl"), "utf8");
    expect(
      log.split("\n").filter((line) => line.includes("fresh restart check (ADR 0271) has been refused")),
    ).toHaveLength(1);
  },
);

// VUH-2821: `clankie fleet status` reads the lead seat's restart wait from the
// service route, over the same owner bearer as the fleet settings it already reads.
it("fleet status shows the lead seat's refused restart wait through the service route", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-lead-restart-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    const client = fleetSettingsClient(settings);
    // The real relaunch journal keeps the wait; only the pane and seat it never touches are stubs.
    let clock = Date.parse("2026-10-25T12:00:00.000Z");
    const notices: string[] = [];
    const relaunch = createLeadSeatRelaunch({
      journalPath: join(root, "lead-seat-relaunches.json"),
      seat: async () => undefined,
      paneShell: async () => ({ foreground: [] }),
      readPane: async () => "",
      runInPane: async () => {},
      idle: () => true,
      lastOwnerMessageAt: () => undefined,
      deliverBrief: async () => false,
      notice: (_conversation, text) => notices.push(text),
      now: () => clock,
    });
    relaunch.restartRefused("global-default", "draft_unknown");
    clock += 2 * 3_600_000;
    relaunch.restartRefused("global-default", "draft_unknown");
    const app = new Hono();
    registerLeadRestartRoutes(app, {
      captain: {
        ...createStubCaptain(),
        leadRestartStatus: async () =>
          relaunch.restartStatus({
            conversationId: "global-default",
            setting: "on",
            budget: { contextTokens: 500_000, ageMs: 24 * 3_600_000 },
            check: {
              at: "2026-10-25T14:00:00.000Z",
              contextTokens: 612_345,
              sessionStartedAt: "2026-10-06T17:00:00.000Z",
              due: true,
            },
          }),
      },
      authenticateOperator: createBearerAuthenticator(client.env.CLANKIE_OPERATOR_TOKEN, {
        operatorId: "owner",
      }),
    });
    const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(url)).pathname === FLEET_LEAD_RESTART_PATH
        ? app.fetch(new Request(String(url), init))
        : client.fetchImpl(url, init)) as typeof fetch;
    expect(notices).toHaveLength(1);
    expect(formatLeadRestartLines((await fleetStatus({ ...client, fetchImpl })).leadRestart)).toEqual([
      "lead restart: on · budget 500K tokens or 24h · 612K tokens, session since 2026-10-06T17:00:00.000Z, due (checked 2026-10-25T14:00:00.000Z)",
      "  refused since 2026-10-25T12:00:00.000Z: latest draft_unknown at 2026-10-25T14:00:00.000Z; draft_unknown ×2; owner told 2026-10-25T14:00:00.000Z",
    ]);
    // An older service without the read says so; the rest of the status stands.
    expect((await fleetStatus(client)).leadRestart).toMatchObject({ unavailable: expect.any(String) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
