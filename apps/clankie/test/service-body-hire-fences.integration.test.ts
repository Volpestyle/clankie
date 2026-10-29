import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { HiredSeatRestarts } from "../src/captain/hired-seat-restart.ts";
import { capabilities, leadChatFixture } from "./fixtures/lead-chats.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});
const conversation = "global-default";
const changed = {
  outcome: "failed",
  reason: "not_ready",
  detail: expect.stringContaining("original agent has changed"),
};
const reachedLaunch = {
  outcome: "failed",
  reason: "harness_unavailable",
  control: { reason: "pane_run_unavailable" },
};
type Fixture = Awaited<ReturnType<typeof leadChatFixture>>;

/** The lead's native seat polls once; the default chat leads one Auto project. */
async function routed(f: Fixture) {
  await f.captain.pollSeatEvents(50, undefined, conversation, capabilities);
  await mkdir(join(f.root, "clankie"));
  const directory = await realpath(join(f.root, "clankie"));
  await f.settings.update((current) => ({
    ...current,
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
  return directory;
}

async function hire(service: Fixture["captain"], directory: string) {
  const bank = await service.laneToolBank("operator", conversation);
  const result = await bank.tools
    .find((tool) => tool.name === "hire_agent")!
    .call({
      harness: "codex",
      effort: "medium",
      effortReason: "A bounded product fix with a current source proof.",
      title: "Nessa",
      role: "builder",
      projectId: "clankie",
      workingDirectory: directory,
      brief: "Own the bounded product result.",
    });
  const text = result.content.find((part) => part.type === "text");
  return JSON.parse(text?.type === "text" ? text.text : "null") as Record<string, unknown>;
}

it("refuses after a restart while the head receipt journal is unresolved and no presence remains", async () => {
  let gone = false;
  const f = await leadChatFixture(false, cleanup, {
    defaultLead: true,
    nativeSourceProof: true,
    projectHireIdentity: async () => undefined,
    inventoryAgents: () => (gone ? [] : undefined),
  });
  const directory = await routed(f);
  await f.captain.close();
  const journal = join(f.root, "delivery-receipts", "head", `${encodeURIComponent(conversation)}.json`);
  // As after the launcher's explicit release: presence is removed, the receipt journal is not.
  await rm(`${journal}.presence`, { force: true });
  await mkdir(join(f.root, "delivery-receipts", "head"), { recursive: true });
  await writeFile(
    journal,
    `${JSON.stringify({ "lead-delivery": { messageId: "lead-delivery", fingerprint: "unresolved", beganAt: 1 } })}\n`,
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  gone = true;
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat");
  const uncertain = f.open();
  vi.setSystemTime(Date.now() + 60_000);
  expect(await hire(uncertain, directory)).toMatchObject(changed);
  expect(spawn).not.toHaveBeenCalled();
  // Control: the same restart without that journal reaches native admission.
  await uncertain.close();
  await rm(journal, { force: true });
  const settled = f.open();
  vi.setSystemTime(Date.now() + 60_000);
  expect(await hire(settled, directory)).toMatchObject(reachedLaunch);
  expect(spawn).toHaveBeenCalledOnce();
}, 30_000);

it("refuses while the native seat still holds the lane after its bound grace", async () => {
  // The outbox captures Date.now when it opens (fixture setup syncs the transcript).
  vi.useFakeTimers({ toFake: ["Date"] });
  let gone = false;
  const f = await leadChatFixture(false, cleanup, {
    defaultLead: true,
    nativeSourceProof: true,
    projectHireIdentity: async () => undefined,
    inventoryAgents: () => (gone ? [] : undefined),
  });
  const directory = await routed(f);
  const asked = Date.now();
  gone = true;
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat");
  vi.setSystemTime(asked + 35_000); // past the 30 s bound grace, inside the 45 s lane hold
  expect(await hire(f.captain, directory)).toMatchObject(changed);
  expect(spawn).not.toHaveBeenCalled();
  vi.setSystemTime(asked + 46_000);
  expect(await hire(f.captain, directory)).toMatchObject(reachedLaunch);
}, 30_000);

/**
 * A restarted service body whose old lead is gone launches its own Codex hire
 * through a real adapter view. `occupants` is the complete local inventory once
 * Herdr lists the hire's own pane, before it reports a session.
 */
async function launching(
  occupants: (own: HerdrAgentSnapshot, old: HerdrAgentSnapshot) => HerdrAgentSnapshot[],
  allocate = "w7:p1",
) {
  vi.useRealTimers();
  let local: HerdrAgentSnapshot[] | undefined;
  let old: HerdrAgentSnapshot | undefined;
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
      local = occupants(own, old!);
      own = local.find((agent) => agent.paneId === allocate) ?? own;
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
  const f = await leadChatFixture(false, cleanup, {
    defaultLead: true,
    nativeSourceProof: true,
    inventoryAgents: () => local,
    // Only the hire's own observed process is proven; the old lead never is.
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
  old = f.head;
  const directory = await routed(f);
  await f.captain.close();
  vi.useFakeTimers({ toFake: ["Date"] });
  local = [];
  const service = f.open();
  vi.setSystemTime(Date.now() + 60_000);
  return { result: await hire(service, directory), steps };
}

it("admits the hire's own session-less startup pane through guard and bound", async () => {
  const { result, steps } = await launching((own) => [own]);
  expect(steps).toEqual(["guard", "startup guard", "bound"]);
  expect(JSON.stringify(result)).not.toContain("original agent has changed");
}, 30_000);

it("never lets service absence admit that hire's restart; it refuses before any signal", async () => {
  // A SIGTERM that reached the original native process would be the regression.
  const kill = process.kill.bind(process);
  const signals = vi
    .spyOn(process, "kill")
    .mockImplementation((pid, signal) => (signal === "SIGTERM" ? true : kill(pid, signal)));
  const register = vi.spyOn(HiredSeatRestarts.prototype, "register");
  const { result, steps } = await launching((own) => [own]);
  expect(steps).toEqual(["guard", "startup guard", "bound"]);
  expect(JSON.stringify(result)).not.toContain("original agent has changed");
  // The original live restart runtime this launch registered, its old lead still gone.
  expect(register).toHaveBeenCalledOnce();
  const runtime = register.mock.calls[0]![0];
  const engine = register.mock.contexts[0] as HiredSeatRestarts;
  const worker = runtime.agent;
  expect(worker.session).toBeDefined();
  await expect(runtime.restartView!.guard!()).rejects.toThrow("original agent has changed");
  await expect(runtime.admitRestart()).rejects.toThrow("original agent has changed");
  // The engine's own restart path refuses at its first native check: nothing sent or ended.
  const [candidate] = await engine.candidates();
  expect(
    await candidate!.requestHandoff(
      `Write handoff ID ${randomUUID()} and repeat it in your final native reply.`,
      async () => {},
    ),
  ).toMatchObject({ outcome: "refused", reason: expect.stringContaining("original agent has changed") });
  expect(await candidate!.restart("Saved handoff.", async () => {})).toMatchObject({ outcome: "refused" });
  expect(signals.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toEqual([]);
  expect(engine.journal().map((receipt) => receipt.stage)).toEqual(["refused", "refused"]);
  expect((await engine.candidates())[0]!.agent).toMatchObject({
    paneId: worker.paneId,
    terminalId: worker.terminalId,
    session: worker.session,
  });
}, 30_000);

it("still refuses an unrelated unknown session beside the hire's startup pane", async () => {
  const { result, steps } = await launching((own) => [
    own,
    { paneId: "w8:p3", terminalId: "term_unknown", agent: "claude", status: "working", title: "Unrelated" },
  ]);
  expect(steps).not.toContain("startup guard");
  expect(JSON.stringify(result)).toContain("original agent has changed");
}, 30_000);

it("refuses when the hire's own pane matches the old source pane, terminal or session", async () => {
  const cases: [Parameters<typeof launching>[0], string?][] = [
    [(own, old) => [{ ...own, terminalId: old.terminalId }]],
    [(own, old) => [{ ...own, session: old.session! }]],
    [(own) => [own], "w4:p2"], // the old lead's own pane ID
  ];
  for (const [occupants, allocate] of cases) {
    const { result, steps } = await launching(occupants, allocate);
    expect(steps).not.toContain("startup guard");
    expect(JSON.stringify(result)).toContain("original agent has changed");
  }
}, 90_000);
