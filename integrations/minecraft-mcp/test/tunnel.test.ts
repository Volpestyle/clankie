import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MinecraftTunnel, PLAYIT_PIN } from "../src/tunnel.ts";

const agentId = "0d52a2f7-0c1b-46a6-8aef-e7551c4b0d41";
const tunnelId = "1d52a2f7-0c1b-46a6-8aef-e7551c4b0d41";
const secret = "abcdef0123456789".repeat(4);
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(
  options: { ready?: boolean; claimed?: boolean; proxy?: string; owned?: boolean } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "minecraft-tunnel-test-"));
  dirs.push(dataDir);
  let created = options.owned ?? false;
  if (created) await writeFile(join(dataDir, "playit-tunnel-id"), tunnelId);
  const tunnelData = {
    id: tunnelId,
    display_address: "example.gl.joinmc.link:12345",
    port_type: "tcp",
    port_count: 1,
    tunnel_type: "minecraft-java",
    disabled_reason: null,
    agent_config: {
      fields: [
        { name: "local_ip", value: "127.0.0.1" },
        { name: "local_port", value: "25684" },
        { name: "proxy_protocol", value: options.proxy ?? "proxy-protocol-v2" },
      ],
    },
  };
  const api = vi.fn(async (path: string) => {
    if (path === "/v1/agents/rundata") return { agent_id: agentId, tunnels: created ? [tunnelData] : [] };
    if (path === "/v1/tunnels/create") {
      created = true;
      return { id: tunnelId };
    }
    if (path === "/claim/setup") return "UserAccepted";
    if (path === "/claim/exchange") return { secret_key: secret };
    throw new Error("remote secret body must not escape");
  });
  const credentials = {
    get: vi.fn(async () => (options.claimed === false ? null : secret)),
    set: vi.fn(async (_value: string) => {}),
  };
  const children: ChildProcess[] = [];
  const launch = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("exit", 0));
        return true;
      }),
    }) as unknown as ChildProcess;
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const authReady = vi.fn(() => options.ready !== false);
  const install = vi.fn(async () => "/pinned/playit");
  const host = new MinecraftTunnel({
    dataDir,
    originPort: 25684,
    credentials,
    authReady,
    api,
    launch,
    install,
  });
  return { host, api, credentials, launch, install, authReady, children, dataDir, tunnelData };
}

describe("Minecraft playit tunnel", () => {
  test("pinned official source and claim return no permanent credential", async () => {
    const f = await fixture();
    const claim = await f.host.prepareClaim();
    expect(f.api).toHaveBeenCalledWith(
      "/claim/setup",
      expect.objectContaining({ version: `playit ${PLAYIT_PIN.version}` }),
    );
    expect(claim.claimUrl).toMatch(/^https:\/\/playit.gg\/claim\/[a-f0-9]{10}$/);
    expect(await f.host.completeClaim()).toEqual({ claimed: true });
    expect(f.credentials.set).toHaveBeenCalledWith(secret);
    expect(JSON.stringify([claim, f.host.status()])).not.toContain(secret);
    await expect(f.host.completeClaim()).rejects.toThrow("playit-claim-expired");
  });
  test("never installs, allocates or starts a tunnel before the auth gate", async () => {
    const f = await fixture({ ready: false });
    expect(await f.host.start()).toEqual({ phase: "failed", error: "playit-auth-not-ready" });
    expect(f.api).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });
  test("explicit blocked-on-claim status performs no external tunnel operation", async () => {
    const f = await fixture({ claimed: false });
    expect(await f.host.start()).toEqual({ phase: "blocked-on-claim" });
    expect(f.api).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });
  test("dedicated tunnel requires actual active v1 proxy fields, not legacy metadata", async () => {
    const f = await fixture({ owned: true, proxy: "none" });
    expect(await f.host.start()).toEqual({ phase: "failed", error: "playit-tunnel-unsafe" });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.api.mock.calls.map(([path]) => path)).toEqual(["/v1/agents/rundata"]);
  });
  test("owns one tunnel, projects a private secret and confirms exact process stop", async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([f.host.start(), f.host.start()]);
    expect(one).toEqual(two);
    expect(one).toEqual({ phase: "running", publicAddress: "example.gl.joinmc.link:12345", tunnelId });
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.api).toHaveBeenCalledWith(
      "/v1/tunnels/create",
      expect.objectContaining({
        origin: {
          type: "agent",
          data: {
            agent_id: agentId,
            config: {
              fields: [
                { name: "local_ip", value: "127.0.0.1" },
                { name: "local_port", value: "25684" },
                { name: "proxy_protocol", value: "proxy-protocol-v2" },
              ],
            },
          },
        },
      }),
      secret,
    );
    const secretPath = join(f.dataDir, "playit-runtime/agent.secret");
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.dataDir, "playit-runtime"))).mode & 0o777).toBe(0o700);
    expect(await readFile(secretPath, "utf8")).toBe(secret);
    expect(JSON.stringify(f.launch.mock.calls)).not.toContain(secret);
    expect(await f.host.stop()).toEqual({ phase: "stopped" });
    await expect(stat(secretPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("a pending allocation is polled without allocating another tunnel", async () => {
    const f = await fixture();
    let lists = 0;
    f.api.mockImplementation(async (path) => {
      if (path === "/v1/tunnels/create") return { id: tunnelId };
      if (path === "/v1/agents/rundata")
        return { agent_id: agentId, tunnels: ++lists >= 3 ? [f.tunnelData] : [] };
      throw new Error("unexpected API path");
    });
    expect((await f.host.start()).phase).toBe("running");
    expect(f.api.mock.calls.filter(([path]) => path === "/v1/tunnels/create")).toHaveLength(1);
    await f.host.stop();
  });
  test("crash retry checks auth again and never duplicates allocation", async () => {
    const f = await fixture({ owned: true });
    await f.host.start();
    f.authReady.mockReturnValue(false);
    f.children[0]?.emit("exit", 1);
    // Cleanup is asynchronous; let its file removal settle before advancing its timer.
    await vi.waitFor(() => expect(f.host.status().phase).toBe("backoff"));
    expect(f.host.status().publicAddress).toBeUndefined();
    await vi.waitFor(() => expect(f.host.status().phase).toBe("failed"), { timeout: 2000 });
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.api.mock.calls.map(([path]) => path)).toEqual(["/v1/agents/rundata"]);
    await f.host.stop();
  });
  test("malicious address or duplicated proxy field never reaches the invite", async () => {
    const f = await fixture({ owned: true });
    f.tunnelData.agent_config.fields.push({ name: "proxy_protocol", value: "proxy-protocol-v2" });
    expect((await f.host.start()).error).toBe("playit-tunnel-unsafe");
    const g = await fixture({ owned: true });
    g.tunnelData.display_address = "https://login.example/secret";
    expect((await g.host.start()).error).toBe("playit-tunnel-unsafe");
    expect(g.launch).not.toHaveBeenCalled();
  });
  test("losing the server auth gate stops the exact agent and withdraws its address", async () => {
    const f = await fixture({ owned: true });
    vi.useFakeTimers();
    await f.host.start();
    f.authReady.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() =>
      expect(f.host.status()).toEqual({ phase: "failed", error: "playit-health-unverified" }),
    );
    expect(f.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(stat(join(f.dataDir, "playit-runtime/agent.secret"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    vi.useRealTimers();
  });
  test("never runs an agent with unrelated active tunnel assignments", async () => {
    const f = await fixture();
    f.api.mockImplementation(async () => ({
      agent_id: agentId,
      tunnels: [{ ...f.tunnelData, id: agentId }],
    }));
    expect((await f.host.start()).error).toBe("playit-tunnel-unsafe");
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.api.mock.calls.map(([path]) => path)).toEqual(["/v1/agents/rundata"]);
  });
  test("a process error cannot falsely confirm termination", async () => {
    const f = await fixture({ owned: true });
    await f.host.start();
    f.children[0]?.emit("error", new Error("signal failed"));
    expect(f.host.status()).toEqual({ phase: "failed", error: "playit-process-error" });
    expect(await readFile(join(f.dataDir, "playit-runtime/agent.secret"), "utf8")).toBe(secret);
    expect(f.launch).toHaveBeenCalledTimes(1);
    await f.host.stop();
  });
  test("uncertain process termination never reports stopped or removes its credential projection", async () => {
    const f = await fixture({ owned: true });
    await f.host.start();
    vi.useFakeTimers();
    vi.mocked(f.children[0]!.kill).mockImplementation(() => false);
    const stopping = f.host.stop();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await stopping).toEqual({ phase: "failed", error: "playit-stop-unconfirmed" });
    expect(await readFile(join(f.dataDir, "playit-runtime/agent.secret"), "utf8")).toBe(secret);
    f.children[0]?.emit("exit", 0);
    vi.useRealTimers();
    await vi.waitFor(() => expect(f.host.status().phase).toBe("stopped"));
  });
  test("an uncertain allocation never dispatches another external create", async () => {
    const f = await fixture();
    f.api.mockImplementation(async (path) => {
      if (path === "/v1/agents/rundata") return { agent_id: agentId, tunnels: [] };
      throw new Error("allocation response lost");
    });
    expect((await f.host.start()).phase).toBe("failed");
    expect((await f.host.start()).error).toBe("playit-tunnel-unsafe");
    expect(f.api.mock.calls.filter(([path]) => path === "/v1/tunnels/create")).toHaveLength(1);
    expect(await readFile(join(f.dataDir, "playit-tunnel-id"), "utf8")).toBe("allocation-pending\n");
  });
  test("remote failure containing secrets is sanitized", async () => {
    const f = await fixture();
    f.api.mockRejectedValue(new Error(secret));
    await expect(f.host.prepareClaim()).rejects.toThrow("playit-claim-unavailable");
    expect(await f.host.start()).toEqual({ phase: "failed", error: "playit-start-failed" });
  });
});
