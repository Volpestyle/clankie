import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tools: new Map<string, (args: Record<string, unknown>) => Promise<unknown>>(),
  awsPhase: "stopped",
  awsConstructed: 0,
  awsRefreshes: 0,
  starts: 0,
  tunnelStarts: 0,
}));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(
      name: string,
      _schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      mocks.tools.set(name, handler);
    }
    async connect() {}
    async close() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@clankie/credential-broker", () => ({ createDefaultCredentialStore: () => ({}) }));
vi.mock("../src/motor.ts", async (original) => {
  const actual = await original<typeof import("../src/motor.ts")>();
  return {
    ...actual,
    MinecraftMotor: class {
      async close() {}
    },
  };
});
vi.mock("../src/hosting.ts", async (original) => {
  const actual = await original<typeof import("../src/hosting.ts")>();
  return {
    ...actual,
    MinecraftHost: class {
      readonly dataDir = "/unused";
      phase = "stopped";
      status() {
        return {
          phase: this.phase,
          authReady: this.phase === "running",
          gamePort: 25684,
          botUsername: "ClankieLocal26",
          gameEndpoint: { port: 25684 },
        };
      }
      async configuration() {
        return { gamePort: 25684 };
      }
      async configure() {
        return this.configuration();
      }
      async start() {
        mocks.starts++;
        this.phase = "running";
        return this.status();
      }
      async stop() {
        this.phase = "stopped";
        return this.status();
      }
    },
  };
});
vi.mock("../src/aws-host.ts", () => ({
  AwsEc2Host: class {
    readonly dataDir = "/unused-aws";
    constructor() {
      mocks.awsConstructed++;
    }
    status() {
      return {
        phase: mocks.awsPhase,
        authReady: mocks.awsPhase === "running",
        gamePort: 25684,
        botUsername: "ClankieLocal26",
        gameEndpoint: { port: 25684 },
        publicAddress: "ec2.example.com:25565",
      };
    }
    async refresh() {
      mocks.awsRefreshes++;
      return this.status();
    }
    async configuration() {
      return { gamePort: 25684 };
    }
    async configure() {
      if (mocks.awsPhase !== "stopped") throw new Error("Stop Minecraft AWS instance before configuring it");
      return this.configuration();
    }
    async start() {
      mocks.starts++;
      mocks.awsPhase = "running";
      return this.status();
    }
    async stop() {
      mocks.awsPhase = "stopped";
      return this.status();
    }
  },
}));
vi.mock("../src/tunnel.ts", () => ({
  MinecraftTunnel: class {
    status() {
      return { phase: "stopped" };
    }
    async stop() {}
    async start() {
      mocks.tunnelStarts++;
    }
  },
}));
const backend = {
  kind: "aws-ec2",
  accountId: "123456789012",
  instanceId: "i-0123456789abcdef0",
  region: "us-east-1",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  vi.resetModules();
  mocks.tools.clear();
  mocks.awsPhase = "stopped";
  mocks.awsConstructed = 0;
  mocks.awsRefreshes = 0;
  mocks.starts = 0;
  mocks.tunnelStarts = 0;
  const dir = await mkdtemp(join(tmpdir(), "minecraft-host-selection-"));
  const argv = process.argv;
  const signals = ["SIGTERM", "SIGINT"] as const;
  const before = signals.map((signal) => process.listeners(signal));
  const stdinBefore = process.stdin.listeners("end");
  process.argv = [...argv, "--data-dir", dir];
  cleanups.push(async () => {
    process.argv = argv;
    signals.forEach((signal, i) => {
      for (const listener of process.listeners(signal))
        if (!before[i]!.includes(listener)) process.removeListener(signal, listener);
    });
    for (const listener of process.stdin.listeners("end"))
      if (!stdinBefore.includes(listener)) process.stdin.removeListener("end", listener as () => void);
    await rm(dir, { recursive: true, force: true });
  });
  await import("../src/main.ts");
  const call = (name: string, args: Record<string, unknown> = {}) => mocks.tools.get(name)!(args);
  return { dir, call };
}
it("persists stopped AWS selection without starting it and publishes only its public invite address", async () => {
  const f = await fixture();
  await f.call("host_configure", { settings: { backend } });
  expect(JSON.parse(await readFile(join(f.dir, "backend.json"), "utf8"))).toEqual(backend);
  expect(mocks.starts).toBe(0);
  await f.call("host_lifecycle", { operation: "start" });
  const status = await f.call("host_status");
  expect(status).toMatchObject({
    structuredContent: { gamePort: 25684, tunnel: { publicAddress: "ec2.example.com:25565" } },
  });
  expect(mocks.tunnelStarts).toBe(0);
  await expect(f.call("host_claim")).rejects.toThrow("does not use playit");
});
it("refuses a running target before persisting selection", async () => {
  const f = await fixture();
  mocks.awsPhase = "running";
  await expect(f.call("host_configure", { settings: { backend } })).rejects.toThrow(
    "Stop Minecraft AWS instance before configuring it",
  );
  await expect(readFile(join(f.dir, "backend.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(mocks.starts).toBe(0);
  expect(mocks.awsRefreshes).toBe(0);
});
it("serializes backend change behind lifecycle and refuses to abandon a running host", async () => {
  const f = await fixture();
  const starting = f.call("host_lifecycle", { operation: "start" });
  const switching = f.call("host_configure", { settings: { backend } });
  await starting;
  await expect(switching).rejects.toThrow("Stop Minecraft host before changing backend");
  expect(mocks.awsConstructed).toBe(0);
});
