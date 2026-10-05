import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  OperatorSeatEfficiencySchema,
  type OperatorWorkAssignment,
  type WorkerReportSummary,
} from "@clankie/protocol";
import { SeatEfficiencyStore } from "../src/captain/seat-efficiency.ts";
import { readSeatTelemetry } from "../src/captain/seat-telemetry.ts";
import type { ObservedFleetSeat } from "../src/captain/herdr-census.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const owner = { conversationId: "global-default" };
const sessionId = "01a107e9-f3b1-7181-ad0e-744661b18964";
const startedAt = "2026-10-05T12:00:00.000Z";
let now = Date.parse(startedAt);
afterEach(async () => {
  now = Date.parse(startedAt);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "clankie-seat-efficiency-"));
  roots.push(path);
  return path;
}
const assignment = (itemId: string): OperatorWorkAssignment => ({
  objective: "Review the assigned delivery",
  issue: { repoId: "clankie", itemId },
  updatedAt: startedAt,
});
const report = (state: WorkerReportSummary["state"], acceptedAt = startedAt): WorkerReportSummary => ({
  deliveryId: "bddfcb6b-ceca-4e1a-81fd-09f44e3724b3",
  conversationId: "global-default",
  paneId: "pane-1",
  state,
  acceptedAt,
});
function observed(path: string, harness = "codex"): ObservedFleetSeat {
  return {
    occupantId: "session-worker-1",
    seatId: "seat-1",
    paneId: "pane-1",
    subject: "worker",
    title: "Worker",
    status: "working",
    harness,
    session: { source: `herdr:${harness}`, kind: "path", value: path },
  };
}
// Native record shapes retained in codex-subagents.json and the Claude collector
// integration fixtures. Telemetry values below exercise explicit boundary cases.
const nativeCodex = (extra: unknown[] = []) =>
  [
    { timestamp: startedAt, type: "session_meta", payload: { id: sessionId } },
    { timestamp: startedAt, type: "turn_context", payload: { model: "gpt-6-sol", effort: "high" } },
    {
      timestamp: startedAt,
      type: "event_msg",
      payload: { type: "task_started", model_context_window: 100_000 },
    },
    {
      timestamp: startedAt,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 1_900_000, total_tokens: 2_000_000 },
          last_token_usage: { input_tokens: 82_000, output_tokens: 1_000, total_tokens: 83_000 },
          model_context_window: 100_000,
        },
      },
    },
    ...extra,
  ]
    .map((value) => JSON.stringify(value))
    .join("\n") + "\n";

it("joins exact local native context with durable assignment and protocol evidence, without using lifetime usage", async () => {
  const dir = await directory();
  const path = join(dir, "native.jsonl");
  await writeFile(path, nativeCodex());
  const store = new SeatEfficiencyStore(join(dir, "efficiency.json"), { now: () => now });
  store.assign("session-worker-1", { owner, deliverable: "VUH-1662", objective: "Ship the assigned change" });
  const telemetry = await readSeatTelemetry(observed(path));
  expect(telemetry).toMatchObject({ model: "gpt-6-sol", effort: "high", contextPercent: 82 });
  const result = store.observe({
    occupantId: "session-worker-1",
    seatId: "seat-1",
    owner,
    status: "working",
    assignment: assignment("VUH-1662"),
    telemetry,
  });
  expect(OperatorSeatEfficiencySchema.parse(result)).toMatchObject({
    assignedDeliverable: "VUH-1662",
    currentIssue: "VUH-1662",
    flags: ["context 82%"],
  });
  const restored = new SeatEfficiencyStore(join(dir, "efficiency.json"), { now: () => now });
  expect(
    restored.observe({ occupantId: "session-worker-1", seatId: "seat-1", owner }).assignedDeliverable,
  ).toBe("VUH-1662");
});

it("invalidates context after compaction and does not guess Claude capacity or unsupported native telemetry", async () => {
  const dir = await directory();
  const path = join(dir, "codex.jsonl");
  await writeFile(path, nativeCodex([{ timestamp: startedAt, type: "compacted", payload: {} }]));
  expect(await readSeatTelemetry(observed(path))).not.toHaveProperty("contextPercent");
  const claude = join(dir, "claude.jsonl");
  await writeFile(
    claude,
    JSON.stringify({
      type: "assistant",
      sessionId,
      uuid: "assistant-1",
      timestamp: startedAt,
      message: {
        role: "assistant",
        id: "message-1",
        model: "claude-sonnet-4-5",
        content: "Report",
        usage: { input_tokens: 150_000, output_tokens: 100, cache_read_input_tokens: 50_000 },
      },
    }) + "\n",
  );
  expect(await readSeatTelemetry(observed(claude, "claude"))).toEqual({ model: "claude-sonnet-4-5" });
  expect(await readSeatTelemetry(observed(path, "opencode"))).toBeUndefined();
  expect(await readSeatTelemetry({ ...observed(path), fleet: "remote" })).toBeUndefined();
  expect(
    await readSeatTelemetry({
      ...observed(path),
      session: { source: "herdr:claude", kind: "path", value: path },
    }),
  ).toBeUndefined();
});

it("does not reinterpret the retained real VUH-1608 cumulative usage golden as context occupancy", async () => {
  const dir = await directory();
  const path = join(dir, "native.jsonl");
  const retained = await readFile(
    new URL("./fixtures/issue-metrics/vuh-1608.jsonl", import.meta.url),
    "utf8",
  );
  await writeFile(
    path,
    JSON.stringify({ timestamp: startedAt, type: "session_meta", payload: { id: sessionId } }) +
      "\n" +
      retained,
  );
  expect(await readSeatTelemetry(observed(path))).not.toHaveProperty("contextPercent");
});

it("reads the latest bounded native tail after a large provider body without treating that body as efficiency evidence", async () => {
  const dir = await directory();
  const path = join(dir, "native.jsonl");
  await writeFile(
    path,
    JSON.stringify({ timestamp: startedAt, type: "session_meta", payload: { id: sessionId } }) +
      "\n" +
      JSON.stringify({
        timestamp: startedAt,
        type: "response_item",
        payload: { type: "function_call_output", call_id: "large-body", output: "x".repeat(3 * 1024 * 1024) },
      }) +
      "\n" +
      nativeCodex(),
  );
  expect(await readSeatTelemetry(observed(path))).toEqual({
    model: "gpt-6-sol",
    effort: "high",
    contextPercent: 82,
  });
});

it("does not turn a different native thread's token snapshot into the observed worker's context", async () => {
  const dir = await directory();
  const path = join(dir, "native.jsonl");
  await writeFile(path, nativeCodex());
  expect(
    await readSeatTelemetry({
      ...observed(path),
      session: { source: "herdr:codex", kind: "id", value: "not-a-session-id" },
    }),
  ).toBeUndefined();
  await writeFile(
    path,
    JSON.stringify({ timestamp: startedAt, type: "response_item", payload: { type: "message" } }) + "\n",
  );
  expect(await readSeatTelemetry(observed(path))).toBeUndefined();
});

it("resolves an exact Codex session in its admitted custom account home", async () => {
  const dir = await directory();
  const home = join(dir, "custom-codex-profile");
  const date = new Date(Number.parseInt(sessionId.replaceAll("-", "").slice(0, 12), 16));
  const nativeDir = join(
    home,
    "sessions",
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  );
  await mkdir(nativeDir, { recursive: true });
  const path = join(nativeDir, `rollout-fixture-${sessionId}.jsonl`);
  await writeFile(path, nativeCodex());
  const seat = {
    ...observed(path),
    account: { label: "custom", home },
    session: { source: "herdr:codex", kind: "id" as const, value: sessionId },
  };
  expect(await readSeatTelemetry(seat)).toMatchObject({ contextPercent: 82 });
  expect(
    await readSeatTelemetry({ ...seat, account: { label: "other", home: join(dir, "other-profile") } }),
  ).toBeUndefined();
});

it("records preaccept native MCP report failures once and keeps acknowledged report progress", async () => {
  const dir = await directory();
  const path = join(dir, "native.jsonl");
  await writeFile(
    path,
    nativeCodex([
      {
        timestamp: "2026-10-05T12:10:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "report-1",
          name: "mcp__clankie__message_clankie",
          arguments: "{}",
        },
      },
      {
        timestamp: "2026-10-05T12:10:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "report-1",
          output: "Error executing tool message_clankie: connection refused",
        },
      },
    ]),
  );
  const telemetry = await readSeatTelemetry(observed(path));
  expect(telemetry).toMatchObject({ reportFailedAt: "2026-10-05T12:10:01.000Z", reportFailures: 1 });
  const store = new SeatEfficiencyStore(join(dir, "efficiency.json"), { now: () => now });
  const input = { occupantId: "session-worker-1", seatId: "seat-1", owner, telemetry };
  expect(store.observe(input)).toMatchObject({
    flags: ["reports failing", "context 82%"],
    reportFailures: 1,
    lastProgressAt: "2026-10-05T12:10:01.000Z",
  });
  expect(store.observe(input).reportFailures).toBe(1);
  expect(
    store.observe({ ...input, reports: [report("read", "2026-10-05T12:12:00.000Z")] }).flags,
  ).not.toContain("reports failing");
  now = Date.parse("2026-10-05T14:11:00.000Z");
  expect(store.observe({ occupantId: "session-worker-1", seatId: "seat-1", owner }).flags).not.toContain(
    "no progress in 2h",
  );
});

it("flags undelivered reports and refused routes while preserving owner isolation", async () => {
  const dir = await directory();
  const store = new SeatEfficiencyStore(join(dir, "efficiency.json"), { now: () => now });
  const input = { occupantId: "session-worker-1", seatId: "seat-1", owner };
  for (const state of ["pending", "attempting", "uncertain"] as const)
    expect(store.observe({ ...input, reports: [report(state)] }).flags).toContain("reports failing");
  expect(
    store.observe({ ...input, reportRoute: { source: "refused", reason: "owner_removed" } }).flags,
  ).toContain("reports failing");
  store.review({
    occupantId: input.occupantId,
    owner,
    offScope: true,
    evidence: "Original owner's inspected verdict",
  });
  const adopted = store.observe({ ...input, owner: { conversationId: "other-lead" } });
  expect(adopted.flags).toEqual([]);
  expect(adopted).not.toHaveProperty("lastProgressAt");
  expect(() =>
    store.review({
      occupantId: "session-worker-1",
      owner,
      evidence: "Wrong owner",
      offScope: true,
    }),
  ).toThrow(/owner does not match/u);
  expect(() => store.review({ occupantId: "different-occupant", owner, evidence: "No observation" })).toThrow(
    /unavailable/u,
  );
});

it("flags comparable explicit assignment mismatch and reviewed paused work, preserving unknown UUID/display correspondence", async () => {
  const dir = await directory();
  const store = new SeatEfficiencyStore(join(dir, "efficiency.json"), { now: () => now });
  store.assign("session-worker-1", { owner, deliverable: "VUH-1662" });
  const input = { occupantId: "session-worker-1", seatId: "seat-1", owner, status: "working" };
  expect(store.observe({ ...input, assignment: assignment("VUH-1608") }).flags).toContain("off-scope");
  expect(store.observe({ ...input, assignment: assignment(sessionId) }).flags).not.toContain("off-scope");
  store.review({
    occupantId: input.occupantId,
    owner,
    assignmentStatus: "paused",
    evidence: "Owner paused this deliverable",
  });
  expect(store.observe(input).flags).toContain("off-scope");
  store.review({
    occupantId: input.occupantId,
    owner,
    assignmentStatus: "active",
    offScope: false,
    evidence: "Owner resumed the same deliverable",
  });
  expect(store.observe(input).flags).not.toContain("off-scope");
  expect(
    store.review({
      occupantId: input.occupantId,
      owner,
      assignmentStatus: "done",
      evidence: "Accepted patch",
    }).flags,
  ).toContain("done");
});

it("uses admitted/observed baseline and substantive evidence, not native activity, for stalled progress", async () => {
  const dir = await directory();
  const store = new SeatEfficiencyStore(join(dir, "efficiency.json"), { now: () => now });
  const input = { occupantId: "session-worker-1", seatId: "seat-1", owner, status: "working" };
  expect(
    store.observe({ ...input, telemetry: { lastCommitAt: "2026-10-04T01:00:00.000Z" } }).flags,
  ).not.toContain("no progress in 2h");
  now += 2 * 60 * 60 * 1000;
  expect(store.observe({ ...input, telemetry: { model: "busy-model", contextPercent: 90 } }).flags).toContain(
    "no progress in 2h",
  );
  expect(
    store.review({
      occupantId: input.occupantId,
      owner,
      progressAt: new Date(now).toISOString(),
      evidence: "Inspected focused test result and substantive patch",
    }).flags,
  ).not.toContain("no progress in 2h");
  const before = await stat(join(dir, "efficiency.json"));
  now += 1000;
  store.observe(input).flags.push("caller decoration");
  const updated = await stat(join(dir, "efficiency.json"));
  now += 1000;
  expect(store.observe(input).flags).not.toContain("caller decoration");
  expect((await stat(join(dir, "efficiency.json"))).mtimeMs).toBe(updated.mtimeMs);
  expect(updated.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
});

it("honors old admitted assignment, distinguishes native paused work, and omits requested effective settings", async () => {
  const dir = await directory();
  const store = new SeatEfficiencyStore(join(dir, "efficiency.json"), { now: () => now });
  store.assign("session-worker-1", {
    owner,
    assignedAt: "2026-10-05T09:00:00.000Z",
    model: "requested-model",
    effort: "requested-effort",
  });
  const input = { occupantId: "session-worker-1", seatId: "seat-1", owner };
  const result = store.observe(input);
  expect(result.flags).toContain("no progress in 2h");
  expect(result).not.toHaveProperty("model");
  expect(result).not.toHaveProperty("effort");
  const goal = {
    objective: "Paused task",
    status: "paused" as const,
    tokensUsed: 999999,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  expect(store.observe({ ...input, status: "working", goal }).flags).toContain("off-scope");
  expect(store.observe({ ...input, status: "working", goal }).flags).not.toContain("idle");
  expect(store.observe({ ...input, status: "idle", goal }).flags).toContain("idle");
  expect(store.observe({ ...input, status: "idle", goal }).flags).not.toContain("off-scope");
  store.assign("session-worker-1", { owner: { conversationId: "new-owner" }, deliverable: "VUH-1662" });
  expect(store.observe({ ...input, owner: { conversationId: "new-owner" } }).flags).toEqual([]);
});

it("uses a bounded real git HEAD timestamp as commit evidence without creating or changing worker work", async () => {
  const dir = await directory();
  await exec("git", ["init", "--quiet", dir]);
  await writeFile(join(dir, "result.txt"), "A focused patch\n");
  await exec("git", ["-C", dir, "add", "result.txt"]);
  await exec(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Focused fixture patch",
    ],
    {
      env: {
        ...process.env,
        GIT_COMMITTER_DATE: "2026-10-05T12:30:00Z",
        GIT_AUTHOR_DATE: "2026-10-05T12:30:00Z",
      },
    },
  );
  const path = join(dir, "native.jsonl");
  await writeFile(path, nativeCodex());
  const before = await readFile(join(dir, ".git", "HEAD"));
  expect(await readSeatTelemetry({ ...observed(path), workingDirectory: dir })).toMatchObject({
    lastCommitAt: "2026-10-05T12:30:00.000Z",
  });
  expect(
    await readSeatTelemetry({ ...observed(join(dir, "missing-native.jsonl")), workingDirectory: dir }),
  ).toEqual({ lastCommitAt: "2026-10-05T12:30:00.000Z" });
  expect(await readSeatTelemetry({ ...observed(path, "opencode"), workingDirectory: dir })).toEqual({
    lastCommitAt: "2026-10-05T12:30:00.000Z",
  });
  expect(await readFile(join(dir, ".git", "HEAD"))).toEqual(before);
});
