import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
