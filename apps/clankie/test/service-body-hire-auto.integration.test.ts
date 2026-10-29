import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { afterEach, expect, it, vi } from "vitest";
import { autonomyLevelFleet } from "@clankie/protocol/autonomy";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { capabilities, leadChatFixture } from "./fixtures/lead-chats.ts";

// VUH-2975: an Auto round on a service-driven lead whose native source is gone.
// Only the model is a stand-in: the round's internal captain turn calls the real
// hire_agent tool from its own session tools, as a model would. The Auto policy,
// project policy and launch admission are the service's own.
type SessionTool = {
  readonly name: string;
  execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: never): Promise<unknown>;
};
const model = vi.hoisted(() => ({
  turn: async (_tools: readonly SessionTool[]): Promise<void> => {},
}));
vi.mock("../src/captain/model.ts", async (original) => ({
  ...(await original<typeof import("../src/captain/model.ts")>()),
  createCaptainModelRuntime: async () => ({
    runtime: {},
    resolveRoute: async () => ({
      selection: { model: { id: "fake", provider: "fake", contextWindow: 1000 }, thinkingLevel: "off" },
    }),
  }),
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession: async (options: { customTools?: readonly SessionTool[] }) => {
    const listeners = new Set<(event: unknown) => void>();
    const session = {
      isStreaming: false,
      state: { messages: [] },
      model: { id: "fake", provider: "fake", contextWindow: 1000 },
      thinkingLevel: "off",
      bindExtensions: async () => {},
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getContextUsage: () => undefined,
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      abort: async () => {},
      dispose: () => {},
      prompt: async () => {
        session.isStreaming = true;
        for (const listener of listeners) listener({ type: "agent_start" });
        try {
          await model.turn(options.customTools ?? []);
          for (const listener of listeners)
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Auto round handled" }],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
              },
            });
        } finally {
          session.isStreaming = false;
        }
      },
    };
    return { session };
  },
  DefaultResourceLoader: class {
    async reload() {}
    getExtensions() {
      return { extensions: [] };
    }
    getSkills() {
      return { skills: [] };
    }
  },
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  model.turn = async () => {};
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});

/**
 * A restarted service body whose old lead is gone runs one Auto round that hires
 * through a real adapter view. `occupants` is the complete local inventory once
 * Herdr lists the hire's own pane, before it reports a session.
 */
async function autoRound(
  occupants: (own: HerdrAgentSnapshot) => HerdrAgentSnapshot[],
  options: { readonly paused?: boolean } = {},
) {
  vi.useRealTimers();
  const allocate = "w7:p1";
  let local: HerdrAgentSnapshot[] | undefined;
  let launched = false;
  const shell: HerdrAgentSnapshot = {
    paneId: allocate,
    terminalId: "term_hire",
    agent: "shell",
    status: "idle",
    title: "Nessa",
  };
  let own = shell;
  const steps: string[] = [];
  const session = randomUUID();
  const adapter: HarnessSeatAdapter = {
    harness: "codex",
    attach: async () => undefined,
    start: async (_launch, view) => {
      await view.guard?.();
      steps.push("guard");
      own = { ...shell, agent: "codex", status: "working" };
      local = occupants(own);
      await view.guard?.();
      steps.push("startup guard");
      own = { ...own, session: { source: "herdr:codex", kind: "id", value: session } };
      local = local.map((agent) => (agent.paneId === allocate ? own : agent));
      const ref = { harness: "codex" as const, paneId: view.paneId, sessionId: session };
      await view.bound?.(ref);
      steps.push("bound");
      return { outcome: "started" as const, control: { ref } as SeatControl };
    },
  };
  const start = vi.spyOn(AutonomyStore.prototype, "start").mockImplementation(() => {});
  const f = await leadChatFixture(false, cleanup, {
    defaultLead: true,
    nativeSourceProof: true,
    inventoryAgents: () => local,
    projectHireIdentity: async (fleet, pane) =>
      fleet === "default" && pane === allocate && own.session !== undefined
        ? {
            nativeOccupantId: occupantIdForHerdrSession(own.session),
            fleet,
            pane,
            binding: { socketPath: join(tmpdir(), "fixture.sock") },
            processes: [{ pid: 22, startTime: "now" }],
            shell: { pid: 11, startTime: "earlier" },
          }
        : undefined,
    launch: {
      seatAdapters: [adapter],
      createTab: async () => {
        launched = true;
        return allocate;
      },
      pane: (paneId) => (launched && paneId === allocate ? own : undefined),
      tools: async () => [],
    },
  });
  await f.captain.pollSeatEvents(50, undefined, "global-default", capabilities);
  await mkdir(join(f.root, "clankie"));
  const directory = await realpath(join(f.root, "clankie"));
  await f.settings.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, ...autonomyLevelFleet("full") } },
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie",
          name: "Clankie",
          auto: true,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: directory }],
        },
      ],
    }),
  }));
  await f.captain.close();
  // The owner's Auto switch, as the restarted service reads it.
  await writeFile(
    join(f.root, "autonomy.json"),
    `${JSON.stringify({ schemaVersion: 1, enabled: options.paused !== true, conversations: {} })}\n`,
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  local = [];
  start.mockClear();
  f.open();
  vi.setSystemTime(Date.now() + 60_000);
  let hired: unknown;
  model.turn = async (tools) => {
    const tool = tools.find((candidate) => candidate.name === "hire_agent");
    if (tool === undefined) throw new Error("The Auto round has no hire_agent tool");
    try {
      const result = (await tool.execute(
        "auto-hire",
        {
          harness: "codex",
          effort: "medium",
          effortReason: "A bounded product fix with a current source proof.",
          title: "Nessa",
          role: "builder",
          projectId: "clankie",
          workingDirectory: directory,
          brief: "Own the bounded product result.",
        },
        undefined,
        undefined,
        {} as never,
      )) as { details?: unknown };
      hired = result.details;
    } catch (error) {
      hired = { thrown: error instanceof Error ? error.message : String(error) };
    }
  };
  const round = start.mock.calls[0]?.[0];
  if (round === undefined) throw new Error("The restarted service did not start Auto");
  await round("global-default", "Auto round: staff the routed project.");
  return { hired, steps, launched: () => launched };
}

it("lets an Auto round's own hire keep its startup occupant through guard and bound", async () => {
  const { hired, steps } = await autoRound((own) => [own]);
  expect(steps).toEqual(["guard", "startup guard", "bound"]);
  expect(hired).toBeDefined();
  expect(JSON.stringify(hired)).not.toContain("original agent has changed");
}, 30_000);

it("still refuses an Auto round's hire beside an unrelated session-less agent", async () => {
  const { hired, steps } = await autoRound((own) => [
    own,
    { paneId: "w8:p3", terminalId: "term_unknown", agent: "claude", status: "working", title: "Unrelated" },
  ]);
  expect(steps).toEqual(["guard"]);
  expect(JSON.stringify(hired)).toContain("original agent has changed");
}, 30_000);

it("refuses a paused Auto round's hire before any tab exists", async () => {
  const { hired, steps, launched } = await autoRound((own) => [own], { paused: true });
  expect(JSON.stringify(hired)).toContain("Auto is paused");
  expect(steps).toEqual([]);
  expect(launched()).toBe(false);
}, 30_000);
