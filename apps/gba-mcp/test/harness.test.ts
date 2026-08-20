import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listGbaCheckpoints,
  readGbaCheckpoint,
  sha256,
  type BootedGbaGame,
  type GbaCoreSeam,
  type GbaCoreState,
} from "@clankie/gba-emulator";
import { createGbaMcpHarness, type GbaMcpHarness } from "../src/index.ts";

const scenarioBytes = readFileSync(
  new URL("../../../scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json", import.meta.url),
);
const scenario = {
  ...(JSON.parse(scenarioBytes.toString("utf8")) as BootedGbaGame["scenario"]),
  romSha256: "1".repeat(64),
  coreWasmSha256: "2".repeat(64),
};

function checkpointableGame(): BootedGbaGame {
  let x = 0;
  let frame = 0;
  let inputCount = 0;
  let facing: GbaCoreState["facing"] = "east";
  const stateBytes = (): Uint8Array => Buffer.from(JSON.stringify({ x, frame, inputCount, facing }));
  const core: GbaCoreSeam = {
    coreId: scenario.coreId,
    pressButton: (button, holdFrames) => {
      frame += holdFrames + 1;
      inputCount += 1;
      if (button === "right") {
        x += 1;
        facing = "east";
      } else if (button === "left") {
        x = Math.max(0, x - 1);
        facing = "west";
      }
      return Promise.resolve();
    },
    advanceFrames: (frames) => {
      frame += frames;
      return Promise.resolve();
    },
    gameState: () => ({
      mode: "overworld",
      inputReady: true,
      position: { mapId: "checkpoint-test", x, y: 0 },
      facing,
      dialogLineIndex: 0,
      dialogLines: [],
      menu: null,
      inventory: [],
      party: [],
      activePartySlot: 0,
      battle: null,
      frame,
      inputCount,
    }),
    ramStateSha256: () => sha256(stateBytes()),
    framebufferSha256: () => sha256(`frame:${String(frame)}`),
  };
  const bootSavestate = stateBytes();
  const identity = {
    romSha256: scenario.romSha256,
    savestateSha256: scenario.savestateSha256,
    coreWasmSha256: scenario.coreWasmSha256,
  };
  return {
    scenario,
    fixtureSha256: sha256(scenarioBytes),
    coreFactory: () => core,
    checkpoints: {
      saveState: stateBytes,
      loadState: (bytes) => {
        const saved = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
          x: number;
          frame: number;
          inputCount: number;
          facing: GbaCoreState["facing"];
        };
        ({ x, frame, inputCount, facing } = saved);
      },
      bootSavestate: () => bootSavestate,
      identity,
      scenario,
    },
    framePng: () => null,
    observeFrames: () => undefined,
    framebufferSha256: () => core.framebufferSha256(),
    real: true,
  };
}

async function connect(harness: GbaMcpHarness): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await harness.server.connect(serverTransport);
  const client = new Client({ name: "harness-test", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

async function connectStdio(): Promise<Client> {
  const packageDir = path.resolve(import.meta.dirname, "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(packageDir, "src/index.ts")],
    cwd: packageDir,
    env: getDefaultEnvironment(),
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-isolation-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function toolText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) return "";
  const content = (result as { content: unknown }).content as { type: string; text?: string }[];
  return content.find((part) => part.type === "text")?.text ?? "";
}

async function position(client: Client): Promise<{ mapId: string; x: number; y: number }> {
  const observed = await client.callTool({
    name: "gba_emulator_observe",
    arguments: { kind: "overworld" },
  });
  const observations = JSON.parse(toolText(observed)) as {
    kind: string;
    data: { position: { mapId: string; x: number; y: number } };
  }[];
  return observations.find((observation) => observation.kind === "overworld")!.data.position;
}

describe("isolated gba mcp harness", () => {
  it("removes temporary state when startup fails", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "gba-mcp-startup-"));
    const invalidScenario = path.join(parent, "invalid.json");
    writeFileSync(invalidScenario, "not json");
    await expect(createGbaMcpHarness({ GBA_MCP_SCENARIO_PATH: invalidScenario }, parent)).rejects.toThrow();
    expect(readdirSync(parent)).toEqual(["invalid.json"]);

    const invalidCheckpointDir = path.join(parent, "not-a-directory");
    writeFileSync(invalidCheckpointDir, "file");
    await expect(
      createGbaMcpHarness(
        { GBA_MCP_CHECKPOINT_DIR: invalidCheckpointDir, GBA_MCP_HARNESS_ID: "startup-test" },
        parent,
      ),
    ).rejects.toThrow();
    expect(readdirSync(parent).sort()).toEqual(["invalid.json", "not-a-directory"]);
  });

  it("gives each instance a private core, runtime, and lifecycle", async () => {
    const first = await createGbaMcpHarness({});
    const second = await createGbaMcpHarness({});
    const firstClient = await connect(first);
    const secondClient = await connect(second);
    expect(first.runtimeParent).not.toBe(second.runtimeParent);
    expect(first.sessionId).not.toBe(second.sessionId);

    await firstClient.callTool({
      name: "gba_emulator_start_action",
      arguments: { action: { kind: "button_press", button: "a", holdFrames: 4 } },
    });
    await first.close();
    expect(existsSync(first.runtimeParent)).toBe(false);

    const secondAction = await secondClient.callTool({
      name: "gba_emulator_start_action",
      arguments: { action: { kind: "button_press", button: "b", holdFrames: 4 } },
    });
    expect((secondAction.structuredContent as Record<string, unknown> | undefined)?.["status"]).toBe(
      "completed",
    );
    await second.close();
    expect(existsSync(second.runtimeParent)).toBe(false);
  });

  it("keeps two stdio child processes independent after one mutates and closes", async () => {
    const first = await connectStdio();
    const second = await connectStdio();
    const initial = await position(second);
    await first.callTool({
      name: "gba_emulator_start_action",
      arguments: { action: { kind: "button_press", button: "right", holdFrames: 4 } },
    });
    expect((await position(first)).x).toBe(initial.x + 1);
    expect(await position(second)).toEqual(initial);

    await first.close();
    const secondAction = await second.callTool({
      name: "gba_emulator_start_action",
      arguments: { action: { kind: "button_press", button: "right", holdFrames: 4 } },
    });
    expect((secondAction.structuredContent as Record<string, unknown> | undefined)?.["status"]).toBe(
      "completed",
    );
    expect((await position(second)).x).toBe(initial.x + 1);
    await second.close();
  });

  it("ignores shared-body configuration and creates no lock, activity, or credential artifacts", async () => {
    const isolated = await mkdtemp(path.join(tmpdir(), "gba-mcp-artifacts-"));
    const harness = await createGbaMcpHarness({
      XDG_DATA_HOME: isolated,
      XDG_STATE_HOME: isolated,
      CLANKIE_GBA_BODY_ROOT: path.join(isolated, "body"),
      CLANKIE_GBA_CHECKPOINT_DIR: path.join(isolated, "checkpoints"),
      CLANKIE_ACTIVITY_PRODUCER_URL: "ws://127.0.0.1:1/producer",
    });
    expect(readdirSync(isolated)).toEqual([]);
    await harness.close();
    expect(readdirSync(isolated)).toEqual([]);
  });

  it("has no access to Clankie's play voice boundary", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const sourceDirectory = new URL("../src/", import.meta.url);
    const source = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(new URL(name, sourceDirectory), "utf8"))
      .join("\n");
    expect(manifest.dependencies).not.toHaveProperty("@clankie/play-voice");
    expect(source).not.toContain("@clankie/play-voice");
  });

  it("removes default checkpoints but preserves an explicitly configured checkpoint directory", async () => {
    const persistent = await mkdtemp(path.join(tmpdir(), "gba-mcp-checkpoints-"));
    const temporary = await createGbaMcpHarness({});
    const temporaryCheckpointDir = temporary.checkpointDir;
    await temporary.close();
    expect(existsSync(temporaryCheckpointDir)).toBe(false);

    const configured = await createGbaMcpHarness({
      GBA_MCP_CHECKPOINT_DIR: persistent,
      GBA_MCP_HARNESS_ID: "persistent-test",
    });
    expect(configured.checkpointDir).not.toBe(persistent);
    writeFileSync(path.join(configured.checkpointDir, "keep"), "persistent");
    await configured.close();
    expect(existsSync(path.join(configured.checkpointDir, "keep"))).toBe(true);
  });

  it("requires a bounded harness id for persistent checkpoints", async () => {
    const persistent = await mkdtemp(path.join(tmpdir(), "gba-mcp-bounded-id-"));
    await expect(createGbaMcpHarness({ GBA_MCP_CHECKPOINT_DIR: persistent })).rejects.toThrow(
      "GBA_MCP_HARNESS_ID is required",
    );
    await expect(
      createGbaMcpHarness({
        GBA_MCP_CHECKPOINT_DIR: persistent,
        GBA_MCP_HARNESS_ID: "../other-harness",
      }),
    ).rejects.toThrow("GBA_MCP_HARNESS_ID must be 1-64");
    expect(readdirSync(persistent)).toEqual([]);
  });

  it("persists mutable core checkpoints only inside the matching harness namespace", async () => {
    const persistent = await mkdtemp(path.join(tmpdir(), "gba-mcp-namespaces-"));
    const boot = () => Promise.resolve(checkpointableGame());
    const first = await createGbaMcpHarness(
      { GBA_MCP_CHECKPOINT_DIR: persistent, GBA_MCP_HARNESS_ID: "alpha" },
      tmpdir(),
      boot,
    );
    const firstClient = await connect(first);
    await firstClient.callTool({
      name: "gba_emulator_start_action",
      arguments: { action: { kind: "button_press", button: "right", holdFrames: 4 } },
    });
    const saved = await firstClient.callTool({
      name: "gba_emulator_save_state",
      arguments: { label: "moved-right" },
    });
    const checkpointId = /saved checkpoint (\S+)/u.exec(toolText(saved))?.[1];
    expect(checkpointId).toBeDefined();
    await first.close();

    const resumed = await createGbaMcpHarness(
      { GBA_MCP_CHECKPOINT_DIR: persistent, GBA_MCP_HARNESS_ID: "alpha" },
      tmpdir(),
      boot,
    );
    const resumedClient = await connect(resumed);
    expect(resumed.checkpointDir).toBe(first.checkpointDir);
    expect((await position(resumedClient)).x).toBe(0);
    const listed = await resumedClient.callTool({ name: "gba_emulator_load_state", arguments: {} });
    expect(toolText(listed)).toContain(checkpointId);
    const loaded = await resumedClient.callTool({
      name: "gba_emulator_load_state",
      arguments: { checkpointId },
    });
    expect(loaded.isError).not.toBe(true);
    expect((await position(resumedClient)).x).toBe(1);

    const other = await createGbaMcpHarness(
      { GBA_MCP_CHECKPOINT_DIR: persistent, GBA_MCP_HARNESS_ID: "beta" },
      tmpdir(),
      boot,
    );
    const otherClient = await connect(other);
    expect(other.checkpointDir).not.toBe(first.checkpointDir);
    const otherList = await otherClient.callTool({ name: "gba_emulator_load_state", arguments: {} });
    expect(toolText(otherList)).toContain("no checkpoints");
    const crossLoad = await otherClient.callTool({
      name: "gba_emulator_load_state",
      arguments: { checkpointId },
    });
    expect(crossLoad.isError).toBe(true);
    expect(toolText(crossLoad)).toContain("checkpoint_not_found");

    expect(listGbaCheckpoints(persistent)).toEqual([]);
    expect(() =>
      readGbaCheckpoint({
        rootDir: persistent,
        checkpointId: checkpointId!,
        identity: checkpointableGame().checkpoints!.identity,
      }),
    ).toThrow("checkpoint_not_found");
    await resumed.close();
    await other.close();
  });
});
