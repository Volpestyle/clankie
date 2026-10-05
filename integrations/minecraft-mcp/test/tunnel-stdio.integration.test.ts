import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MinecraftTunnelClaimStatusSchema } from "@clankie/protocol";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("real MCP process exposes noninteractive claim status and idle polling without provisioning", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "minecraft-claim-stdio-"));
  const client = new Client({ name: "minecraft-claim-integration", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "--data-dir", dataDir],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["host_claim", "host_claim_status", "host_claim_complete"]),
    );
    for (const name of ["host_claim_status", "host_claim_complete", "host_claim_status"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(MinecraftTunnelClaimStatusSchema.parse(result.structuredContent)).toEqual({
        phase: "idle",
        claimed: false,
      });
    }
    // No source download, agent allocation, permanent credential projection or Paper install.
    expect(await readdir(dataDir)).toEqual([]);
  } finally {
    await client.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// A real delayed Cargo build and HTTP exchange exercise request completion and
// the retained preparation job, without replacing process/filesystem/HTTP APIs.
test("claim preparation survives returned requests and reuses one real delayed Cargo build", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { createServer } = await import("node:http");
  const { writeFile, readFile, mkdir } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { MinecraftTunnel } = await import("../src/tunnel.ts");
  const run = promisify(execFile);
  const dataDir = await mkdtemp(join(tmpdir(), "minecraft-claim-cargo-"));
  const secret = "abcdef0123456789".repeat(4);
  let setups = 0;
  let exchanges = 0;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    expect(input.code).toMatch(/^[a-f0-9]{10}$/);
    const data =
      request.url === "/claim/setup"
        ? ++setups > 1
          ? "UserAccepted"
          : "WaitingForUser"
        : (++exchanges, { secret_key: secret });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "success", data }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("claim fixture listen failed");
  let installs = 0;
  try {
    await mkdir(join(dataDir, "src"));
    await writeFile(
      join(dataDir, "Cargo.toml"),
      '[package]\nname="claim-preparation-fixture"\nversion="0.1.0"\nedition="2021"\n',
    );
    await writeFile(join(dataDir, "src/main.rs"), "fn main() {}\n");
    await writeFile(
      join(dataDir, "build.rs"),
      "fn main() { std::thread::sleep(std::time::Duration::from_millis(750)); }\n",
    );
    const tunnel = new MinecraftTunnel({
      dataDir,
      originPort: 25684,
      authReady: () => false,
      credentials: {
        get: async () => null,
        set: async (value) => {
          await writeFile(join(dataDir, "broker-secret"), value, { mode: 0o600 });
        },
      },
      install: async () => {
        installs++;
        await run("cargo", ["build", "--release", "--offline"], {
          cwd: dataDir,
          env: {
            ...process.env,
            // Vitest isolates HOME; use the installed toolchain with a fixture-owned Cargo cache.
            RUSTUP_HOME: join((await import("node:os")).userInfo().homedir, ".rustup"),
            CARGO_HOME: join(dataDir, "cargo-home"),
          },
        });
        const binary = join(dataDir, "target/release/claim-preparation-fixture");
        const hash = createHash("sha256")
          .update(await readFile(binary))
          .digest("hex");
        await writeFile(join(dataDir, "binary.sha256"), hash);
        return binary;
      },
      api: async (path, input) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: "POST",
          body: JSON.stringify(input),
          headers: { "content-type": "application/json" },
        });
        const result = (await response.json()) as { data: unknown };
        return result.data;
      },
    });
    const before = performance.now();
    expect(await tunnel.prepareClaim()).toEqual({ phase: "preparing", claimed: false });
    expect(performance.now() - before).toBeLessThan(500);
    expect(await tunnel.prepareClaim()).toEqual({ phase: "preparing", claimed: false });
    expect(await tunnel.completeClaim()).toEqual({ phase: "preparing", claimed: false });
    expect(tunnel.claimStatus().phase).toBe("preparing");
    expect(installs).toBe(1);
    // The caller has completed. Cargo continues, then claim preparation publishes its URL.
    await expect.poll(() => tunnel.claimStatus().phase, { timeout: 10_000 }).toBe("pending");
    const ready = tunnel.claimStatus();
    expect(ready.claimUrl).toMatch(/^https:\/\/playit.gg\/claim\/[a-f0-9]{10}$/);
    expect(await tunnel.prepareClaim()).toEqual(ready);
    expect(installs).toBe(1);
    expect(setups).toBe(1);
    expect(await tunnel.completeClaim()).toEqual({ phase: "claimed", claimed: true });
    expect(await readFile(join(dataDir, "broker-secret"), "utf8")).toBe(secret);
    expect(await tunnel.prepareClaim()).toEqual({ phase: "claimed", claimed: true });
    expect(await tunnel.completeClaim()).toEqual({ phase: "claimed", claimed: true });
    expect(exchanges).toBe(1);
    expect(JSON.stringify([ready, tunnel.claimStatus()])).not.toContain(secret);
  } finally {
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dataDir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "verified completed playit builds are reused; changed bytes cannot be blessed",
  async () => {
    const { installedPlayit, PLAYIT_PIN } = await import("../src/tunnel.ts");
    const { writeFile, readFile, mkdir } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const dataDir = await mkdtemp(join(tmpdir(), "minecraft-playit-digest-"));
    const root = join(dataDir, `playit-${PLAYIT_PIN.commit}`);
    const binary = join(root, `playit-agent-${PLAYIT_PIN.commit}`, "target/release/playit-cli");
    try {
      await mkdir(join(binary, ".."), { recursive: true });
      const bytes = Buffer.from("completed binary fixture");
      const digest = createHash("sha256").update(bytes).digest("hex");
      await writeFile(binary, bytes);
      await writeFile(join(root, "binary.sha256"), digest);
      expect(await installedPlayit(dataDir)).toBe(binary);
      await writeFile(binary, "changed untrusted binary");
      await expect(installedPlayit(dataDir)).rejects.toThrow("playit-install-required");
      expect(await readFile(join(root, "binary.sha256"), "utf8")).toBe(digest);
      await rm(join(root, "binary.sha256"));
      await expect(installedPlayit(dataDir)).rejects.toThrow("playit-install-required");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
