/**
 * VUH-1458: a Claude seat stays the interactive TUI and is driven through the
 * clankie-worker plugin — channel in, transcript receipt, Stop hook out.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeatView } from "@clankie/agent-hosts";
import {
  SeatHookLog,
  channelBody,
  claudeWorkerChannelConsent,
  claudeWorkerLaunchArgs,
  createClaudeWorkerSeatAdapter,
  managedPolicyApprovesWorker,
  type WorkerSeatAgent,
} from "../src/captain/claude-worker-seat.ts";
import type { HerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-worker-seat-"));
  roots.push(root);
  return root;
}
const SESSION = "10000000-0000-4000-8000-000000000001";
const channel = (text: string) =>
  `<channel source="swarm" kind="message" conversation="conv-1" source="captain" event_id="seat-1">\n${text}\n</channel>`;

describe("consent", () => {
  it("needs the installed plugin and an owner-approved channel, and names the fix for each", async () => {
    const root = await scratch();
    const policy = join(root, "managed-settings.json");
    const installed = async () => JSON.stringify([{ id: "clankie-worker@clankie", enabled: false }]);
    const missing = await claudeWorkerChannelConsent({
      managedSettingsPath: policy,
      listPlugins: async () => "[]",
    });
    expect(missing).toMatchObject({ approved: false, detail: "clankie-worker@clankie is not installed." });
    expect(missing.approved === false && missing.fix).toContain(
      "claude plugin install clankie-worker@clankie",
    );

    const unapproved = await claudeWorkerChannelConsent({
      managedSettingsPath: policy,
      listPlugins: installed,
    });
    expect(unapproved.approved === false && unapproved.fix).toContain('"allowedChannelPlugins"');

    await writeFile(
      policy,
      JSON.stringify({ allowedChannelPlugins: [{ marketplace: "clankie", plugin: "clankie-worker" }] }),
    );
    // An allowlist without channels enabled approves nothing.
    expect(managedPolicyApprovesWorker(policy)).toBe(false);
    await mkdir(join(root, "managed-settings.d"));
    await writeFile(
      join(root, "managed-settings.d", "10-channels.json"),
      JSON.stringify({ channelsEnabled: true }),
    );
    expect(managedPolicyApprovesWorker(policy)).toBe(true);
    expect(await claudeWorkerChannelConsent({ managedSettingsPath: policy, listPlugins: installed })).toEqual(
      {
        approved: true,
      },
    );
    await writeFile(policy, "{not json");
    expect(managedPolicyApprovesWorker(policy)).toBe(false);
  });
});

it("a worker launch enables its plugin for this session only and asks for the approved channel", () => {
  expect(
    claudeWorkerLaunchArgs({
      harness: "claude",
      cwd: "/w",
      brief: "b",
      model: "sonnet",
      effort: "high",
      harnessArgs: ["--plugin-dir", "/skills"],
    }),
  ).toEqual([
    "--settings",
    '{"enabledPlugins":{"clankie-worker@clankie":true}}',
    "--channels",
    "plugin:clankie-worker@clankie",
    "--model",
    "sonnet",
    "--effort",
    "high",
    "--plugin-dir",
    "/skills",
  ]);
  expect(channelBody(channel("line one\nline two"))).toBe("line one\nline two");
  expect(channelBody("plain prompt")).toBeUndefined();
});

it("the hook log settles waiters on Stop, carries StopFailure as an error, and survives a restart", async () => {
  const root = await scratch();
  const path = join(root, "hooks.json");
  const log = new SeatHookLog(path);
  expect(log.knows(SESSION)).toBe(false);
  const next = log.next(SESSION);
  log.record("w1:p1", { schemaVersion: 1, event: "UserPromptSubmit", sessionId: SESSION });
  expect(log.latest(SESSION)).toMatchObject({ type: "turn_started" });
  log.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION, lastMessage: "done" });
  expect(await next).toMatchObject({ type: "turn_completed", ok: true, text: "done" });
  log.record("w1:p1", { schemaVersion: 1, event: "StopFailure", sessionId: SESSION, error: "rate_limit" });
  const reopened = new SeatHookLog(path);
  expect(reopened.knows(SESSION)).toBe(true);
  expect(reopened.latest(SESSION)).toMatchObject({
    type: "turn_completed",
    ok: false,
    stopReason: "rate_limit",
  });
  const aborted = new AbortController();
  const waiting = reopened.next(SESSION, aborted.signal);
  aborted.abort(new Error("gone"));
  await expect(waiting).rejects.toThrow("gone");
});

async function fixture(options: { approved?: boolean; binds?: boolean; echoes?: boolean } = {}) {
  const root = await scratch();
  const hooks = new SeatHookLog(join(root, "hooks.json"));
  const agent: WorkerSeatAgent & { status: string } = {
    paneId: "w1:p1",
    terminalId: "term_0a1b2c",
    status: "idle",
    session: { kind: "id", value: SESSION },
  };
  const entries: HerdrSeatTranscript["entries"][number][] = [];
  let bound = false;
  const deliver = vi.fn(async (_seatId: string, text: string) => {
    if (options.echoes !== false)
      entries.push({
        type: "message",
        id: `e${String(entries.length)}`,
        role: "operator",
        text: channel(text),
      });
    return true;
  });
  const adapter = createClaudeWorkerSeatAdapter({
    consent: async () =>
      options.approved === false
        ? { approved: false, detail: "not approved", fix: "approve it" }
        : { approved: true },
    hooks,
    agent: async () => agent,
    transcript: async () => ({ sessionKey: "k", entries: [...entries] }),
    mailbox: { bound: () => bound, deliver },
    timing: { readyMs: 200, receiptMs: 200, pollMs: 10 },
  });
  const start = vi.fn(async () => {
    if (options.binds !== false) bound = true;
  });
  const view: SeatView = { paneId: "w1:p1", name: "worker-ab12", run: vi.fn(async () => undefined), start };
  return { adapter, view, start, deliver, hooks, agent, entries, unbind: () => (bound = false) };
}

it("a hire starts the interactive TUI, briefs it over the channel, and waits for the transcript receipt", async () => {
  const { adapter, view, start, deliver } = await fixture();
  const started = await adapter.start({ harness: "claude", cwd: "/w", brief: "BRIEF-1 do the thing" }, view);
  expect(started.outcome).toBe("started");
  expect(start).toHaveBeenCalledWith(
    "claude",
    expect.arrayContaining(["--channels", "plugin:clankie-worker@clankie"]),
  );
  expect(deliver).toHaveBeenCalledWith("term_0a1b2c", "BRIEF-1 do the thing");
  if (started.outcome !== "started") return;
  expect(started.control.ref).toEqual({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
  // A restarted service reattaches by the session the plugin reported.
  expect(await adapter.attach(started.control.ref)).toBeDefined();
  expect(
    await adapter.attach({ ...started.control.ref, sessionId: "20000000-0000-4000-8000-000000000002" }),
  ).toBeUndefined();
});

it("without the owner's approval nothing launches and the hire is blocked on the named fix", async () => {
  const { adapter, view, start } = await fixture({ approved: false });
  expect(await adapter.start({ harness: "claude", cwd: "/w", brief: "b" }, view)).toEqual({
    outcome: "blocked",
    reason: "consent_required",
    detail: "not approved",
    fix: "approve it",
  });
  expect(start).not.toHaveBeenCalled();
});

it("a channel that never polls, or a brief that never lands, fails typed", async () => {
  const quiet = await fixture({ binds: false });
  expect(await quiet.adapter.start({ harness: "claude", cwd: "/w", brief: "b" }, quiet.view)).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("channel_unready"),
  });
  expect(quiet.deliver).not.toHaveBeenCalled();
  const lost = await fixture({ echoes: false });
  expect(await lost.adapter.start({ harness: "claude", cwd: "/w", brief: "b" }, lost.view)).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("brief_delivery_unverified"),
  });
  const refused = await fixture();
  refused.start.mockRejectedValueOnce(new Error("agent_not_ready: blocked"));
  expect(
    await refused.adapter.start({ harness: "claude", cwd: "/w", brief: "b" }, refused.view),
  ).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
  });
});

it("messages are acknowledged by the transcript, and completion is the Stop hook's final text", async () => {
  const { adapter, view, hooks, agent, entries, unbind } = await fixture();
  const started = await adapter.start({ harness: "claude", cwd: "/w", brief: "brief" }, view);
  if (started.outcome !== "started") throw new Error(JSON.stringify(started));
  const control = started.control;
  expect(await control.send("follow-up")).toMatchObject({ outcome: "accepted", state: "started" });
  agent.status = "working";
  expect(await control.status()).toBe("working");
  expect(await control.send("while busy")).toMatchObject({ outcome: "accepted", state: "queued" });

  const settled = control.settled();
  hooks.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION, lastMessage: "all green" });
  expect(await settled).toMatchObject({ type: "turn_completed", ok: true, text: "all green" });
  agent.status = "idle";
  expect(await control.settled()).toMatchObject({ type: "turn_completed", text: "all green" });
  agent.status = "blocked";
  expect(await control.settled()).toMatchObject({ type: "blocked" });
  expect(await control.interrupt()).toBe(false);

  entries.length = 0;
  const unconfirmed = await fixture({ echoes: false });
  const quiet = await unconfirmed.adapter.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
  expect(quiet).toBeUndefined();

  unbind();
  expect(await control.status()).toBe("released");
  expect(await control.send("after the channel went away")).toEqual({ outcome: "released" });
  expect(await control.settled()).toMatchObject({ type: "released" });
});
