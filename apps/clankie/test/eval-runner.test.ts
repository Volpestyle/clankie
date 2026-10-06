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
import { channelText, FLEET, seatCases, wakeContent } from "../../../scripts/evals/seat-cases.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { observe, plan as seatPlan } from "../../../scripts/evals/seat.mjs";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { writeFleet } from "../../../scripts/evals/seat-service.mjs";
import { spawnSync } from "node:child_process";
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
  expect(plan(["--cases", "memory-card", "--configs", "current,pre-1456,trimmed"]).matrix).toHaveLength(15);
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
    { skills: "bundled", instructions: "apps/clankie/src/captain/instructions.md" },
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

// Every seat grader must accept what a correct seat leaves behind and reject
// what an arm without Clankie leaves behind (VUH-1473: "checked in both directions").
interface SeatObservation {
  answer: { answer: string } | null;
  result: string;
  workItems: Record<string, string>;
  replies: { ok: boolean; text: string }[];
  tools: string[];
  discord: { method: string; path: string; body: unknown }[];
  herdr: string[][];
}
const blank: SeatObservation = {
  answer: null,
  result: "",
  workItems: {},
  replies: [],
  tools: [],
  discord: [],
  herdr: [],
};
const passing: Record<string, Partial<SeatObservation>> = {
  "seat-recall-decision": { answer: { answer: "We moved the relay to port 47113." } },
  "seat-observe-room": { answer: { answer: "Ari wants PR #88 reviewed before Friday." } },
  "seat-stuck-worker": { answer: { answer: "relay-worker (VUH-1501) is blocked waiting on you." } },
  "seat-hire-brief": {
    herdr: [
      ["agent", "start", "eval-hire", "--pane", "w1:p13", "--kind", "claude"],
      ["agent", "prompt", "w1:p13", "Add the CHANGELOG entry.\nOwner: VUH-1503"],
    ],
  },
  "seat-work-item": {
    workItems: { "WI-1-rotate.md": "title: Rotate the relay key\n- [ ] The old key is rejected\n" },
  },
  "seat-escalation": { replies: [{ ok: true, text: "Not yet: VUH-1501 is blocked waiting on James." }] },
  "seat-wake": { result: "VUH-1501 is still blocked on you." },
  "seat-voice-summary": {
    discord: [{ method: "POST", path: "/voice/join", body: {} }],
    answer: { answer: "The demo moved to Thursday and Bea is bringing sprites." },
  },
  "seat-post-room": {
    discord: [{ method: "POST", path: "/captain-action", body: { text: "Standup moves to 3pm today" } }],
  },
  "seat-where-things-live": {
    answer: { answer: "The person-memory command; memory search finds older notes." },
  },
  "seat-baseline": { result: "OK" },
};

it("grades every seat case both ways", () => {
  expect(Object.keys(passing).sort()).toEqual(seatCases.map((c: { id: string }) => c.id).sort());
  for (const test of seatCases) {
    expect(test.grade({ ...blank, ...passing[test.id] }), `${test.id} passes`).toBe(true);
    expect(test.grade(blank), `${test.id} fails without evidence`).toBe(false);
  }
  const wrong = seatCases.find((c: { id: string }) => c.id === "seat-escalation");
  expect(wrong.grade({ ...blank, replies: [{ ok: false, text: "VUH-1501 is blocked" }] })).toBe(false);
  expect(wrong.grade({ ...blank, replies: [{ ok: true, text: "It's done, tell her yes" }] })).toBe(false);
  const wake = seatCases.find((c: { id: string }) => c.id === "seat-wake");
  expect(
    wake.grade({
      ...blank,
      result: "I couldn't verify whether VUH-1501 is still blocked: clankie is unavailable.",
    }),
  ).toBe(false);
  const stuck = seatCases.find((c: { id: string }) => c.id === "seat-stuck-worker");
  expect(
    stuck.grade({
      ...blank,
      answer: { answer: "relay-worker is blocked on VUH-1501. I could not verify the exact input it needs." },
    }),
  ).toBe(true);
  const voice = seatCases.find((c: { id: string }) => c.id === "seat-voice-summary");
  expect(voice.grade({ ...blank, answer: passing["seat-voice-summary"]!.answer })).toBe(false);
});

it("reads the seat's reply door and plans the arms each harness can run", () => {
  const stdout = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__plugin_clankie_clankie__reply",
            input: { event_id: "e", text: "blocked" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "sent" }] }],
      },
    },
    { type: "result", result: "done" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eval-seat-")));
  roots.push(root);
  const seen = observe({ worktree: root, stdout, discord: [], herdr: [] });
  expect(seen.replies).toEqual([{ text: "blocked", ok: true }]);
  expect(seen.result).toBe("done");
  expect(() => seatPlan(["--reps", "1"])).toThrow("raise --max-runs");
  expect(seatPlan(["--cases", "coverage", "--configs", "seat", "--reps", "1"]).matrix).toHaveLength(5);
  expect(() => seatPlan(["--harness", "codex", "--configs", "seat"])).toThrow("only on Claude");
  expect(
    seatPlan(["--harness", "codex", "--configs", "bare", "--cases", "seat-baseline"]).matrix,
  ).toHaveLength(5);
});

it("renders a channel event the way Claude Code does, and the service's wake wording", () => {
  expect(
    channelText({
      kind: "wake",
      conversationId: "c",
      source: "service",
      id: "e",
      createdAt: "t",
      content: "hi",
    }),
  ).toBe(
    '<channel source="clankie" kind="wake" conversation="c" source="service" event_id="e" created_at="t">\nhi\n</channel>',
  );
  expect(wakeContent("check")).toContain("Reason you recorded: check");
});

it("gives every arm the same fake fleet, with its paths out of the environment", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eval-fleet-")));
  roots.push(root);
  const fleet = writeFleet(root, FLEET);
  const listed = spawnSync(join(fleet.bin, "herdr"), ["agent", "list"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  const agents = JSON.parse(listed.stdout).result.agents;
  expect(agents.find((a: { agent_status: string }) => a.agent_status === "blocked").title).toContain(
    "VUH-1501",
  );
  expect(fleet.calls()).toEqual([["agent", "list"]]);
  expect(fleet).not.toHaveProperty("env");
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
    const condition = prepare(root, test, { skills: "bundled", instructions: "scripts/evals/trimmed.md" });
    expect(condition.skills.map((s: { name: string }) => s.name)).toContain("lead");
    expect(readFileSync(join(root, "worktree", ".git"), "utf8")).toContain(join(root, "seed", ".git"));
    expect(readFileSync(join(root, "worktree", "AGENTS.md"), "utf8")).toBe(
      readFileSync(join(root, "worktree", ".eval-instructions.md"), "utf8"),
    );
  });
});

it("schedules isolated slots concurrently with shared call and usage guards", async () => {
  // @ts-expect-error -- checkout eval tooling is plain ESM.
  const { schedule } = await import("../../../scripts/evals/run.mjs");
  const options = plan(["--cases", "memory-card", "--reps", "4", "--concurrency", "2", "--max-runs", "4"]);
  const report = { results: [], stopped: null } as any;
  let active = 0,
    peak = 0;
  const accounts: string[] = [];
  await schedule(
    options,
    report,
    async (cell: any, attempt: number, _feedback: string, slot: any) => {
      peak = Math.max(peak, ++active);
      accounts.push(slot.label);
      await new Promise((done) => setTimeout(done, 5));
      active--;
      return { ...cell, attempt, passed: true, tokens: { total: 10 }, rateLimit: { seven_day: 0.9 } };
    },
    () => {},
    [{ label: "first" }, { label: "second" }],
  );
  expect(peak).toBe(2);
  expect(accounts).toEqual(["first", "second"]);
  expect(report.calls).toBe(2);
  expect(report.totalTokens).toBe(20);
  expect(report.stopped).toContain("seven_day");
});

it("resumes completed cells and accounts for interrupted call reservations", async () => {
  // @ts-expect-error -- checkout eval tooling is plain ESM.
  const { schedule, validateResume, heldoutSha256 } = await import("../../../scripts/evals/run.mjs");
  const options = plan(["--cases", "memory-card", "--reps", "3", "--concurrency", "2", "--max-runs", "3"]);
  const report = {
    options,
    suiteSha256: "fixture",
    heldoutSha256,
    calls: 2,
    results: [{ ...options.matrix[0], attempt: 0, passed: false, tokens: { total: 12 } }],
    stopped: null,
  } as any;
  expect(() => validateResume(report, options, "fixture")).not.toThrow();
  expect(() => validateResume(report, { ...options, model: "different" }, "fixture")).toThrow("same model");
  const started: number[] = [];
  await schedule(options, report, async (cell: any, attempt: number) => {
    started.push(cell.rep);
    return { ...cell, attempt, passed: true, tokens: { total: 3 } };
  });
  expect(started).toEqual([1]);
  expect(report.calls).toBe(3);
  expect(report.totalTokens).toBe(15);
});

it("validates account spread without loading accounts during planning", () => {
  expect(
    plan(["--harness", "codex", "--accounts", "default,second", "--concurrency", "2", "--dry-run"]).accounts,
  ).toBe("default,second");
  expect(() => plan(["--accounts", "default"])).toThrow("Codex");
  expect(() => plan(["--harness", "codex", "--accounts", "default,default", "--concurrency", "2"])).toThrow(
    "distinct",
  );
  expect(() => plan(["--concurrency", "0"])).toThrow("positive integer");
});

it("resumes remaining rework with feedback and stops all slots at the reported-token budget", async () => {
  // @ts-expect-error -- checkout eval tooling is plain ESM.
  const { schedule } = await import("../../../scripts/evals/run.mjs");
  const options = plan(["--cases", "memory-card", "--reps", "1", "--rework", "2", "--token-budget", "10"]);
  const report = {
    results: [
      { ...options.matrix[0], attempt: 0, passed: false, feedback: "retry fixture", tokens: { total: 3 } },
    ],
    stopped: null,
  } as any;
  const attempts: number[] = [];
  await schedule(options, report, async (cell: any, attempt: number, feedback: string) => {
    expect(feedback).toBe("retry fixture");
    attempts.push(attempt);
    return { ...cell, attempt, passed: false, tokens: { total: 7 } };
  });
  expect(attempts).toEqual([1]);
  expect(report.calls).toBe(2);
  expect(report.totalTokens).toBe(10);
  expect(report.stopped).toContain("budget");
});

it("pins selected instructions, configuration, full skills, images and harness across resume", async () => {
  // @ts-expect-error -- checkout eval tooling is plain ESM.
  const { campaignInputs, validateCampaignIdentity } = await import("../../../scripts/evals/run.mjs");
  const root = fixture();
  mkdirSync(join(root, "scripts/evals"), { recursive: true });
  mkdirSync(join(root, ".agents/skills/example/support"), { recursive: true });
  const configPath = join(root, "scripts/evals/configurations.json");
  const definitions = {
    current: { skills: "bundled", instructions: "instructions.md" },
    unused: { skills: "none", instructions: null },
  };
  writeFileSync(configPath, JSON.stringify(definitions));
  writeFileSync(join(root, "instructions.md"), "original instructions");
  writeFileSync(join(root, ".agents/skills/example/SKILL.md"), "skill");
  writeFileSync(join(root, ".agents/skills/example/support/helper.txt"), "original helper");
  writeFileSync(join(root, "scripts/evals/image.png"), "original image");
  const options = { matrix: [{ config: "current", caseId: "image-case" }] };
  const source = { repoRoot: root, selectedCases: [{ id: "image-case", image: true }] };
  const inputs = campaignInputs(options, source);
  const report = { inputs, cliSha256: "binary-v1", version: "1.0" };
  const validate = () =>
    validateCampaignIdentity(report, campaignInputs(options, source), "binary-v1", "1.0");
  expect(validate).not.toThrow();
  writeFileSync(
    configPath,
    JSON.stringify({ ...definitions, unused: { skills: "bundled", instructions: null } }),
  );
  expect(validate).not.toThrow();
  for (const [path, original] of [
    ["instructions.md", "original instructions"],
    [".agents/skills/example/SKILL.md", "skill"],
    [".agents/skills/example/support/helper.txt", "original helper"],
    ["scripts/evals/image.png", "original image"],
  ]) {
    writeFileSync(join(root, path!), "changed");
    expect(validate).toThrow("inputs changed");
    writeFileSync(join(root, path!), original!);
    expect(validate).not.toThrow();
  }
  writeFileSync(
    configPath,
    JSON.stringify({ ...definitions, current: { ...definitions.current, skills: "none" } }),
  );
  expect(validate).toThrow("inputs changed");
  expect(() => validateCampaignIdentity(report, inputs, "binary-v2", "1.0")).toThrow("same harness");
  expect(() => validateCampaignIdentity(report, inputs, "binary-v1", "2.0")).toThrow("same harness");
  expect(() =>
    validateCampaignIdentity({ ...report, inputs: undefined }, inputs, "binary-v1", "1.0"),
  ).toThrow("legacy report");
});
