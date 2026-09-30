import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { cases } from "../../../scripts/evals/cases.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { codexRateLimit, judge, parseEvents, plan, prepare, usageGate } from "../../../scripts/evals/run.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { layer, plan as benchmarkPlan, trialRow } from "../../../scripts/evals/benchmark.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { summarize } from "../../../scripts/evals/report.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { pairedDifference, wilson } from "../../../scripts/evals/stats.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { cleanEnv, executeSandbox, installAuth, removeAuth } from "../../../scripts/evals/isolation.mjs";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eval-test-")));
  roots.push(root);
  installAuth(root, "codex", '{"test":true}');
  mkdirSync(join(root, "worktree"));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("requires an explicit larger call budget for a matrix and rejects typos", () => {
  expect(plan([]).matrix).toHaveLength(15);
  expect(() => plan(["--cases", "all"])).toThrow("raise --max-runs");
  expect(plan(["--cases", "memory-card", "--configs", "current,plain,trimmed"]).matrix).toHaveLength(15);
  expect(() => plan(["--configs", "typo"])).toThrow("Unknown configuration");
  expect(() => plan(["--max-runs", "NaN"])).toThrow();
  expect(() => plan(["--rework", "3"])).toThrow();
  expect(() => plan(["--stop-at", "five_hour=2"])).toThrow("--stop-at");
});

it("repeats every cell and rotates arm order so drift hits both arms", () => {
  const { matrix } = plan([
    "--cases",
    "memory-card,discord-addressed",
    "--configs",
    "bare,current",
    "--reps",
    "2",
  ]);
  expect(matrix).toHaveLength(8);
  expect(matrix.slice(0, 2).map((c: { config: string }) => c.config)).toEqual(["bare", "current"]);
  expect(matrix.slice(4, 6).map((c: { config: string }) => c.config)).toEqual(["current", "bare"]);
  const incidents = plan(["--cases", "incidents", "--reps", "1"]).matrix.map(
    (c: { caseId: string }) => c.caseId,
  );
  expect(incidents).toHaveLength(5);
  expect(incidents.every((id: string) => cases.find((c: { id: string }) => c.id === id).incident)).toBe(true);
});

it("waits out a five-hour window, stops on the weekly one, and reads Codex rollouts", () => {
  const stopAt = { five_hour: 0.8, seven_day: 0.5 };
  const now = 1_000_000_000_000;
  const resets = { five_hour: now / 1000 + 600, seven_day: now / 1000 + 86400 };
  expect(usageGate({ five_hour: 0.5, seven_day: 0.1, resets }, stopAt, now)).toBeNull();
  expect(usageGate({ five_hour: 0.85, seven_day: 0.1, resets }, stopAt, now).wait).toBe(660_000);
  expect(usageGate({ five_hour: 0.85, seven_day: 0.6, resets }, stopAt, now).stop).toContain("seven_day");
  expect(usageGate({ five_hour: 0.9, seven_day: 0.1, resets: {} }, stopAt, now).stop).toContain("five_hour");
  const rollout = JSON.stringify({
    type: "event_msg",
    payload: { rate_limits: { primary: { used_percent: 86, window_minutes: 10080, resets_at: 5 } } },
  });
  expect(codexRateLimit(`partial\n${rollout}\n`)).toMatchObject({ seven_day: 0.86, five_hour: null });
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.7, resetsAt: 9 }, seven_day: { utilization: 0.1 } },
    },
  };
  expect(parseEvents("claude", JSON.stringify(event)).rateLimit).toMatchObject({
    five_hour: 0.7,
    seven_day: 0.1,
  });
});

it("reports Wilson intervals and calls overlapping paired differences noise", () => {
  const [low, high] = wilson(0, 5);
  expect(low).toBe(0);
  expect(high).toBeGreaterThan(0.4);
  expect(wilson(5, 5)[1]).toBe(1);
  const same = new Map([["a", { a: [1, 0, 1, 1, 0], b: [1, 1, 0, 1, 0] }]]);
  expect(pairedDifference(same).withinNoise).toBe(true);
  const apart = new Map(
    ["a", "b", "c", "d"].map((id) => [id, { a: [0, 0, 0, 0, 0], b: [1, 1, 1, 1, 1] }] as const),
  );
  expect(pairedDifference(apart)).toMatchObject({ difference: 1, withinNoise: false });
  expect(pairedDifference(new Map([["a", { a: [0], b: [1] }]])).insufficient).toBe(true);
  const row = (caseId: string, config: string, rep: number, passed: boolean, extra = {}) => ({
    caseId,
    config,
    rep,
    passed,
    harness: "claude",
    model: "m",
    kind: "bug",
    tokens: { total: 10 },
    wallMs: 1000,
    ...extra,
  });
  const [scope] = summarize([
    {
      id: "r1",
      version: "1",
      results: [
        row("x", "bare", 0, false),
        row("x", "bare", 0, true, { attempt: 1 }),
        row("x", "current", 0, false),
        row("h", "current", 0, true, { heldout: true }),
      ],
    },
  ]);
  const bare = scope.arms.find((arm: { config: string }) => arm.config === "bare");
  expect(bare).toMatchObject({ trials: 1, passes: 1, perCase: { x: "1/1" } });
  expect(bare.tokensPerTrial.mean).toBe(20);
  const current = scope.arms.find((arm: { config: string }) => arm.config === "current");
  expect(Object.keys(current.perCase)).toEqual(["x"]);
  expect(current.slices.heldout).toMatchObject({ trials: 1, passes: 1 });
  expect(scope.comparisons[0]).toMatchObject({ config: "current", against: "bare" });
});

it("plans Terminal-Bench trials and maps Harbor results into report rows", () => {
  const options = benchmarkPlan(["--max-trials", "50"]);
  expect(options.matrix).toHaveLength(50);
  expect(() => benchmarkPlan([])).toThrow("raise --max-trials");
  expect(() => benchmarkPlan(["--concurrency", "8"])).toThrow("subscription");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eval-bench-")));
  roots.push(root);
  expect(layer("claude", { skills: "none", instructions: null }, root)).toMatchObject({
    kwargs: {},
    skills: [],
  });
  const current = layer(
    "codex",
    { skills: "plain", instructions: "apps/clankie/src/captain/instructions.md" },
    root,
  );
  expect(current.kwargs.config.developer_instructions).toContain("Clankie");
  expect(current.skills.length).toBeGreaterThan(0);
  const log = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4 } } },
  });
  const result = {
    agent_result: { n_input_tokens: 100, n_cache_tokens: 60, n_output_tokens: 5 },
    verifier_result: { rewards: { reward: 1 } },
    agent_execution: { started_at: "2026-09-30T10:00:00Z", finished_at: "2026-09-30T10:00:20Z" },
    agent_info: { version: "2.1.285", model_info: { name: "claude-sonnet-5-5" } },
    exception_info: null,
  };
  expect(trialRow(result, log, "claude")).toMatchObject({
    passed: true,
    wallMs: 20_000,
    tokens: { total: 105, cacheRead: 60 },
    rateLimit: { five_hour: 0.4 },
  });
  expect(
    trialRow({ ...result, verifier_result: { rewards: { reward: 0 } }, agent_result: {} }, "", "claude"),
  ).toMatchObject({ passed: false, tokens: null });
});

it("accounts for each provider's cached token semantics and missing usage", () => {
  expect(
    parseEvents(
      "codex",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 8 },
      }),
    ).tokens.total,
  ).toBe(108);
  expect(
    parseEvents(
      "claude",
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 70,
          cache_creation_input_tokens: 20,
          output_tokens: 8,
        },
      }),
    ).tokens.total,
  ).toBe(108);
  expect(parseEvents("codex", "bad json\n").tokens).toBeNull();
  expect(
    parseEvents(
      "claude",
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 100 },
        modelUsage: {
          main: { inputTokens: 100, outputTokens: 4 },
          helper: { inputTokens: 20, outputTokens: 2 },
        },
      }),
    ).tokens.total,
  ).toBe(126);
  expect(
    parseEvents("claude", '{"type":"result","subtype":"error_max_turns","is_error":true}').providerError,
  ).toBe("error_max_turns");
});

it("never inherits provider keys, live sockets or owner state", () => {
  const env = cleanEnv("/fixture");
  expect(env.HOME).toBe("/fixture/home");
  expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
  expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
  expect(Object.keys(env)).not.toContain("CLANKIE_OPERATOR_TOKEN");
});

describe.skipIf(process.platform !== "darwin")("OS isolation", () => {
  it("permits fixture edits and denies outside reads, writes, signals and loopback", async () => {
    const root = fixture();
    const other = fixture();
    const marker = join(other, "private.txt");
    writeFileSync(marker, "private");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No port");
    try {
      const script = `const fs=require('fs'),net=require('net');
        fs.writeFileSync('own.txt','ok');
        for(const f of [()=>fs.readFileSync(${JSON.stringify(marker)}),()=>fs.writeFileSync(${JSON.stringify(marker)},'bad'),()=>process.kill(${process.pid},0),()=>fs.writeFileSync('../events.jsonl','spoof'),()=>fs.rmdirSync(process.cwd())]) {
          let denied=false;try{f()}catch{denied=true}if(!denied)process.exit(2);
        }
        const socket=net.connect(${address.port},'127.0.0.1'); socket.on('connect',()=>process.exit(3)); socket.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(4),1500);`;
      const result = await executeSandbox({ root, binary: process.execPath, args: ["-e", script] });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("private");
      expect(readFileSync(join(root, "worktree", "own.txt"), "utf8")).toBe("ok");
    } finally {
      server.close();
    }
  });

  it("runs checks without network, rejects broken code and accepts the requested fix", async () => {
    const root = fixture();
    const test = cases.find((c: { id: string }) => c.id === "memory-card");
    writeFileSync(join(root, "worktree", "solution.mjs"), test.files["solution.mjs"]);
    expect((await judge(root, test)).exitCode).not.toBe(0);
    writeFileSync(
      join(root, "worktree", "solution.mjs"),
      `const seen=new Map(); export function shouldInject(s,h,r=false) {if(!s)return true; const yes=r||seen.get(s)!==h;seen.set(s,h);return yes;}`,
    );
    const outside = fixture();
    const marker = join(outside, "oracle.txt");
    writeFileSync(marker, "unchanged");
    rmSync(join(root, "worktree", ".eval-check.mjs"));
    symlinkSync(marker, join(root, "worktree", ".eval-check.mjs"));
    expect((await judge(root, test)).exitCode).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("unchanged");
    removeAuth(root);
    expect(() => readFileSync(join(root, "home", ".codex", "auth.json"))).toThrow();
  });

  it("fails every public code case's starter so no fixture passes unchanged", async () => {
    for (const test of cases.filter(
      (c: { kind: string; heldout?: boolean }) => c.kind !== "social" && !c.heldout,
    )) {
      const root = fixture();
      for (const [name, content] of Object.entries(test.files as Record<string, string>))
        writeFileSync(join(root, "worktree", name), content);
      expect((await judge(root, test)).exitCode, test.id).not.toBe(0);
    }
  });

  it("gives the bare arm the fixture boundary alone", () => {
    const root = fixture();
    rmSync(join(root, "worktree"), { recursive: true });
    const test = cases.find((c: { id: string }) => c.id === "memory-card");
    const condition = prepare(root, test, { skills: "none", instructions: null });
    expect(condition.skills).toEqual([]);
    const guidance = readFileSync(join(root, "worktree", "AGENTS.md"), "utf8");
    expect(guidance).toContain("offline evaluation fixture");
    expect(guidance).not.toContain("Available skills");
    expect(guidance).not.toContain("Clankie");
  });

  it("copies selected skills and owns a separate Git repository and worktree", () => {
    const root = fixture();
    rmSync(join(root, "worktree"), { recursive: true });
    const test = cases.find((c: { id: string }) => c.id === "memory-card");
    const condition = prepare(root, test, { skills: "plain", instructions: "scripts/evals/trimmed.md" });
    expect(condition.skills.every((s: { class: string }) => s.class === "product")).toBe(true);
    expect(readFileSync(join(root, "worktree", ".git"), "utf8")).toContain(join(root, "seed", ".git"));
    expect(readFileSync(join(root, "worktree", "AGENTS.md"), "utf8")).toBe(
      readFileSync(join(root, "worktree", ".eval-instructions.md"), "utf8"),
    );
  });
});
