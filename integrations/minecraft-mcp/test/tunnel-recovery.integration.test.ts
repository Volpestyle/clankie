import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MinecraftTunnel } from "../src/tunnel.ts";

const agentId = "00000000-0000-4000-8000-000000000001";
const tunnelId = "00000000-0000-4000-8000-000000000002";
const secret = "abcdef0123456789".repeat(4);
const originPort = 25684;
type ReadyTunnel = {
  id: string;
  internal_id: number;
  name: string;
  display_address: string;
  port_type: string;
  port_count: number;
  tunnel_type: string;
  tunnel_type_display: string;
  agent_config: { fields: { name: string; value: string }[] };
  disabled_reason: string | null;
};
// Actual successful AgentTunnelV1 response, with identity/address redacted.
const readyGolden = JSON.parse(
  await readFile(new URL("fixtures/playit-rundata-ready.redacted.json", import.meta.url), "utf8"),
) as { status: "success"; data: RunData };
const readyTunnel = readyGolden.data.tunnels[0]!;
const publicAddress = readyTunnel.display_address;
const fields = readyTunnel.agent_config.fields;
type RunData = {
  agent_id: string;
  tunnels: ReadyTunnel[];
  pending: {
    id: string;
    name: string;
    tunnel_type: string;
    tunnel_type_display: string;
    port_type: string;
    port_count: number;
    status_msg: string;
  }[];
  notices: unknown[];
  permissions: { is_self_managed: boolean; has_premium: boolean; account_status: string };
};

async function harness(
  mode:
    | "success"
    | "lost-response"
    | "lost-empty"
    | "held-create"
    | "rejected-once"
    | "version-registers"
    | "unverified",
) {
  const dataDir = await mkdtemp(join(tmpdir(), "minecraft-tunnel-recovery-"));
  const golden = JSON.parse(
    await readFile(
      new URL(
        mode === "unverified"
          ? "fixtures/playit-rundata-email-unverified.redacted.json"
          : "fixtures/playit-rundata.redacted.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { status: "success"; data: RunData };
  const rundata = structuredClone(golden.data);
  const rejectionGolden = JSON.parse(
    await readFile(new URL("fixtures/playit-create-rejection.redacted.json", import.meta.url), "utf8"),
  ) as { httpStatus: number; body: unknown };
  const versionRejectionGolden = JSON.parse(
    await readFile(
      new URL("fixtures/playit-create-agent-version-rejection.redacted.json", import.meta.url),
      "utf8",
    ),
  ) as { httpStatus: number; body: unknown };
  const successGolden = JSON.parse(
    await readFile(new URL("fixtures/playit-create-success.redacted.json", import.meta.url), "utf8"),
  ) as { httpStatus: number; body: unknown };
  if (mode !== "unverified") {
    rundata.permissions.account_status = "verified";
    rundata.notices = [];
  }
  const requests: string[] = [];
  let attempts = 0;
  let allocations = 0;
  let providerError: unknown;
  let releaseHeldCreate: () => void = () => {};
  const heldCreate = new Promise<void>((resolve) => {
    releaseHeldCreate = resolve;
  });
  const provider = createServer(async (request, response) => {
    try {
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Agent-Key ${secret}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/agents/rundata") {
        expect(input).toEqual({});
        response.end(JSON.stringify({ status: "success", data: rundata }));
        return;
      }
      expect(request.url).toBe("/v1/tunnels/create");
      expect(await readFile(join(dataDir, "playit-tunnel-id"), "utf8")).toBe("allocation-pending\n");
      // Native startup is required to register the agent's version/schema before allocation.
      await expect
        .poll(async () =>
          JSON.parse(await readFile(join(dataDir, "playit-runtime/fixture-start.json"), "utf8")),
        )
        .toMatchObject({ pid: expect.any(Number) });
      expect(input).toEqual({
        protocol: { type: "tunnel-type", details: "minecraft-java" },
        origin: { type: "agent", data: { agent_id: agentId, config: { fields } } },
        enabled: true,
        endpoint: { type: "region", details: { region: "global", port: null } },
        name: "Clankie Minecraft",
        firewall_id: null,
      });
      attempts++;
      if (mode === "rejected-once" && attempts === 1) {
        response.statusCode = rejectionGolden.httpStatus;
        response.end(JSON.stringify(rejectionGolden.body));
        return;
      }
      if (mode === "version-registers" && attempts === 1) {
        response.statusCode = versionRejectionGolden.httpStatus;
        response.end(JSON.stringify(versionRejectionGolden.body));
        return;
      }
      if (mode === "lost-empty") {
        // The transport cannot establish whether the upstream request committed.
        response.destroy();
        return;
      }
      if (mode === "held-create") await heldCreate;
      expect(allocations).toBe(0);
      allocations++;
      rundata.tunnels = [structuredClone(readyTunnel)];
      if (mode === "lost-response" && attempts === 1) {
        // The remote allocation committed, but the client never received its ID.
        response.destroy();
        return;
      }
      response.statusCode = successGolden.httpStatus;
      response.end(JSON.stringify(successGolden.body));
    } catch (error) {
      providerError = error;
      response.statusCode = 500;
      response.end(JSON.stringify({ status: "error", data: { type: "internal", data: {} } }));
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("tunnel provider listen failed");
  const binary = join(dataDir, "playit-process-fixture.cjs");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const secretPath = args[args.indexOf("--secret_path") + 1];
if (!/^[a-f0-9]{64}$/.test(fs.readFileSync(secretPath, "utf8"))) process.exit(2);
fs.writeFileSync(path.join(process.cwd(), "fixture-start.json"), JSON.stringify({pid: process.pid, args}));
fs.appendFileSync(path.join(process.cwd(), "fixture-starts"), process.pid + "\\n");
process.on("SIGTERM", () => {
  fs.writeFileSync(path.join(process.cwd(), "fixture-stopped"), "SIGTERM\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const tunnels: MinecraftTunnel[] = [];
  const restart = () => {
    const tunnel = new MinecraftTunnel({
      dataDir,
      originPort,
      credentials: { get: async () => secret, set: async () => {} },
      authReady: () => true,
      install: async () => binary,
      apiBase: `http://127.0.0.1:${address.port}`,
    });
    tunnels.push(tunnel);
    return tunnel;
  };
  return {
    dataDir,
    golden,
    rundata,
    requests,
    restart,
    attempts: () => attempts,
    allocations: () => allocations,
    releaseCreate: releaseHeldCreate,
    checkProvider: () => {
      if (providerError) throw providerError;
    },
    close: async () => {
      releaseHeldCreate();
      await Promise.all(tunnels.map((tunnel) => tunnel.stop()));
      await closeProvider(provider);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function closeProvider(provider: Server): Promise<void> {
  provider.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
}

async function assertRealProcess(tunnel: MinecraftTunnel, dataDir: string, starts = 1) {
  const runtime = join(dataDir, "playit-runtime");
  await expect
    .poll(async () => (await readFile(join(runtime, "fixture-starts"), "utf8")).trim().split("\n"))
    .toHaveLength(starts);
  await expect
    .poll(async () => JSON.parse(await readFile(join(runtime, "fixture-start.json"), "utf8")))
    .toEqual({
      pid: expect.any(Number),
      args: ["--secret_path", join(runtime, "agent.secret"), "--stdout", "start"],
    });
  expect((await stat(runtime)).mode & 0o777).toBe(0o700);
  expect((await readFile(join(runtime, "fixture-starts"), "utf8")).trim().split("\n")).toHaveLength(starts);
  expect((await stat(join(runtime, "agent.secret"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(runtime, "agent.secret"), "utf8")).toBe(secret);
  expect(JSON.stringify(tunnel.status())).not.toContain(secret);
  expect(await tunnel.stop()).toEqual({ phase: "stopped" });
  expect(await readFile(join(runtime, "fixture-stopped"), "utf8")).toBe("SIGTERM\n");
  await expect(stat(join(runtime, "agent.secret"))).rejects.toMatchObject({ code: "ENOENT" });
}

test("real HTTP create response lost after marker survives restart and adopts one allocation", async () => {
  const f = await harness("lost-response");
  try {
    const first = f.restart();
    expect(await first.start()).toEqual({ phase: "failed", error: "playit-api-unavailable" });
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe("allocation-pending\n");
    expect(await readFile(join(f.dataDir, "playit-runtime/fixture-stopped"), "utf8")).toBe("SIGTERM\n");
    await expect(stat(join(f.dataDir, "playit-runtime/agent.secret"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await first.stop();
    const restarted = f.restart();
    const [one, two] = await Promise.all([restarted.start(), restarted.start()]);
    expect(one).toEqual({ phase: "running", publicAddress, tunnelId });
    expect(two).toEqual(one);
    expect(f.attempts()).toBe(1);
    expect(f.allocations()).toBe(1);
    expect(f.rundata).toEqual(readyGolden.data);
    expect(f.requests).toEqual(["/v1/agents/rundata", "/v1/tunnels/create", "/v1/agents/rundata"]);
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe(`${tunnelId}\n`);
    await assertRealProcess(restarted, f.dataDir, 2);
    f.checkProvider();
  } finally {
    await f.close();
  }
});

test("recorded HTTP400 create rejection is safely reported, then restart clears marker and allocates once", async () => {
  const f = await harness("rejected-once");
  try {
    const first = f.restart();
    expect(await first.start()).toEqual({ phase: "failed", error: "playit-api-invalid-request" });
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe("allocation-pending\n");
    expect(await readFile(join(f.dataDir, "playit-runtime/fixture-stopped"), "utf8")).toBe("SIGTERM\n");
    await expect(stat(join(f.dataDir, "playit-runtime/agent.secret"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await first.stop();
    const restarted = f.restart();
    expect(await restarted.start()).toEqual({ phase: "running", publicAddress, tunnelId });
    expect(f.attempts()).toBe(2);
    expect(f.allocations()).toBe(1);
    expect(f.requests).toEqual([
      "/v1/agents/rundata",
      "/v1/tunnels/create",
      "/v1/agents/rundata",
      "/v1/tunnels/create",
      "/v1/agents/rundata",
    ]);
    await assertRealProcess(restarted, f.dataDir, 2);
    f.checkProvider();
  } finally {
    await f.close();
  }
});

test("another instance cannot allocate while the original HTTP create is still outstanding", async () => {
  const f = await harness("held-create");
  try {
    const first = f.restart();
    const firstStart = first.start();
    await expect.poll(() => f.attempts()).toBe(1);
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe("allocation-pending\n");
    const second = f.restart();
    expect(await second.start()).toEqual({
      phase: "failed",
      error: "playit-tunnel-allocation-pending",
    });
    expect(f.attempts()).toBe(1);
    expect(f.allocations()).toBe(0);
    f.releaseCreate();
    expect(await firstStart).toEqual({ phase: "running", publicAddress, tunnelId });
    expect(f.attempts()).toBe(1);
    expect(f.allocations()).toBe(1);
    await assertRealProcess(first, f.dataDir);
    f.checkProvider();
  } finally {
    await f.close();
  }
});

test("unknown create outcome stays pending when restart cannot yet see an allocation", async () => {
  const f = await harness("lost-empty");
  try {
    const first = f.restart();
    expect(await first.start()).toEqual({ phase: "failed", error: "playit-api-unavailable" });
    await first.stop();
    const restarted = f.restart();
    expect(await restarted.start()).toEqual({
      phase: "failed",
      error: "playit-tunnel-allocation-pending",
    });
    expect(f.attempts()).toBe(1);
    expect(f.requests.filter((path) => path === "/v1/tunnels/create")).toHaveLength(1);
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe("allocation-pending\n");
    expect(await readFile(join(f.dataDir, "playit-runtime/fixture-stopped"), "utf8")).toBe("SIGTERM\n");
    await expect(stat(join(f.dataDir, "playit-runtime/agent.secret"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    f.checkProvider();
  } finally {
    await f.close();
  }
});

test("create succeeds with the official request, response envelope, and full v1 rundata shape", async () => {
  const f = await harness("success");
  try {
    const tunnel = f.restart();
    expect(await tunnel.start()).toEqual({ phase: "running", publicAddress, tunnelId });
    expect(f.attempts()).toBe(1);
    expect(f.allocations()).toBe(1);
    expect(f.requests).toEqual(["/v1/agents/rundata", "/v1/tunnels/create", "/v1/agents/rundata"]);
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe(`${tunnelId}\n`);
    await assertRealProcess(tunnel, f.dataDir);
    f.checkProvider();
  } finally {
    await f.close();
  }
});

test("native startup precedes create and a recorded version rejection retries to one successful allocation", async () => {
  const f = await harness("version-registers");
  try {
    const tunnel = f.restart();
    expect(await tunnel.start()).toEqual({ phase: "running", publicAddress, tunnelId });
    expect(f.attempts()).toBe(2);
    expect(f.allocations()).toBe(1);
    expect(f.requests.filter((path) => path === "/v1/tunnels/create")).toHaveLength(2);
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe(`${tunnelId}\n`);
    await assertRealProcess(tunnel, f.dataDir);
    f.checkProvider();
  } finally {
    await f.close();
  }
});

test("another instance starting and stopping an owned tunnel preserves its live process and secret", async () => {
  const f = await harness("success");
  try {
    const first = f.restart();
    expect(await first.start()).toEqual({ phase: "running", publicAddress, tunnelId });
    const second = f.restart();
    expect(await second.start()).toEqual({
      phase: "failed",
      error: "playit-tunnel-allocation-pending",
    });
    expect(await second.stop()).toEqual({ phase: "stopped" });
    expect(first.status()).toEqual({ phase: "running", publicAddress, tunnelId });
    expect(await readFile(join(f.dataDir, "playit-runtime/agent.secret"), "utf8")).toBe(secret);
    expect(f.attempts()).toBe(1);
    expect(f.allocations()).toBe(1);
    await assertRealProcess(first, f.dataDir);
    f.checkProvider();
  } finally {
    await f.close();
  }
});

test("real redacted rundata golden reports the live email verification blocker without creating a tunnel", async () => {
  const f = await harness("unverified");
  try {
    const tunnel = f.restart();
    expect(await tunnel.start()).toEqual({ phase: "failed", error: "playit-email-verification-required" });
    expect(f.rundata).toEqual(f.golden.data);
    expect(f.requests).toEqual(["/v1/agents/rundata"]);
    expect(f.attempts()).toBe(0);
    await expect(stat(join(f.dataDir, "playit-tunnel-id"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(f.dataDir, "playit-runtime"))).rejects.toMatchObject({ code: "ENOENT" });
    f.checkProvider();
  } finally {
    await f.close();
  }
});

test("restart waits for a visible pending assignment and adopts it without creating again", async () => {
  const f = await harness("success");
  let allocationReady: ReturnType<typeof setTimeout> | undefined;
  try {
    await writeFile(join(f.dataDir, "playit-tunnel-id"), "allocation-pending\n", { mode: 0o600 });
    f.rundata.pending = [
      {
        id: tunnelId,
        name: "Clankie Minecraft",
        tunnel_type: "minecraft-java",
        tunnel_type_display: "Minecraft Java",
        port_type: "tcp",
        port_count: 1,
        status_msg: "Allocating public address",
      },
    ];
    allocationReady = setTimeout(() => {
      f.rundata.pending = [];
      f.rundata.tunnels = [structuredClone(readyTunnel)];
    }, 250);
    const restarted = f.restart();
    expect(await restarted.start()).toEqual({ phase: "running", publicAddress, tunnelId });
    expect(f.requests).toEqual(["/v1/agents/rundata", "/v1/agents/rundata"]);
    expect(f.attempts()).toBe(0);
    expect(f.allocations()).toBe(0);
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe(`${tunnelId}\n`);
    await assertRealProcess(restarted, f.dataDir);
    f.checkProvider();
  } finally {
    clearTimeout(allocationReady);
    await f.close();
  }
});

test.each(["ambiguous", "wrong-origin"] as const)(
  "restart preserves uncertainty and refuses %s matching-name assignments",
  async (scenario) => {
    const f = await harness("success");
    try {
      await writeFile(join(f.dataDir, "playit-tunnel-id"), "allocation-pending\n", { mode: 0o600 });
      f.rundata.tunnels = [structuredClone(readyTunnel)];
      if (scenario === "ambiguous") {
        f.rundata.tunnels.push({
          ...structuredClone(readyTunnel),
          id: "00000000-0000-4000-8000-000000000003",
          internal_id: 2,
        });
      } else {
        f.rundata.tunnels[0]!.agent_config.fields[1]!.value = "25565";
      }
      const restarted = f.restart();
      expect(await restarted.start()).toEqual({ phase: "failed", error: "playit-tunnel-unsafe" });
      expect(f.requests).toEqual(["/v1/agents/rundata"]);
      expect(f.attempts()).toBe(0);
      expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe("allocation-pending\n");
      await expect(stat(join(f.dataDir, "playit-runtime"))).rejects.toMatchObject({ code: "ENOENT" });
      f.checkProvider();
    } finally {
      await f.close();
    }
  },
);
