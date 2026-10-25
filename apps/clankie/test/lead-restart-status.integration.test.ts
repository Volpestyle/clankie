import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { FLEET_LEAD_RESTART_PATH } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { registerLeadRestartRoutes } from "../src/app/lead-restart-routes.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { createLeadSeatRelaunch } from "../src/captain/lead-seat-relaunch.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { fleetStatus, formatLeadRestartLines } from "../../tui/src/command/fleet.ts";
import { fleetSettingsClient } from "../../tui/test/fixtures/fleet-settings-client.ts";

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
