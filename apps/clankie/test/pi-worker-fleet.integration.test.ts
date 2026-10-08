import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { createPiWorkerFleet } from "../src/captain/pi-worker-fleet.mjs";
import { bundlePiWorkerFleet } from "../../../scripts/release/pi-worker-fleet.mjs";
import { discoverPiNativeCapability } from "../src/captain/pi-native-capability.ts";

const nativeIt = it.skipIf(
  !["darwin", "linux"].includes(process.platform) ||
    !(process.env.PATH ?? "").split(delimiter).some((path) => existsSync(join(path, "pi"))),
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const tool = (
  name: string,
  description = "Advertised tool",
  inputSchema: Record<string, unknown> = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
) => ({ name, description, inputSchema });
async function fixture(mode = "tui", packaged = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-fleet-boundary-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json"),
    callsPath = join(root, "calls.jsonl");
  const state = {
    revision: 0,
    allowed: true,
    hang: false,
    exit: false,
    tools: [tool("message_clankie"), tool("clankie_call")],
  };
  const save = () => writeFile(statePath, JSON.stringify(state));
  await save();
  await writeFile(callsPath, "");
  // Drive the exact installed native SDK, not the captain's patched SDK.
  const capability = await discoverPiNativeCapability({ harness: "pi", cwd: root, brief: "" });
  const native = await import(
    /* @vite-ignore */ pathToFileURL(join(dirname(dirname(dirname(capability.cli))), "dist/index.js")).href
  );
  const validation = await import(
    /* @vite-ignore */ pathToFileURL(
      join(
        dirname(dirname(dirname(capability.cli))),
        "node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
      ),
    ).href
  );
  let factory = createPiWorkerFleet;
  if (packaged) {
    const releaseRoot = join(root, "release");
    const bundle = await bundlePiWorkerFleet(join(import.meta.dirname, "../../.."), releaseRoot);
    expect(
      Object.keys(bundle.metafile.inputs).some((path) => path.includes("@modelcontextprotocol/sdk")),
    ).toBe(true);
    factory = (
      await import(
        /* @vite-ignore */ pathToFileURL(join(releaseRoot, "apps/clankie/src/captain/pi-worker-fleet.mjs"))
          .href
      )
    ).createPiWorkerFleet;
  }
  const settings = native.SettingsManager.create(root, join(root, "profile"));
  settings.setProjectTrusted(true);
  let consumer: ReturnType<typeof createPiWorkerFleet>;
  let nativeApi: any;
  let admitted = true;
  const loader = new native.DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "profile"),
    settingsManager: settings,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (pi: any) => {
        nativeApi = pi;
        consumer = factory(pi, {
          transport: new StdioClientTransport({
            command: process.execPath,
            args: [join(import.meta.dirname, "fixtures/pi-fleet-mcp/server.mjs"), statePath, callsPath],
            stderr: "ignore",
          }),
          beforeCall: async () => {
            if (!admitted) throw new Error("Original controller refused");
          },
        });
      },
    ],
  });
  await loader.reload();
  const runtime = await native.ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error("No credential writes");
      },
      delete: async () => {
        throw new Error("No credential writes");
      },
    },
  });
  const { session } = await native.createAgentSession({
    cwd: root,
    agentDir: join(root, "profile"),
    settingsManager: settings,
    sessionManager: native.SessionManager.inMemory(root),
    resourceLoader: loader,
    modelRuntime: runtime,
    model: runtime.getModel("openai", "gpt-4o"),
  });
  cleanups.push(async () => {
    await consumer.close();
    session.dispose();
  });
  await session.bindExtensions({ mode });
  const calls = async () =>
    (await readFile(callsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const execute = async (name: string, args: unknown, signal?: AbortSignal) => {
    const definition = session.agent.state.tools.find((item: any) => item.name === name);
    if (!definition) throw new Error("Tool not active");
    const validated = validation.validateToolArguments(definition, { name, arguments: args });
    return definition.execute("native-call", validated, signal);
  };
  return {
    root,
    starts: () => readFile(callsPath + ".starts", "utf8"),
    settings,
    state,
    save,
    calls,
    session,
    execute,
    get api() {
      return nativeApi;
    },
    refuse: () => {
      admitted = false;
    },
  };
}

nativeIt(
  "projects paginated advertised schemas and preserves content, instructions and uncertain receipts on native Pi",
  async () => {
    const f = await fixture();
    expect(f.session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["read", "message_clankie", "clankie_call"]),
    );
    const def = f.session.extensionRunner.getToolDefinition("message_clankie");
    expect(def.parameters).toEqual(f.state.tools[0]!.inputSchema);
    expect(def.promptGuidelines).toEqual(["Fixture fleet tools keep native receipts."]);
    const result = await f.execute("message_clankie", { text: "worker result" });
    expect(result.content).toEqual([
      { type: "text", text: '{"text":"worker result"}' },
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "text", text: JSON.stringify({ outcome: "uncertain", receiptId: "original-uncertain" }) },
    ]);
    expect(result.details.mcp.structuredContent).toEqual({
      outcome: "uncertain",
      receiptId: "original-uncertain",
    });
    expect(await f.calls()).toEqual([{ name: "message_clankie", arguments: { text: "worker result" } }]);
  },
);
nativeIt("preserves a per-call refusal and its original receipt as a native tool error", async () => {
  const f = await fixture();
  f.state.allowed = false;
  await f.save();
  const result = await f.execute("message_clankie", { text: "blocked report" });
  expect(result.details.mcp.structuredContent).toEqual({ outcome: "refused", receiptId: "original-refusal" });
  const hook = await f.session.extensionRunner.emitToolResult({
    type: "tool_result",
    toolName: "message_clankie",
    toolCallId: "native-call",
    input: { text: "blocked report" },
    content: result.content,
    details: result.details,
    isError: false,
  });
  expect(hook.isError).toBe(true);
  expect(await f.calls()).toHaveLength(1);
});
nativeIt(
  "refreshes schemas, deactivates withdrawn tools and refuses held stale definitions without forwarding",
  async () => {
    const f = await fixture();
    const old = f.session.extensionRunner.getToolDefinition("message_clankie");
    f.state.tools = [
      tool("clankie_call", "Updated schema", {
        type: "object",
        properties: { receiptId: { type: "string" } },
        required: ["receiptId"],
        additionalProperties: false,
      }),
    ];
    f.state.revision++;
    await f.save();
    await expect.poll(() => f.session.getActiveToolNames()).not.toContain("message_clankie");
    expect(f.session.extensionRunner.getToolDefinition("clankie_call").parameters).toEqual(
      f.state.tools[0]!.inputSchema,
    );
    await expect(
      old.execute("old", { text: "stale" }, undefined, undefined, f.session.extensionRunner.createContext()),
    ).rejects.toThrow("no call was sent");
    expect(await f.calls()).toEqual([]);
  },
);
nativeIt("cancels one MCP call without replay or replacement", async () => {
  const f = await fixture();
  f.state.hang = true;
  await f.save();
  const abort = new AbortController();
  const pending = f.execute("message_clankie", { text: "one attempt" }, abort.signal);
  await expect.poll(async () => (await f.calls()).length).toBe(1);
  abort.abort();
  await expect(pending).rejects.toThrow("may have applied");
  expect(await f.calls()).toHaveLength(1);
});
nativeIt("refuses a lost original controller before MCP dispatch", async () => {
  const f = await fixture();
  f.refuse();
  await expect(f.execute("message_clankie", { text: "not sent" })).rejects.toThrow(
    "Original controller refused",
  );
  expect(await f.calls()).toEqual([]);
});
nativeIt("closes tools on native session replacement and never starts them for RPC mode", async () => {
  const f = await fixture();
  await f.session.extensionRunner.emit({ type: "session_before_switch" });
  expect(f.session.getActiveToolNames()).not.toContain("message_clankie");
  const rpc = await fixture("rpc");
  expect(rpc.session.getActiveToolNames()).not.toContain("message_clankie");
  expect(await rpc.calls()).toEqual([]);
});

nativeIt(
  "preserves owner-disabled tools during catalog refresh and stops all projected tools when the catalog is off",
  async () => {
    const f = await fixture();
    f.api.setActiveTools(f.session.getActiveToolNames().filter((name: string) => name !== "clankie_call"));
    f.state.tools[1]!.description = "Changed description";
    f.state.revision++;
    await f.save();
    await expect
      .poll(() => f.session.extensionRunner.getToolDefinition("clankie_call").description)
      .toBe("Changed description");
    expect(f.session.getActiveToolNames()).not.toContain("clankie_call");
    f.state.tools = [];
    f.state.revision++;
    await f.save();
    await expect.poll(() => f.session.getActiveToolNames()).not.toContain("message_clankie");
    expect(f.session.getActiveToolNames()).toContain("read");
    expect(await f.calls()).toEqual([]);
  },
);
nativeIt("honors native project trust and pre-dispatch cancellation without sending", async () => {
  const f = await fixture();
  f.settings.setProjectTrusted(false);
  await expect(f.execute("message_clankie", { text: "untrusted" })).rejects.toThrow("no call was sent");
  f.settings.setProjectTrusted(true);
  const abort = new AbortController();
  abort.abort();
  await expect(f.execute("message_clankie", { text: "cancelled" }, abort.signal)).rejects.toThrow();
  expect(await f.calls()).toEqual([]);
});

nativeIt("uses the native JSON-schema validator before MCP invocation", async () => {
  const f = await fixture();
  await expect(f.execute("message_clankie", {})).rejects.toThrow("Validation failed");
  expect(await f.calls()).toEqual([]);
});
nativeIt("closes on MCP process loss without starting a replacement or replaying a call", async () => {
  const f = await fixture();
  const old = f.session.extensionRunner.getToolDefinition("message_clankie");
  f.state.exit = true;
  await f.save();
  await expect.poll(() => f.session.getActiveToolNames()).not.toContain("message_clankie");
  await expect(
    old.execute("old", { text: "lost" }, undefined, undefined, f.session.extensionRunner.createContext()),
  ).rejects.toThrow("no call was sent");
  expect(await f.starts()).toBe("start\n");
  expect(await f.calls()).toEqual([]);
});
nativeIt("loads the actual release consumer asset without checkout dependencies", async () => {
  const f = await fixture("tui", true);
  const result = await f.execute("message_clankie", { text: "packaged report" });
  expect(result.details.mcp.structuredContent.receiptId).toBe("original-uncertain");
  expect(await f.calls()).toHaveLength(1);
});
