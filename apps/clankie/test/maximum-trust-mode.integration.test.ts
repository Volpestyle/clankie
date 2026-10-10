import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { MAXIMUM_TRUST_MODE_PATH, MaximumTrustModeSnapshotSchema } from "@clankie/protocol/owner-settings";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { createMaximumTrustModeRoutes } from "../src/maximum-trust-mode-routes.ts";
import { launchedWithMaximumTrust, readPaneForegroundArgv } from "../src/captain/herdr-census.ts";

it("maximum trust mode is off until the owner turns it on, and only the owner can (VUH-2048)", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximum-trust-mode-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    let allowed: true | "forbidden" | "authentication_required" = true;
    const app = createMaximumTrustModeRoutes(async () => allowed, settings);
    const request = (method: "GET" | "POST", body?: unknown) =>
      app.fetch(
        new Request(`http://owner.test${MAXIMUM_TRUST_MODE_PATH}`, {
          method,
          ...(body === undefined
            ? {}
            : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        }),
      );

    expect(MaximumTrustModeSnapshotSchema.parse(await (await request("GET")).json()).enabled).toBe(false);
    const on = await request("POST", { schemaVersion: 1, enabled: true });
    expect(on.status).toBe(200);
    expect(MaximumTrustModeSnapshotSchema.parse(await on.json()).enabled).toBe(true);
    expect((await new SettingsStore(settings.path).load()).maximumTrustMode).toBe(true);
    for (const body of [
      {},
      { schemaVersion: 1, enabled: "on" },
      { schemaVersion: 1, enabled: false, extra: 1 },
    ])
      expect((await request("POST", body)).status).toBe(400);

    // A worker, peer or room never holds owner authority: refused before any change.
    for (const refusal of ["forbidden", "authentication_required"] as const) {
      allowed = refusal;
      const status = refusal === "forbidden" ? 403 : 401;
      expect((await request("GET")).status).toBe(status);
      expect((await request("POST", { schemaVersion: 1, enabled: false })).status).toBe(status);
    }
    expect((await settings.load()).maximumTrustMode).toBe(true);

    allowed = true;
    const off = await request("POST", { schemaVersion: 1, enabled: false });
    expect(MaximumTrustModeSnapshotSchema.parse(await off.json()).enabled).toBe(false);
    expect((await settings.load()).maximumTrustMode).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reaches hosted owner devices through the operator allowlist", () => {
  expect(hostedOperatorAllows("GET", MAXIMUM_TRUST_MODE_PATH)).toBe(true);
  expect(hostedOperatorAllows("POST", MAXIMUM_TRUST_MODE_PATH)).toBe(true);
  expect(hostedOperatorAllows("DELETE", MAXIMUM_TRUST_MODE_PATH)).toBe(false);
});

it("names the live seats still on the other mode after a switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "maximum-trust-seats-"));
  try {
    const seats = [
      { seatId: "term_lead", title: "Clankie", harness: "claude", maximumTrust: false },
      { seatId: "term_kh2", title: "KH2 worker", harness: "codex", maximumTrust: true },
    ];
    const app = createMaximumTrustModeRoutes(
      async () => true,
      new SettingsStore(join(root, "settings.json")),
      async () => seats,
    );
    const post = async (enabled: boolean) =>
      MaximumTrustModeSnapshotSchema.parse(
        await (
          await app.fetch(
            new Request(`http://owner.test${MAXIMUM_TRUST_MODE_PATH}`, {
              method: "POST",
              body: JSON.stringify({ schemaVersion: 1, enabled }),
              headers: { "content-type": "application/json" },
            }),
          )
        ).json(),
      );
    expect((await post(true)).seatsOnOtherMode?.map((seat) => seat.seatId)).toEqual(["term_lead"]);
    expect((await post(false)).seatsOnOtherMode?.map((seat) => seat.seatId)).toEqual(["term_kh2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads a seat's launch mode from the flags Herdr reports for its pane", async () => {
  // Trimmed from `herdr pane process-info` for a hired Claude pane on 2026-10-10.
  const processInfo = (argv: readonly string[]) =>
    JSON.stringify({
      result: {
        process_info: {
          pane_id: "w47:p2D",
          shell_pid: 19241,
          foreground_process_group_id: 57714,
          foreground_processes: [
            { pid: 7594, argv: ["caffeinate", "-i", "-t", "300"], name: "caffeinate" },
            { pid: 57714, argv, name: "2.1.296" },
          ],
        },
      },
    });
  const read = (argv: readonly string[]) =>
    readPaneForegroundArgv("w47:p2D", {
      runCommand: async (command, args) => {
        expect([command, ...args]).toEqual(["herdr", "pane", "process-info", "--pane", "w47:p2D"]);
        return { stdout: processInfo(argv), stderr: "" };
      },
    });
  const claude = ["claude", "--resume", "4a836a8e-7beb-4b08-ac1c-e5eed4bde796", "--channels"];
  expect(
    launchedWithMaximumTrust("claude", (await read([...claude, "--dangerously-skip-permissions"]))!),
  ).toBe(true);
  expect(launchedWithMaximumTrust("claude", (await read([...claude, "--permission-mode", "auto"]))!)).toBe(
    false,
  );
  const codex = ["codex", "-c", 'approval_policy="never"', "--remote", "ws://127.0.0.1:4500"];
  expect(
    launchedWithMaximumTrust("codex", (await read([...codex, "-c", 'sandbox_mode="danger-full-access"']))!),
  ).toBe(true);
  expect(launchedWithMaximumTrust("codex", (await read(codex))!)).toBe(false);
  expect(
    launchedWithMaximumTrust("grok", (await read(["grok", "--permission-mode", "bypassPermissions"]))!),
  ).toBe(true);
  expect(launchedWithMaximumTrust("pi", (await read(["pi"]))!)).toBeUndefined();
  expect(
    await readPaneForegroundArgv("w47:p2D", {
      runCommand: async () => ({ stdout: processInfo(claude).replace("w47:p2D", "w1:p1"), stderr: "" }),
    }),
  ).toBeUndefined();
});
