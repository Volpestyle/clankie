import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import type { CaptainModelRuntime } from "../src/captain/model.ts";
const capture = vi.hoisted(() => ({
  sessions: [] as AgentSession[],
  ordinary: vi.fn(),
  runtime: vi.fn(),
  operations: [] as unknown[],
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    DefaultResourceLoader: class {
      constructor() {
        capture.ordinary();
        throw Error("ordinary discovery forbidden");
      }
    },
    createAgentSession: async (...args: Parameters<typeof sdk.createAgentSession>) => {
      const result = await sdk.createAgentSession(...args);
      capture.sessions.push(result.session);
      return result;
    },
  };
});
vi.mock("../src/captain/model.ts", async (original) => ({
  ...(await original<typeof import("../src/captain/model.ts")>()),
  createCaptainModelRuntime: () => {
    capture.runtime();
    throw Error("ordinary credentials forbidden");
  },
}));
vi.mock("../../../scripts/evals/lead-native-capability.mjs", () => ({
  nativeRuntimeEvidence: () => ({
    codingHelper: {
      sha256: "fixture",
      supervisorSha256: "supervisor",
      descendantSettlement: { namespaceGone: true, noLateWrite: true },
    },
    source: { codingHelper: "fixture", codingSupervisor: "supervisor" },
    binaries: {
      "/usr/local/lib/lead-coding-helper.mjs": "fixture",
      "/usr/local/lib/lead-coding-supervisor.mjs": "supervisor",
    },
  }),
}));
// Explicit fixture origins only; real origin-chain/admission tests are separate.
vi.mock("../../../scripts/evals/lead-account-observer.mjs", () => ({
  assertLeadAccountObserver: (value: unknown) => value,
  observerCredential: (value: { selectedCredential(): unknown }) => value.selectedCredential(),
}));
vi.mock("../../../scripts/evals/lead-admission.mjs", () => ({
  assertLeadAdmission: (value: unknown) => value,
}));
vi.mock("../../../scripts/evals/lead-native-runtime.mjs", () => ({
  assertNativeFleet: (value: unknown) => value,
}));
// @ts-expect-error -- actual controller composition over explicitly fake capability/observer origins.
import { createLeadController } from "../../../scripts/evals/lead-controller.mjs";

function response(tool: boolean) {
  const item = tool
    ? {
        type: "function_call",
        id: "fc_fixture",
        call_id: "call_fixture",
        name: "read",
        arguments: '{"path":"notes.txt"}',
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_fixture",
        role: "assistant",
        content: [{ type: "output_text", text: "Fixture answer and summary", annotations: [] }],
        status: "completed",
      };
  const events = [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) },
    },
    ...(tool
      ? [{ type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments }]
      : [
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "Fixture answer and summary",
          },
        ]),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        model: "gpt-6-astra",
        output: [item],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("actual Captain builds Pi with inert resources, fenced fake Codex transport, contained read and compaction", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lead-captain-pi-fixture-"));
  const hostCwd = join(root, "tasks", "lead");
  mkdirSync(join(hostCwd, ".git"), { recursive: true });
  const run = new AbortController(),
    stop = vi.fn(async () => {
      run.abort();
    }),
    admit = vi.fn(async () => {});
  const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.unsigned-fixture`;
  const selectedCredential = async () => ({
    accountId: "account",
    accessToken: token,
    bindingSha256: "explicit-fake-observer",
  });
  const container = {
    id: "c".repeat(64),
    root,
    capability: {},
    signal: run.signal,
    stop,
    exec: async (_argv: string[], options: { input: string }) => {
      const operation = JSON.parse(options.input);
      capture.operations.push(operation);
      return JSON.stringify({
        result: operation.op === "read" ? { content: "contained fixture text" } : { ok: true },
        settlement: { complete: true, namespace: "pid:[42]", helperPid: 42, helperStart: "10" },
      });
    },
  };
  let calls = 0;
  const physical = vi.fn(async () => response(calls++ === 0));
  const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(physical);
  const ambientRefresh = vi.spyOn(ModelRuntime.prototype, "refresh").mockImplementation(async () => {
    throw Error("Ambient auth refresh forbidden");
  });
  const observer = {
    selectedCredential,
    assertReady: () => {},
    evidence: () => ({ accountId: "account", containerId: container.id }),
  };
  const admission = {
    accounts: ["account"],
    assertObservers: () => {},
    admit,
    assertCurrent: () => {
      if (run.signal.aborted) throw Error("revoked");
    },
    close: stop,
    evidence: () => ({ fixture: true }),
  };
  const controller = await createLeadController({
    container,
    observer,
    observers: [observer],
    admission,
    leadAllocation: { hostCwd, containerCwd: "/eval/tasks/lead", accountId: "account" },
    modelId: "gpt-6-astra",
    workerFleet: {
      slots: [
        {
          allocation: { hostCwd: join(root, "tasks", "worker"), accountId: "account" },
          runtime: { evidence: () => ({ started: false, ledger: { complete: false } }) },
        },
      ],
      captainOptions: {
        nativeLaunchPolicy: { prepare: vi.fn(), admit: vi.fn() },
        nativeHerdrRunner: { available: () => false },
        seatAdapters: [],
      },
    },
    resources: { systemPrompt: "fixed fixture context", agentsFiles: [] },
  });
  const models = controller.captainOptions.evalSessionBoundary.runtime as CaptainModelRuntime;
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      embodiment: { submitIntent: vi.fn(), getSession: vi.fn(), getLiveSession: vi.fn() },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      workingDirectory: hostCwd,
      stateDir: root,
      settings: new SettingsStore(join(root, "settings.json")),
      ...controller.captainOptions,
    },
  );
  try {
    const conversationId = captain.seatContext()!.conversationId;
    await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "send",
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: "fixture",
        expectedRevision: 0,
        message: "Read notes and reply\n" + "fixture context ".repeat(20_000),
      },
    });
    await vi.waitFor(() => expect(capture.sessions).toHaveLength(1));
    await vi.waitFor(() => expect(physical).toHaveBeenCalledTimes(2));
    const session = capture.sessions[0]!;
    await vi.waitFor(() => expect(session.isStreaming).toBe(false));
    expect(capture.operations).toEqual([
      { op: "access", path: "/eval/tasks/lead/notes.txt" },
      { op: "read", path: "/eval/tasks/lead/notes.txt" },
    ]);
    await session.prompt("Second fixture turn " + "recent fixture context ".repeat(20_000));
    await session.compact("summarize fixture");
    expect(physical).toHaveBeenCalledTimes(4);
    expect(controller.evidence().provider.complete).toBe(true);
    expect(capture.ordinary).not.toHaveBeenCalled();
    expect(capture.runtime).not.toHaveBeenCalled();
    expect(globalFetch).toHaveBeenCalledTimes(4);
    await Promise.resolve();
    expect(ambientRefresh).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(() => (models.runtime as any).registerProvider("escape", {})).toThrow("unavailable");
    const selection = await models.resolveSelection();
    expect(() =>
      models.runtime.streamSimple({ ...selection.model, baseUrl: "https://other.invalid" }, { messages: [] }),
    ).toThrow("mutated");
    expect(() => models.runtime.streamSimple(selection.model, { messages: [] }, { maxTokens: 1 })).toThrow(
      "cache",
    );
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

const ambientProcess = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Ambient process access forbidden in isolated Captain fixture");
  }),
);
afterEach(() => {
  expect(ambientProcess).not.toHaveBeenCalled();
  ambientProcess.mockClear();
});
// Test-local tripwire: an omitted native runner cannot reach live owner processes.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: ambientProcess,
  spawn: ambientProcess,
}));
