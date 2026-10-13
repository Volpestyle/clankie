import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, parseEnv } from "node:util";
import { expect, it } from "vitest";
import { ownProcess } from "../../../scripts/testing/owned-process.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const loader = join(root, "apps/clankie/node_modules/tsx/dist/loader.mjs");

const unsafeStacks = [
  ["clankie", {}],
  ["clankie", { PORT: "19001" }],
  ["clankie", { PORT: "4321", CLANKIE_RELAY_PORT: "19002" }],
  ["clankie", { PORT: "19001", CLANKIE_RELAY_PORT: "0" }],
  ["clankie", { PORT: "19001", CLANKIE_RELAY_PORT: "19002", CLANKIE_RELAY_URL: "http://localhost:4310" }],
  ["relay", {}],
  ["relay", { CLANKIE_RELAY_PORT: "19002" }],
  ["relay", { CLANKIE_RELAY_PORT: "19002", CLANKIE_CAPTAIN_URL: "http://localhost:19001" }],
  [
    "relay",
    {
      CLANKIE_RELAY_PORT: "4310",
      CLANKIE_CAPTAIN_URL: "http://localhost:19001",
      CLANKIE_CONTROL_PLANE_URL: "http://localhost:19001",
    },
  ],
  [
    "relay",
    {
      CLANKIE_RELAY_PORT: "19002",
      CLANKIE_CAPTAIN_URL: "http://localhost:4321",
      CLANKIE_CONTROL_PLANE_URL: "http://localhost:19001",
    },
  ],
] as const;

it.each(unsafeStacks)(
  "refuses %s scratch defaults/overrides %j before startup (VUH-1996)",
  async (service, overrides) => {
    const directory = await mkdtemp(join(tmpdir(), "scratch-refusal-"));
    try {
      const result = await exec(
        process.execPath,
        ["--import", loader, join(root, `apps/${service}/src/index.ts`)],
        {
          cwd: root,
          timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            CLANKIE_STATE: join(directory, "state"),
            CLANKIE_SCRATCH: "1",
            ...overrides,
          },
        },
      ).then(
        () => {
          throw new Error("Unsafe scratch entrypoint started");
        },
        (error: { stderr: string; code: number }) => error,
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("scratch_live_port_refused");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("boots a real paired scratch service and relay from one free-port preset (VUH-1996)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scratch-stack-"));
  const stops: Array<() => Promise<void>> = [];
  try {
    await exec(process.execPath, [join(root, "scripts/scratch-stack.mjs"), directory]);
    const env = parseEnv(await readFile(join(directory, "stack.env"), "utf8"));
    expect(new Set([env.PORT, env.CLANKIE_RELAY_PORT, env.CLANKIE_DEVICE_PORT]).size).toBe(3);
    for (const port of [env.PORT, env.CLANKIE_RELAY_PORT, env.CLANKIE_DEVICE_PORT]) {
      expect(["4310", "4321"]).not.toContain(port);
    }
    expect(env.CLANKIE_CAPTAIN_URL).toBe(env.CLANKIE_CONTROL_PLANE_URL);
    expect(env.CLANKIE_CAPTAIN_URL).toBe(`http://127.0.0.1:${env.PORT}`);
    expect(env.CLANKIE_RELAY_URL).toBe(`http://127.0.0.1:${env.CLANKIE_RELAY_PORT}`);
    for (const service of ["clankie", "relay"]) {
      const child = spawn(
        process.execPath,
        [join(root, "scripts/scratch-stack.mjs"), "run", directory, service],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            CLANKIE_RELAY_PORT: "4321",
            CLANKIE_CAPTAIN_URL: "http://127.0.0.1:4310",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      stops.push(ownProcess(child));
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      const url = service === "clankie" ? env.CLANKIE_CAPTAIN_URL : env.CLANKIE_RELAY_URL;
      const deadline = Date.now() + 30_000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`${service} exited: ${output}`);
        healthy = await fetch(`${url}/health`).then(
          (response) => response.ok,
          () => false,
        );
        if (healthy) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      expect(healthy, output).toBe(true);
    }
    const offerResponse = await fetch(`${env.CLANKIE_CAPTAIN_URL}/v1/pairing/offer`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CLANKIE_OPERATOR_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(offerResponse.status).toBe(200);
    const offer = (await offerResponse.json()) as { code: string };
    const redeemResponse = await fetch(`${env.CLANKIE_CAPTAIN_URL}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: offer.code, device: { name: "Scratch proof", platform: "ios" } }),
    });
    expect(redeemResponse.status).toBe(200);
    const pending = (await redeemResponse.json()) as { completionToken: string; offeredGrants: unknown };
    const completeResponse = await fetch(`${env.CLANKIE_CAPTAIN_URL}/v1/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        completionToken: pending.completionToken,
        acceptedGrants: pending.offeredGrants,
      }),
    });
    expect(completeResponse.status).toBe(200);
    const paired = (await completeResponse.json()) as { relayUrl: string; deviceToken: string };
    expect(paired.relayUrl).toBe(env.CLANKIE_RELAY_URL);
    const response = await fetch(`${paired.relayUrl}/v1/operator/host-settings`, {
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    expect(response.status).toBe(200);
    console.log(
      `Scratch proof: service ${env.PORT}, relay ${env.CLANKIE_RELAY_PORT}; paired relay ${paired.relayUrl}; settings ${response.status}`,
    );
  } finally {
    for (const stop of stops.reverse()) await stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it("uses normal private broker bootstrap for guarded scratch reads, preserving refusals and revocation (LOCAL-VUH-14)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scratch-broker-"));
  const original = await mkdtemp(join(tmpdir(), "scratch-env-only-"));
  const stops: Array<() => Promise<void>> = [];
  const evidence: Record<string, unknown> = {};
  try {
    await exec(process.execPath, [join(root, "scripts/scratch-stack.mjs"), original]);
    const originalText = await readFile(join(original, "stack.env"), "utf8");
    const rejected = await exec(
      process.execPath,
      [join(root, "scripts/scratch-stack.mjs"), "run", original, "cli", "project", "list"],
      { cwd: root, timeout: 20_000 },
    ).then(
      () => {
        throw new Error("Environment-only project read unexpectedly passed");
      },
      (error: { code: number; stderr: string }) => error,
    );
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("Project settings require the canonical operator credential");
    evidence.environmentOnlyRefusal = rejected.stderr;
    await expect(
      exec(process.execPath, [join(root, "scripts/scratch-stack.mjs"), original, "--broker-operator"]),
    ).rejects.toThrow("Broker-operator scratch root must be a new or empty directory");
    expect(await readFile(join(original, "stack.env"), "utf8")).toBe(originalText);
    const alias = join(original, "scratch-alias");
    await symlink(directory, alias);
    await expect(
      exec(process.execPath, [join(root, "scripts/scratch-stack.mjs"), alias, "--broker-operator"]),
    ).rejects.toThrow("Broker-operator scratch root must be a new or empty directory");
    await exec(process.execPath, [join(root, "scripts/scratch-stack.mjs"), directory, "--broker-operator"]);
    const env = parseEnv(await readFile(join(directory, "stack.env"), "utf8"));
    expect(env.CLANKIE_OPERATOR_TOKEN).toBeUndefined();
    expect(env.CLANKIE_CREDENTIALS_FILE).toBe(join(directory, "credentials.json"));
    expect(env.NODE_ENV).toBe("test");
    expect(env.CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY).toBe(join(directory, "fleet-resources"));
    expect(env.CLANKIE_CAPTAIN_URL).toBe(env.CLANKIE_CONTROL_PLANE_URL);
    expect(env.CLANKIE_RELAY_URL).toBe(`http://127.0.0.1:${env.CLANKIE_RELAY_PORT}`);
    expect(new Set([env.PORT, env.CLANKIE_RELAY_PORT, env.CLANKIE_DEVICE_PORT]).size).toBe(3);
    for (const port of [env.PORT, env.CLANKIE_RELAY_PORT, env.CLANKIE_DEVICE_PORT])
      expect(["4310", "4321"]).not.toContain(port);
    for (const service of ["clankie", "relay"]) {
      const child = spawn(
        process.execPath,
        [join(root, "scripts/scratch-stack.mjs"), "run", directory, service],
        {
          cwd: root,
          // These inherited live defaults must never enter the private child.
          env: {
            PATH: process.env.PATH,
            CLANKIE_OPERATOR_TOKEN: "unrelated-override",
            CLANKIE_CREDENTIALS_FILE: "/nonexistent/live-broker",
            CLANKIE_CAPTAIN_URL: "http://127.0.0.1:4310",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      stops.push(ownProcess(child));
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      const url = service === "clankie" ? env.CLANKIE_CAPTAIN_URL : env.CLANKIE_RELAY_URL;
      let healthy = false;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`${service} exited: ${output}`);
        healthy = await fetch(`${url}/health`).then(
          (response) => response.ok,
          () => false,
        );
        if (healthy) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      expect(healthy, output).toBe(true);
    }
    const cli = async <T>(...args: string[]): Promise<T> => {
      const result = await exec(
        process.execPath,
        [join(root, "scripts/scratch-stack.mjs"), "run", directory, "cli", ...args],
        { cwd: root, timeout: 30_000 },
      );
      return JSON.parse(result.stdout) as T;
    };
    const projects = await cli<{ settings: { projects: unknown[] } }>("project", "list");
    expect(projects.settings.projects).toEqual([]);
    const setupAuto = await cli<{ auto: string }>("auto", "off");
    expect(setupAuto.auto).toBe("off");
    const auto = await cli<{ auto: string }>("auto", "status");
    expect(auto.auto).toBe("off");
    const model = await cli<{
      settings: { selected: unknown; effective: unknown };
      providers: Record<string, unknown>;
    }>("model", "status");
    expect(model.settings.selected).toBeNull();
    expect(model.settings.effective).toBeNull();
    expect(model.providers).toEqual({});
    const devices = await cli<{ ok: boolean; devices: unknown[] }>("devices", "--json");
    expect(devices.ok).toBe(true);
    expect(devices.devices).toEqual([]);
    const body = await cli<{ leases: unknown[] }>("body", "status");
    expect(body.leases).toEqual([]);
    const tracker = await cli<{ repo: { backend?: string; needsDecision: boolean } }>(
      "work",
      "status",
      "--repo",
      directory,
    );
    expect(tracker.repo.backend).toBeUndefined();
    expect(tracker.repo.needsDecision).toBe(true);
    evidence.preflightBeforePairing = { projects, auto, model, devices, body, tracker };
    const broker = JSON.parse(await readFile(env.CLANKIE_CREDENTIALS_FILE!, "utf8"));
    const token = broker.clankie_operator.key as string;
    expect(token).toMatch(/^clankie_op_[A-Za-z0-9_-]{43}$/u);
    expect((await stat(env.CLANKIE_CREDENTIALS_FILE!)).mode & 0o777).toBe(0o600);
    const mismatch = await exec(
      process.execPath,
      ["--import", loader, join(root, "apps/tui/bin/clankie.ts"), "project", "list"],
      {
        cwd: root,
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          ...env,
          CLANKIE_OPERATOR_TOKEN: "mismatched-test-only",
          CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
        },
      },
    ).then(
      () => {
        throw new Error("Mismatched project read unexpectedly passed");
      },
      (error: { code: number; stderr: string }) => error,
    );
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stderr).toContain("Project settings require the canonical operator credential");
    evidence.mismatchRefusal = mismatch.stderr;
    const offerResponse = await fetch(`${env.CLANKIE_CAPTAIN_URL}/v1/pairing/offer`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(offerResponse.status).toBe(200);
    const offer = (await offerResponse.json()) as { code: string };
    const redeemResponse = await fetch(`${env.CLANKIE_CAPTAIN_URL}/v1/pairing/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: offer.code,
        device: { name: "Disposable broker proof", platform: "ios" },
      }),
    });
    expect(redeemResponse.status).toBe(200);
    const pending = (await redeemResponse.json()) as { completionToken: string; offeredGrants: unknown };
    const completeResponse = await fetch(`${env.CLANKIE_CAPTAIN_URL}/v1/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        completionToken: pending.completionToken,
        acceptedGrants: pending.offeredGrants,
      }),
    });
    expect(completeResponse.status).toBe(200);
    const paired = (await completeResponse.json()) as {
      relayUrl: string;
      deviceToken: string;
      deviceId: string;
    };
    expect(paired.relayUrl).toBe(env.CLANKIE_RELAY_URL);
    const settings = await fetch(`${paired.relayUrl}/v1/operator/host-settings`, {
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    expect(settings.status).toBe(200);
    await cli("devices", "revoke", paired.deviceId, "--json");
    const revoked = await fetch(`${paired.relayUrl}/v1/operator/host-settings`, {
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    expect(revoked.status).toBe(401);
    evidence.pairing = {
      offered: 200,
      redeemed: 200,
      completed: 200,
      relaySettings: settings.status,
      revokedSettings: revoked.status,
    };
    evidence.isolation = {
      brokerInsideScratch: true,
      fileMode: "0600",
      inheritedOverrideDiscarded: true,
      targetsMatch: true,
      normalFirstRunMint: true,
      paths: {
        root: directory,
        home: env.HOME,
        state: env.CLANKIE_STATE,
        settings: env.CLANKIE_SETTINGS_FILE,
        broker: env.CLANKIE_CREDENTIALS_FILE,
        config: env.XDG_CONFIG_HOME,
        resources: env.CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY,
      },
      targets: {
        service: env.CLANKIE_CAPTAIN_URL,
        controlPlane: env.CLANKIE_CONTROL_PLANE_URL,
        relay: env.CLANKIE_RELAY_URL,
        devicePort: env.CLANKIE_DEVICE_PORT,
      },
    };
    console.log("LOCAL-VUH-14 protected preflight and revocation:", JSON.stringify(evidence));
  } finally {
    for (const stop of stops.reverse()) await stop();
    await rm(directory, { recursive: true, force: true });
    await rm(original, { recursive: true, force: true });
  }
  await expect(access(join(directory, "credentials.json"))).rejects.toThrow();
  evidence.teardown = { processesStopped: true, scratchRootAndBrokerRemoved: true };
  if (process.env.LOCAL_VUH14_EVIDENCE_DIRECTORY) {
    await mkdir(process.env.LOCAL_VUH14_EVIDENCE_DIRECTORY, { recursive: true });
    await writeFile(
      join(process.env.LOCAL_VUH14_EVIDENCE_DIRECTORY, "proof.json"),
      JSON.stringify(evidence, null, 2),
    );
  }
}, 180_000);
