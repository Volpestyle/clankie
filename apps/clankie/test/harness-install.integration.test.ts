// #737: the owner's app installs Claude Code or Codex with its vendor's own installer.
// The real service routes, device sessions and grants, settings and sign-in list run
// here; only the installer is a stand-in, so no vendor install ever runs on this Mac.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  HARNESS_LOGINS_PATH,
  HARNESS_LOGIN_INSTALL_PATH,
  type HarnessInstallResult,
} from "@clankie/protocol/harness-logins";
import { SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { runHarnessLoginCommand } from "../../tui/src/command/harness-login.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { HarnessInstalls, vendorInstaller, type VendorInstaller } from "../src/harness-installs.ts";
import { HarnessSignIns } from "../src/harness-logins.ts";

const installerScript = resolve(import.meta.dirname, "fixtures", "harness-installer.mjs");
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((step) => step()));

async function fixture(options: { mode?: string; realInstaller?: boolean; timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-install-"));
  // PATH is this empty directory alone: no real claude, codex, curl, Homebrew or npm
  // is found, so no vendor installer can ever run. The stand-in runs Node by path.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const env = { PATH: bin, HOME: root };
  const logins = new HarnessSignIns({ env });
  let mode = options.mode ?? "ok";
  const installs = new HarnessInstalls({
    env,
    logins,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.realInstaller
      ? {
          // The real lookup, guarded: should it ever find an installer here, the test
          // fails without running it, whatever the PATH.
          installer: async (harness): Promise<VendorInstaller | undefined> => {
            const found = await vendorInstaller(harness, env);
            if (found) throw new Error(`A test would have run ${found.line}`);
            return found;
          },
        }
      : {
          installer: async (harness): Promise<VendorInstaller> => ({
            line: `stub ${harness} installer`,
            command: process.execPath,
            args: [installerScript, bin, harness, mode],
          }),
        }),
  });
  const now = Date.now();
  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const token = (deviceId: string) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 600 }),
    );
  const events = (["control", "read"] as const).flatMap((deviceId) => {
    const grants = deviceId === "control" ? TAKE_CONTROL_GRANTS : SUPERVISE_GRANTS;
    const base = {
      occurredAt: new Date(now).toISOString(),
      missionId: `device:${deviceId}`,
      correlationId: "fixture",
      profileHash: "fixture",
    };
    return [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId,
          offerId: deviceId,
          name: deviceId,
          platform: "ios",
          offeredGrants: grants,
          mintedBy: "local-owner",
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: { schemaVersion: 1, deviceId, grants, sessionExpiresAt: new Date(now + 600_000).toISOString() },
      },
    ];
  });
  const log = join(root, "events.jsonl");
  writeFileSync(log, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const settings = new SettingsStore(join(root, "settings.json"));
  const service = await createClankieApp({
    settings,
    captain: createStubCaptain(),
    eventLogPath: log,
    deviceSessionKey: key,
    clock: () => new Date(now),
    harnessLogins: logins,
    harnessInstalls: installs,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(() => {
    service.close();
    installs.close();
    logins.close();
    rmSync(root, { recursive: true, force: true });
  });
  const tokens = { control: token("control"), read: token("read"), operator: "fixture-owner" };
  const call = async (path: string, bearer: string, body?: unknown) => {
    const response = await service.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as HarnessInstallResult & Record<string, unknown>,
    };
  };
  const settled = async (bearer = tokens.control) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const { body } = await call(HARNESS_LOGIN_INSTALL_PATH, bearer);
      if (body.ok && body.install.state !== "running") return body.install;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error("The install never finished");
  };
  const installed = async (harness: string) =>
    (
      (await call(HARNESS_LOGINS_PATH, tokens.control)).body as unknown as {
        harnesses: { harness: string; installed: boolean }[];
      }
    ).harnesses.find((entry) => entry.harness === harness)?.installed;
  return {
    bin,
    settings,
    tokens,
    call,
    settled,
    installed,
    service,
    mode: (next: string) => (mode = next),
  };
}

it("installs Claude Code for a Take Control device, with progress, one install at a time, and a fresh sign-in list", async () => {
  const f = await fixture({ mode: "hold" });
  expect(await f.installed("claude")).toBe(false);

  // A Supervise device and an unknown bearer are refused, and nothing starts.
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.read, { harness: "claude" })).status).toBe(403);
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, "nobody", { harness: "claude" })).status).toBe(401);
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control)).status).toBe(404);

  const started = await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, { harness: "claude" });
  expect(started.status).toBe(202);
  expect(started.body).toMatchObject({
    ok: true,
    install: {
      harness: "claude",
      state: "running",
      installer: "stub claude installer",
      ownerApproval: "not_claimed",
    },
  });

  // While it runs, another install is refused and shown the running one.
  let running = (await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control)).body;
  for (let attempt = 0; attempt < 200 && running.ok && running.install.progress.length < 2; attempt += 1) {
    await new Promise((done) => setTimeout(done, 25));
    running = (await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control)).body;
  }
  // Colour codes and carriage returns never reach the app.
  expect(running.ok && running.install.progress).toEqual(["Downloading the installer…", "Installing 9.9.9"]);
  const second = await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, { harness: "codex" });
  expect(second.status).toBe(409);
  expect(second.body).toMatchObject({
    ok: false,
    error: "busy",
    install: { harness: "claude", state: "running" },
  });

  writeFileSync(join(f.bin, "release"), "");
  const done = await f.settled();
  expect(done).toMatchObject({
    state: "succeeded",
    exitCode: 0,
    progress: expect.arrayContaining(["claude installed"]),
  });
  // The outcome carries the sign-in list read after the install, and the route agrees.
  expect(done.logins?.harnesses).toContainEqual({ harness: "claude", installed: true, signedIn: false });
  expect(await f.installed("claude")).toBe(true);
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, { harness: "claude" })).body).toEqual({
    ok: false,
    error: "already_installed",
  });
});

it("holds an install for the owner's approval while they keep machine setup", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    autonomy: { ...current.autonomy, fleet: { ...current.autonomy.fleet, machineSetup: "owner" } },
  }));
  const refused = await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, { harness: "codex" });
  expect(refused).toEqual({
    status: 403,
    body: { ok: false, error: "machine_setup_owner_approval_required" },
  });
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control)).status).toBe(404);

  const approved = await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, {
    harness: "codex",
    ownerApproved: true,
  });
  expect(approved.status).toBe(202);
  expect(await f.settled()).toMatchObject({ harness: "codex", state: "succeeded", ownerApproval: "claimed" });
  expect(await f.installed("codex")).toBe(true);
});

it("reports a failing installer, one that leaves no command, and a machine with no installer", async () => {
  const f = await fixture({ mode: "fail" });
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, { harness: "claude" })).status).toBe(
    202,
  );
  expect(await f.settled()).toMatchObject({
    state: "failed",
    error: "installer_failed",
    exitCode: 3,
    progress: expect.arrayContaining(["Checksum mismatch"]),
  });
  f.mode("noop");
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, { harness: "claude" })).status).toBe(
    202,
  );
  expect(await f.settled()).toMatchObject({ state: "failed", error: "not_found_after_install", exitCode: 0 });
  expect(await f.installed("claude")).toBe(false);

  // The real vendor installer lookup, on a PATH with no curl, Homebrew or npm: nothing runs.
  // Checked before the route, so a lookup that did find one fails here without running it.
  const bare = await fixture({ realInstaller: true });
  for (const harness of ["claude", "codex"] as const)
    expect(await vendorInstaller(harness, { PATH: bare.bin }, "darwin")).toBeUndefined();
  // With the tools present, the lookup names the vendors' own lines. These are empty
  // files that are only found, never run.
  const tools = join(bare.bin, "tools");
  mkdirSync(tools);
  for (const tool of ["curl", "brew", "npm"]) writeFileSync(join(tools, tool), "", { mode: 0o755 });
  expect((await vendorInstaller("claude", { PATH: tools }, "darwin"))?.line).toBe(
    "curl -fsSL https://claude.ai/install.sh | bash",
  );
  expect((await vendorInstaller("codex", { PATH: tools }, "darwin"))?.line).toBe("brew install --cask codex");
  expect((await vendorInstaller("codex", { PATH: tools }, "linux"))?.line).toBe(
    "npm install -g @openai/codex",
  );
  for (const harness of ["claude", "codex"])
    expect(await bare.call(HARNESS_LOGIN_INSTALL_PATH, bare.tokens.control, { harness })).toEqual({
      status: 409,
      body: { ok: false, error: "installer_unavailable" },
    });

  // Under the test runner the service itself refuses the vendor's installer, even where
  // the lookup finds one. Its only curl here is an empty file, so a regression stays offline.
  const unguarded = new HarnessInstalls({
    env: { PATH: tools, HOME: bare.bin },
    logins: {
      list: async () => ({
        harnesses: [
          { harness: "claude", installed: false, signedIn: false },
          { harness: "codex", installed: false, signedIn: false },
        ],
      }),
    },
  });
  await expect(unguarded.start("claude", "claimed")).rejects.toThrow(/stand-in installer/u);
  expect(unguarded.current()).toEqual({ ok: false, error: "install_not_found" });
});

it("ends an installer that ignores its timeout, so the next install is not held busy", async () => {
  const f = await fixture({ mode: "stuck", timeoutMs: 300 });
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, { harness: "claude" })).status).toBe(
    202,
  );
  expect(await f.settled()).toMatchObject({ state: "failed", error: "timed_out" });
  f.mode("ok");
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control, { harness: "claude" })).status).toBe(
    202,
  );
  expect(await f.settled()).toMatchObject({ state: "succeeded" });
}, 30_000);

it("the CLI installs with the operator credential, asking the owner to approve, and shows progress as it runs", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    autonomy: { ...current.autonomy, fleet: { ...current.autonomy.fleet, machineSetup: "owner" } },
  }));
  const options = {
    env: { CLANKIE_OPERATOR_TOKEN: f.tokens.operator },
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
      f.service.app.request(String(input), init)) as typeof fetch,
    pollMs: 10,
  };
  // A headless --approve is a flag, not the owner's consent: refused before any request.
  await expect(runHarnessLoginCommand(["login", "install", "codex", "--approve"], options)).rejects.toThrow(
    /headless --approve is refused/u,
  );
  expect((await f.call(HARNESS_LOGIN_INSTALL_PATH, f.tokens.control)).status).toBe(404);

  const told: string[] = [];
  const asked: string[] = [];
  const result = (await runHarnessLoginCommand(["login", "install", "codex", "--approve"], {
    ...options,
    tell: (text) => told.push(text),
    confirmApproval: async (detail) => void asked.push(detail),
  })) as HarnessInstallResult;
  expect(asked).toEqual(["Install Codex on the service's machine with its vendor's own installer."]);
  expect(result).toMatchObject({
    ok: true,
    install: { harness: "codex", state: "succeeded", ownerApproval: "claimed" },
  });
  expect(told).toEqual(["Downloading the installer…", "Installing 9.9.9", "codex installed"]);
});
