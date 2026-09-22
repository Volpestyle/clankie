import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Evaluator } from "../src/captain/evaluator.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "clankie-evaluator-test-"));
  roots.push(directory);
  let agent: { -readonly [K in keyof HerdrAgentSnapshot]: HerdrAgentSnapshot[K] } = {
    paneId: "w1:p1",
    terminalId: "t1",
    agent: "codex",
    status: "idle",
    title: "Evaluator",
  };
  const runner: HerdrWatchRunner = {
    get: vi.fn(async () => agent),
    resolveTerminal: async () => agent,
    wait: async () => agent,
    createTab: vi.fn(async () => "w1:p1"),
    closePane: vi.fn(async () => {}),
    paneProcesses: async () => [{ pid: 1234, name: "codex" }],
    startAgent: vi.fn(
      async ({ name, kind, args }: Parameters<NonNullable<HerdrWatchRunner["startAgent"]>>[0]) => {
        agent = {
          ...agent,
          name,
          agent: kind,
          status: args?.some((arg) => arg.startsWith("Read ")) ? "working" : "idle",
        };
      },
    ),
  };
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "prompt") agent.status = "working";
  });
  const evaluator = new Evaluator(directory, { runner, run, socket: "/test.sock" });
  return { directory, evaluator, runner, run, agent: () => agent };
}

function report(id: string) {
  const assessment = { verdict: "unknown", evidence: ["The fixture has no delivered artifact."] };
  return {
    schemaVersion: 1,
    evaluationId: id,
    taskOutcome: "unknown",
    summary: "Insufficient evidence",
    outcome: assessment,
    efficiency: assessment,
    tools: assessment,
    harness: assessment,
    findings: [],
  };
}

it("keeps evaluator descendants excluded after the parent exits and across restart", async () => {
  const { evaluator, directory } = setup();
  await evaluator.command({ action: "enable" });
  evaluator.observeFleet([
    { paneId: "w1:p2", seatId: "worker", subject: "fixer", parentPaneId: "w1:p1" },
    { paneId: "w1:p3", seatId: "reviewer", subject: "reviewer", parentPaneId: "w1:p2" },
    { paneId: "w1:p4", seatId: "ordinary", subject: "worker" },
  ]);
  const restored = new Evaluator(directory, { socket: "/test.sock" });
  expect(restored.excludesSeat("worker")).toBe(true);
  expect(restored.excludesSeat("reviewer")).toBe(true);
  expect(restored.excludesSeat("ordinary")).toBe(false);
});

it("captures only while enabled, coalesces and deduplicates runs, and redacts evidence", async () => {
  const { evaluator, directory, run } = setup();
  const input = { conversationId: "c1", runId: "r1", context: { request: "Bearer abcdefghijklmnop" } };
  evaluator.capture(input);
  expect(evaluator.status().jobs).toHaveLength(0);
  await evaluator.command({ action: "enable" });
  evaluator.capture(input);
  evaluator.capture(input);
  evaluator.capture({ ...input, runId: "r2" });
  const job = evaluator.status().jobs[0]!;
  expect(job.runIds).toEqual(["r1", "r2"]);
  expect(readdirSync(job.directory)).toHaveLength(2);
  expect(readFileSync(join(job.directory, readdirSync(job.directory)[0]!), "utf8")).not.toContain(
    "abcdefghijklmnop",
  );
  const restored = new Evaluator(directory);
  expect(restored.status().queued).toBe(1);
  expect(run).not.toHaveBeenCalled();
});

it("resumes a running assessment without resending it and collects its report even when disabled", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { evaluator, directory, runner, run, agent } = setup();
  await evaluator.command({ action: "enable" });
  evaluator.capture({ conversationId: "c1", runId: "r1", context: {} });
  vi.setSystemTime(Date.now() + 61_000);
  await evaluator.tick();
  const job = evaluator.status().jobs[0]!;
  expect(job.status).toBe("running");
  expect(
    vi
      .mocked(runner.startAgent!)
      .mock.calls.filter(([options]) => options.args?.some((arg) => arg.startsWith("Read "))),
  ).toHaveLength(1);
  const restarted = new Evaluator(directory, { runner, run, socket: "/test.sock" });
  await restarted.tick();
  expect(
    vi
      .mocked(runner.startAgent!)
      .mock.calls.filter(([options]) => options.args?.some((arg) => arg.startsWith("Read "))),
  ).toHaveLength(1);
  await restarted.command({ action: "disable" });
  writeFileSync(join(job.directory, "report.json"), JSON.stringify(report(job.id)));
  agent().status = "done";
  delete agent().name; // native Codex session reporter clears the managed name
  await restarted.tick();
  expect(restarted.status().jobs[0]?.status).toBe("completed");
  expect(restarted.status().enabled).toBe(false);
});

it("does not turn an idle pane or a mismatched report into success", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { evaluator, agent } = setup();
  await evaluator.command({ action: "enable" });
  evaluator.capture({ conversationId: "c1", runId: "r1", context: {} });
  vi.setSystemTime(Date.now() + 61_000);
  await evaluator.tick();
  const job = evaluator.status().jobs[0]!;
  agent().status = "idle";
  await evaluator.tick();
  expect(evaluator.status().jobs[0]?.status).toBe("failed");
  await evaluator.command({ action: "retry", id: job.id });
  await evaluator.tick();
  writeFileSync(
    join(job.directory, "report.json"),
    JSON.stringify(report("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa")),
  );
  agent().status = "done";
  await evaluator.tick();
  expect(evaluator.status().jobs[0]?.error).toContain("another evaluation");
  await evaluator.command({ action: "retry", id: job.id });
  expect(readdirSync(job.directory)).toContain("previous-report.json");
  expect(readdirSync(job.directory)).not.toContain("report.json");
});

it("does not dispatch an agent after disable arrives during pane creation", async () => {
  const { evaluator, runner } = setup();
  let release!: (pane: string) => void;
  vi.mocked(runner.createTab!).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const enabling = evaluator.command({ action: "enable" });
  await evaluator.command({ action: "disable" });
  release("w1:p1");
  await enabling;
  expect(runner.startAgent).not.toHaveBeenCalled();
  expect(evaluator.status().enabled).toBe(false);
});

it("preserves another agent's pane and refuses corrupt durable state", async () => {
  const { evaluator, directory, runner, agent } = setup();
  await evaluator.command({ action: "enable" });
  agent().name = "someone-else";
  await expect(evaluator.command({ action: "open" })).rejects.toThrow("another agent");
  expect(runner.closePane).not.toHaveBeenCalled();
  writeFileSync(join(directory, "state.json"), "broken");
  const corrupt = new Evaluator(directory);
  await expect(corrupt.command({ action: "enable" })).rejects.toThrow("unreadable");
  expect(readFileSync(join(directory, "state.json"), "utf8")).toBe("broken");
});

it("interrupts an over-budget assessment once and keeps the pane inspectable", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { evaluator, run, runner } = setup();
  await evaluator.command({ action: "enable" });
  evaluator.capture({ conversationId: "c1", runId: "r1", context: {} });
  vi.setSystemTime(Date.now() + 61_000);
  await evaluator.tick();
  const closes = vi.mocked(runner.closePane!).mock.calls.length;
  vi.setSystemTime(Date.now() + 31 * 60_000);
  await evaluator.tick();
  expect(run).toHaveBeenLastCalledWith(["agent", "send-keys", "w1:p1", "ctrl+c"]);
  expect(evaluator.status().jobs[0]?.status).toBe("failed");
  expect(vi.mocked(runner.closePane!).mock.calls).toHaveLength(closes);
});
