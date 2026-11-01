/**
 * VUH-1458: a Claude seat stays the interactive TUI and is driven through the
 * clankie-worker plugin — channel in, transcript receipt, Stop hook out.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StopNativeTaskResultSchema } from "@clankie/protocol";
import type { SeatLaunch, SeatView } from "@clankie/agent-hosts";
import {
  SeatHookLog,
  channelBody,
  claudeWorkerChannelConsent,
  claudeWorkerLaunchArgs,
  createClaudeWorkerSeatAdapter,
  managedPolicyApprovesWorker,
  type ClaudeWorkerSeatDeps,
  type WorkerSeatAgent,
} from "../src/captain/claude-worker-seat.ts";
import { parseHerdrSeatTranscript, type HerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";
import { createHerdrWatchRunner, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";

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
  it("reports a failed plugin inspection instead of claiming the plugin is missing", async () => {
    expect(
      await claudeWorkerChannelConsent({
        listPlugins: async () => {
          throw new Error("inspection timed out");
        },
      }),
    ).toMatchObject({
      approved: false,
      detail: "Could not inspect installed Claude plugins: inspection timed out",
    });
  });
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
    '{"autoCompactWindow":500000,"enabledPlugins":{"clankie-worker@clankie":true},"permissions":{"allow":["mcp__plugin_clankie-worker_worker","mcp__plugin_clankie-worker_clankie"],"defaultMode":"auto"}}',
    "--channels",
    "plugin:clankie-worker@clankie",
    "--model",
    "sonnet",
    "--effort",
    "high",
    "--plugin-dir",
    "/skills",
  ]);
  expect(
    claudeWorkerLaunchArgs({ harness: "claude", cwd: "/w", brief: "b" }, [
      "mcp__claude_ai_Linear",
      "mcp__linear-server",
    ])[1],
  ).toBe(
    '{"autoCompactWindow":500000,"enabledPlugins":{"clankie-worker@clankie":true},"permissions":{"allow":["mcp__plugin_clankie-worker_worker","mcp__plugin_clankie-worker_clankie"],"defaultMode":"auto","deny":["mcp__claude_ai_Linear","mcp__linear-server"]}}',
  );
  expect(channelBody(channel("line one\nline two"))).toBe("line one\nline two");
  expect(channelBody("plain prompt")).toBeUndefined();
});

it.each([true, false])(
  "resumes the exact Claude session without sending an empty or misrouted brief (matching: %s)",
  async (matching) => {
    const root = await scratch();
    const deliver = vi.fn(async () => true);
    const start = vi.fn(async (_command: string, _args: readonly string[]) => undefined);
    const adapter = createClaudeWorkerSeatAdapter({
      fleetGates: async () => ({
        everydayWork: "allow",
        leavesMac: "lead",
        hardToUndo: "owner",
        moneyAndAccounts: "owner",
      }),
      consent: async () => ({ approved: true }),
      hooks: new SeatHookLog(join(root, "hooks.json")),
      agent: async () => ({
        paneId: "w1:p1",
        terminalId: "term_one",
        agent: "claude",
        status: "idle",
        session: { source: "herdr:claude", kind: "id", value: matching ? SESSION : "other-session" },
      }),
      transcript: async () => undefined,
      mailbox: { bound: () => true, deliver },
      timing: { readyMs: 10, pollMs: 1 },
      trackerDeny: (cwd) => [`mcp__tracker_for_${cwd.length > 0 ? "cwd" : "none"}`],
    });
    const result = await adapter.start(
      { harness: "claude", cwd: root, brief: matching ? "" : "do not send", resumeSessionId: SESSION },
      { paneId: "w1:p1", start, run: async () => undefined },
    );
    expect(start).toHaveBeenCalledWith("claude", expect.arrayContaining(["--resume", SESSION]));
    const settings = JSON.parse(await readFile(start.mock.calls[0]![1]![1]!, "utf8"));
    expect(settings.permissions).toEqual({
      defaultMode: "auto",
      allow: ["mcp__plugin_clankie-worker_worker", "mcp__plugin_clankie-worker_clankie"],
      deny: ["mcp__tracker_for_cwd"],
    });
    expect(settings.permissions.ask).toBeUndefined();
    expect(settings.permissions.allow).not.toContain("Bash");

    // Its Linear writes go through Clankie's account: inherited connectors are denied for the session.
    expect(result.outcome).toBe(matching ? "started" : "failed");
    expect(deliver).not.toHaveBeenCalled();
  },
);

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
  const deliver = vi.fn<ClaudeWorkerSeatDeps["mailbox"]["deliver"]>(async (_seatId, text) => {
    if (options.echoes !== false)
      entries.push({
        type: "message",
        id: `e${String(entries.length)}`,
        role: "operator",
        text: channel(text),
      });
    return true;
  });
  const agentRead = vi.fn<ClaudeWorkerSeatDeps["agent"]>(async () => agent);
  const transcript = vi.fn<ClaudeWorkerSeatDeps["transcript"]>(async () => ({
    sessionKey: "k",
    entries: [...entries],
  }));
  const deps: ClaudeWorkerSeatDeps = {
    consent: async () =>
      options.approved === false
        ? { approved: false, detail: "not approved", fix: "approve it" }
        : { approved: true },
    hooks,
    agent: agentRead,
    transcript,
    mailbox: { bound: () => bound, deliver },
    timing: { readyMs: 200, receiptMs: 200, pollMs: 10, firstTurnMs: 50 },
    trackerDeny: () => [],
  };
  const adapter = createClaudeWorkerSeatAdapter(deps);
  const start = vi.fn(async () => {
    if (options.binds !== false) bound = true;
  });
  const view: SeatView = { paneId: "w1:p1", name: "worker-ab12", run: vi.fn(async () => undefined), start };
  return {
    root,
    deps,
    agentRead,
    transcript,
    adapter,
    view,
    start,
    deliver,
    hooks,
    agent,
    entries,
    unbind: () => (bound = false),
  };
}

it("consumes restart consent once for the exact admitted launch across the native start boundary", async () => {
  const f = await fixture();
  let approved = true;
  const consent = vi.fn<ClaudeWorkerSeatDeps["consent"]>(async () =>
    approved ? { approved: true } : { approved: false, detail: "changed after admission", fix: "approve it" },
  );
  const adapter = createClaudeWorkerSeatAdapter({ ...f.deps, consent });
  const launch: SeatLaunch = { harness: "claude", cwd: f.root, brief: "" };
  await adapter.admitRestart!(launch);
  approved = false;

  // A copied launch cannot spend the original's admission.
  expect(await adapter.start({ ...launch }, f.view)).toMatchObject({
    outcome: "blocked",
    reason: "consent_required",
  });
  expect(f.start).not.toHaveBeenCalled();
  const checksBeforeAdmittedStart = consent.mock.calls.length;
  const guard = vi.fn(async () => {});
  expect(await adapter.start(launch, { ...f.view, guard })).toMatchObject({ outcome: "started" });
  expect(f.start).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalled();
  expect(consent).toHaveBeenCalledTimes(checksBeforeAdmittedStart);

  // Successful startup consumes the token; neither this object nor another launch can reuse it.
  expect(await adapter.start(launch, f.view)).toMatchObject({
    outcome: "blocked",
    reason: "consent_required",
  });
  expect(await adapter.start({ harness: "claude", cwd: f.root, brief: "other" }, f.view)).toMatchObject({
    outcome: "blocked",
    reason: "consent_required",
  });
  expect(consent).toHaveBeenCalledTimes(checksBeforeAdmittedStart + 2);
  expect(f.start).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "refused Claude admission leaves no restart token (previously admitted: %s)",
  async (previouslyAdmitted) => {
    const f = await fixture();
    let approved = previouslyAdmitted;
    const consent = vi.fn<ClaudeWorkerSeatDeps["consent"]>(async () =>
      approved ? { approved: true } : { approved: false, detail: "owner consent absent", fix: "approve it" },
    );
    const adapter = createClaudeWorkerSeatAdapter({ ...f.deps, consent });
    const launch: SeatLaunch = { harness: "claude", cwd: f.root, brief: "" };
    if (previouslyAdmitted) await adapter.admitRestart!(launch);
    approved = false;
    await expect(adapter.admitRestart!(launch)).rejects.toThrow("consent_required");
    expect(await adapter.start(launch, f.view)).toMatchObject({
      outcome: "blocked",
      reason: "consent_required",
    });
    expect(consent).toHaveBeenCalledTimes(previouslyAdmitted ? 3 : 2);
    expect(f.start).not.toHaveBeenCalled();
  },
);

it("a resumed hire starts the interactive TUI, briefs it over the channel, and waits for the transcript receipt", async () => {
  const { adapter, view, start, deliver } = await fixture();
  const started = await adapter.start(
    { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "BRIEF-1 do the thing" },
    view,
  );
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

it("a resume hire briefs the session it last messaged in another terminal (VUH-2060)", async () => {
  const f = await fixture();
  // The live shape: the session's last dispatch was in its old terminal and pane.
  f.hooks.beginDispatch({ harness: "claude", sessionId: SESSION, paneId: "w1:p0" }, "term_old");
  const started = await f.adapter.start(
    { harness: "claude", cwd: "/w", brief: "BRIEF-2 carry on", resumeSessionId: SESSION },
    f.view,
  );
  expect(started.outcome).toBe("started");
  expect(f.deliver).toHaveBeenCalledWith("term_0a1b2c", "BRIEF-2 carry on");
  expect(f.hooks.snapshot(SESSION)).toMatchObject({
    paneId: "w1:p1",
    dispatch: { terminalId: "term_0a1b2c" },
  });
  // Only the adapter's own verified launch rebinds; a reopened log still refuses another terminal.
  const replacement = createClaudeWorkerSeatAdapter({
    ...f.deps,
    hooks: new SeatHookLog(join(f.root, "hooks.json")),
    agent: async () => ({ ...f.agent, terminalId: "another-native-terminal" }),
  });
  expect(
    await replacement.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" }),
  ).toBeUndefined();
});

it("preserves a taken but unacknowledged channel event as uncertain without replaying it", async () => {
  const f = await fixture();
  const started = await f.adapter.start(
    { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "" },
    f.view,
  );
  if (started.outcome !== "started") throw new Error(JSON.stringify(started));
  const receipt = {
    outcome: "unconfirmed" as const,
    messageId: "seat-taken",
    detail: "The bridge took the event but did not acknowledge it",
  };
  f.deliver.mockResolvedValueOnce(receipt);
  expect(await started.control.send("follow-up")).toEqual({ ...receipt, deliveryStage: "uncertain" });
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.view.run).not.toHaveBeenCalled();
  expect(f.entries).toEqual([]);
});

it("rechecks peer authority after awaited transcript preparation before channel dispatch", async () => {
  const f = await fixture();
  const started = await f.adapter.start(
    { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "" },
    f.view,
  );
  if (started.outcome !== "started") throw new Error(JSON.stringify(started));
  let prepared!: () => void;
  let resume!: () => void;
  const preparation = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const continuePreparation = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.transcript.mockImplementationOnce(async () => {
    prepared();
    await continuePreparation;
    return { sessionKey: "k", entries: [] };
  });
  let authorized = true;
  const beforeDispatch = vi.fn(async () => authorized);
  const beginDispatch = vi.spyOn(f.hooks, "beginDispatch");
  const pending = started.control.send("peer work", { beforeDispatch });
  await preparation;
  authorized = false;
  resume();
  expect(await pending).toMatchObject({ outcome: "offline", deliveryStage: "unavailable" });
  expect(beforeDispatch).toHaveBeenCalledOnce();
  expect(beginDispatch).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
  authorized = true;
  expect(
    await started.control.send("new admitted work", {
      beforeDispatch,
      source: "peer",
      recipientBinding: "native-recipient-binding",
    }),
  ).toMatchObject({
    outcome: "accepted",
  });
  expect(f.deliver).toHaveBeenCalledOnce();
  expect(f.deliver).toHaveBeenCalledWith(
    f.agent.terminalId,
    "new admitted work",
    "peer",
    "native-recipient-binding",
  );
});

it("keeps an uncertain brief distinct from a released channel", async () => {
  const f = await fixture();
  f.deliver.mockResolvedValueOnce({
    outcome: "unconfirmed",
    messageId: "seat-brief",
    detail: "The bridge took the brief but did not acknowledge it",
  });
  expect(
    await f.adapter.start({ resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "brief" }, f.view),
  ).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringMatching(/brief_delivery_unverified: .*unconfirmed.*seat-brief/u),
  });
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.view.run).not.toHaveBeenCalled();
});

it.each(["string", "blocks"])(
  "verifies native Claude channel receipts marked as system metadata (%s)",
  async (contentShape) => {
    const root = await scratch();
    const path = join(root, `${SESSION}.jsonl`);
    const agent: HerdrAgentSnapshot = {
      paneId: "w1:p1",
      terminalId: "term_0a1b2c",
      agent: "claude",
      status: "idle",
      title: "probe",
      session: { source: "herdr:claude", kind: "path", value: path },
    };
    // The real probe's user record had both flags. Its following instruction
    // attachments linked that user record to Claude's visible reply.
    await writeFile(path, "");
    let parentUuid: string | null = null;
    let count = 0;
    const deliver = vi.fn(async (_seat: string, text: string) => {
      const uuid = `receipt-${++count}`;
      const prompt = `<channel source="plugin:clankie-worker:swarm" kind="message" source="captain" event_id="seat-${count}">\n${text}\n</channel>`;
      const records = [
        {
          type: "user",
          uuid,
          parentUuid,
          isMeta: true,
          promptSource: "system",
          origin: { kind: "channel", server: "plugin:clankie-worker:swarm" },
          turnOrigin: "peer",
          queueSkipAttachments: true,
          message: {
            role: "user",
            content: contentShape === "string" ? prompt : [{ type: "text", text: prompt }],
          },
        },
        {
          type: "attachment",
          uuid: `${uuid}-instructions`,
          parentUuid: uuid,
          attachment: { type: "instructions", files: [] },
        },
        {
          type: "user",
          uuid: `${uuid}-meta`,
          parentUuid: `${uuid}-instructions`,
          isMeta: true,
          promptSource: "system",
          message: { role: "user", content: "ordinary system metadata stays hidden" },
        },
        {
          type: "assistant",
          uuid: `${uuid}-reply`,
          parentUuid: `${uuid}-meta`,
          message: { role: "assistant", content: [{ type: "text", text: "PROBE OK" }] },
        },
      ];
      await appendFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      parentUuid = `${uuid}-reply`;
      return true;
    });
    const runner = createHerdrWatchRunner();
    const adapter = createClaudeWorkerSeatAdapter({
      consent: async () => ({ approved: true }),
      hooks: new SeatHookLog(join(root, "hooks.json")),
      agent: async () => agent,
      transcript: () => runner.transcript!(agent),
      mailbox: { bound: () => true, deliver },
      timing: { readyMs: 20, receiptMs: 20, pollMs: 1, firstTurnMs: 10 },
      trackerDeny: () => [],
    });
    const start = vi.fn(async (_command: string, _args: readonly string[]) => undefined);
    const view: SeatView = { paneId: agent.paneId, run: vi.fn(async () => undefined), start };
    const started = await adapter.start(
      {
        resumeSessionId: SESSION,
        harness: "claude",
        cwd: root,
        model: "haiku",
        brief: "Reply exactly PROBE OK.",
      },
      view,
    );
    expect(started.outcome).toBe("started");
    if (started.outcome !== "started") throw new Error(JSON.stringify(started));
    expect(await started.control.send("Reply exactly PROBE OK.")).toMatchObject({
      outcome: "accepted",
      messageId: "claude:receipt-2",
    });
    const receipts = (await runner.transcript!(agent))!.entries;
    expect(receipts.filter((entry) => entry.type === "message" && entry.internal)).toHaveLength(2);
    expect(
      receipts.some((entry) => entry.type === "message" && entry.text.includes("ordinary system metadata")),
    ).toBe(false);
    expect(
      parseHerdrSeatTranscript("claude", await readFile(path, "utf8")).map(
        (entry) => entry.type === "message" && entry.text,
      ),
    ).toEqual(["PROBE OK", "PROBE OK"]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(view.run).not.toHaveBeenCalled();
  },
);

it("verifies the recorded 2.1.286 probe and rejects a preexisting receipt or changed body", async () => {
  const native = JSON.parse(
    await readFile(new URL("./fixtures/claude-worker-channel.json", import.meta.url), "utf8"),
  );
  const brief = channelBody(native.message.content)!;
  for (const kind of ["new", "preexisting", "mismatch", "missing"] as const) {
    const root = await scratch();
    const path = join(root, `${SESSION}.jsonl`);
    await writeFile(path, kind === "preexisting" ? JSON.stringify(native) : "");
    const agent: HerdrAgentSnapshot = {
      paneId: "w1:p1",
      terminalId: "term_0a1b2c",
      agent: "claude",
      status: "idle",
      title: "probe",
      session: { source: "herdr:claude", kind: "path", value: path },
    };
    const runner = createHerdrWatchRunner();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const adapter = createClaudeWorkerSeatAdapter({
        consent: async () => ({ approved: true }),
        hooks: new SeatHookLog(join(root, "hooks.json")),
        agent: async () => agent,
        transcript: async () => (kind === "missing" ? undefined : runner.transcript!(agent)),
        mailbox: {
          bound: () => true,
          deliver: async () => {
            if (kind !== "preexisting") await writeFile(path, JSON.stringify(native));
            return true;
          },
        },
        timing: { readyMs: 10, receiptMs: 10, pollMs: 1, firstTurnMs: 10 },
      });
      const result = await adapter.start(
        {
          resumeSessionId: SESSION,
          harness: "claude",
          cwd: root,
          brief: kind === "mismatch" ? brief + " altered" : brief,
        },
        { paneId: agent.paneId, run: async () => undefined, start: async () => undefined },
      );
      expect(result.outcome).toBe(kind === "new" ? "started" : "failed");
      if (kind === "new") expect(warning).not.toHaveBeenCalled();
      else {
        const diagnostic = JSON.parse(warning.mock.calls[0]![1]);
        expect(diagnostic).toEqual({
          harness: "claude",
          paneId: agent.paneId,
          sessionId: SESSION,
          transcriptPath: path,
          rejectingRule:
            kind === "missing"
              ? "transcript_unavailable"
              : kind === "preexisting"
                ? "no_new_operator_message"
                : "complete_body_mismatch",
        });
        expect(JSON.stringify(diagnostic)).not.toContain(brief);
      }
    } finally {
      warning.mockRestore();
    }
  }
});

it("without the owner's approval nothing launches and the hire is blocked on the named fix", async () => {
  const { adapter, view, start } = await fixture({ approved: false });
  expect(
    await adapter.start({ resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "b" }, view),
  ).toEqual({
    outcome: "blocked",
    reason: "consent_required",
    detail: "not approved",
    fix: "approve it",
  });
  expect(start).not.toHaveBeenCalled();
});

it("a channel that never polls, or a brief that never lands, fails typed", async () => {
  const quiet = await fixture({ binds: false });
  expect(
    await quiet.adapter.start(
      { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "b" },
      quiet.view,
    ),
  ).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("channel_unready"),
  });
  expect(quiet.deliver).not.toHaveBeenCalled();
  const lost = await fixture({ echoes: false });
  expect(
    await lost.adapter.start(
      { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "b" },
      lost.view,
    ),
  ).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("brief_delivery_unverified"),
  });
  const refused = await fixture();
  refused.start.mockRejectedValueOnce(new Error("agent_not_ready: blocked"));
  expect(
    await refused.adapter.start(
      { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "b" },
      refused.view,
    ),
  ).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
  });
});

it("messages have transcript receipts, while Stop text remains separate from message completion", async () => {
  const { adapter, view, hooks, agent, entries, unbind } = await fixture();
  const started = await adapter.start(
    { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "brief" },
    view,
  );
  if (started.outcome !== "started") throw new Error(JSON.stringify(started));
  const control = started.control;
  expect(await control.send("follow-up")).toMatchObject({ outcome: "accepted", state: "queued" });
  agent.status = "working";
  expect(await control.status()).toBe("working");
  expect(await control.send("while busy")).toMatchObject({ outcome: "accepted", state: "queued" });

  const settled = control.settled();
  hooks.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION, lastMessage: "all green" });
  expect(await settled).toMatchObject({
    type: "settlement_unconfirmed",
    observedStop: { ok: true, text: "all green" },
  });
  agent.status = "idle";
  expect(await control.settled()).toMatchObject({
    type: "settlement_unconfirmed",
    observedStop: { text: "all green" },
  });
  agent.status = "blocked";
  expect(await control.settled()).toMatchObject({ type: "blocked" });
  expect(await control.interrupt()).toBe(false);

  entries.length = 0;
  const unconfirmed = await fixture({ echoes: false });
  const quiet = await unconfirmed.adapter.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
  expect(quiet).toBeUndefined();

  unbind();
  expect(await control.status()).toBe("blocked");
  expect(await control.send("after the channel went away")).toEqual({
    outcome: "released",
    deliveryStage: "unavailable",
  });
  expect(await control.settled()).toMatchObject({ type: "blocked" });
});

it("a brief whose turn Claude refuses for its sign-in fails the hire typed, not started (VUH-2241)", async () => {
  const f = await fixture();
  f.deliver.mockImplementationOnce(async (_seat, text) => {
    f.entries.push({ type: "message", id: "brief-receipt", role: "operator", text: channel(text) });
    // The live shape: Claude takes the brief, then its StopFailure arrives
    // about a second later (Sable and Quill, 2026-10-14).
    setTimeout(
      () =>
        f.hooks.record("w1:p1", {
          schemaVersion: 1,
          event: "StopFailure",
          sessionId: SESSION,
          error: "authentication_failed",
          lastMessage: "Login expired · Please run /login",
        }),
      20,
    );
    return true;
  });
  const failed = await f.adapter.start(
    { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "brief" },
    f.view,
  );
  expect(failed).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
  expect((failed as { detail: string }).detail).toMatch(/^sign_in_failed: .*Login expired/u);
  // Any other first-turn ending, or none within the window, is a started worker.
  const other = await fixture();
  other.deliver.mockImplementationOnce(async (_seat, text) => {
    other.entries.push({ type: "message", id: "brief-receipt", role: "operator", text: channel(text) });
    other.hooks.record("w1:p1", {
      schemaVersion: 1,
      event: "StopFailure",
      sessionId: SESSION,
      error: "rate_limit",
    });
    return true;
  });
  expect(
    (
      await other.adapter.start(
        { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "brief" },
        other.view,
      )
    ).outcome,
  ).toBe("started");
});

it("rechecks the hiring source after readiness before delivering its initial brief", async () => {
  const { adapter, view, start, deliver } = await fixture();
  const guard = vi.fn(async () => {
    throw new Error("hiring actor revoked");
  });
  await expect(
    adapter.start(
      { resumeSessionId: SESSION, harness: "claude", cwd: tmpdir(), brief: "must remain unsent" },
      { ...view, guard },
    ),
  ).rejects.toThrow("hiring actor revoked");
  expect(start).not.toHaveBeenCalled();
  expect(guard).toHaveBeenCalledOnce();
  expect(deliver).not.toHaveBeenCalled();
});

describe("Claude completion evidence", () => {
  async function ready() {
    const f = await fixture();
    const result = await f.adapter.start(
      { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "" },
      f.view,
    );
    if (result.outcome !== "started") throw new Error(JSON.stringify(result));
    return { ...f, control: result.control };
  }

  it("idle without a Stop never manufactures successful completion", async () => {
    const f = await ready();
    expect(await f.control.settled()).toMatchObject({ type: "settlement_unconfirmed" });
  });

  it("a new receipt cannot reuse the old Stop as completion", async () => {
    const f = await ready();
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION, lastMessage: "old turn" });
    expect(await f.control.send("next turn")).toMatchObject({ outcome: "accepted" });
    expect(await f.control.settled()).toEqual(
      expect.objectContaining({
        type: "settlement_unconfirmed",
        reason: "message_correlation_unavailable",
      }),
    );
    expect(await f.control.settled()).not.toHaveProperty("observedStop");
  });

  it("a queued channel receipt followed by the busy turn's Stop remains uncorrelated", async () => {
    const f = await ready();
    f.agent.status = "working";
    expect(await f.control.send("queued followup")).toMatchObject({ outcome: "accepted", state: "queued" });
    const waiting = f.control.settled();
    f.hooks.record("w1:p1", {
      schemaVersion: 1,
      event: "Stop",
      sessionId: SESSION,
      lastMessage: "earlier turn",
    });
    expect(await waiting).toMatchObject({
      type: "settlement_unconfirmed",
      reason: "message_correlation_unavailable",
      observedStop: { ok: true, text: "earlier turn" },
    });
  });

  it("a wait armed after a retained Stop ignores it while Claude works, then reports the new Stop", async () => {
    const f = await ready();
    await f.control.send("automated followup");
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION, lastMessage: "pre-arm" });
    f.agent.status = "working";
    const waiting = f.control.settled();
    const pending = Symbol("pending");
    expect(await Promise.race([waiting, new Promise((resolve) => setTimeout(resolve, 150, pending))])).toBe(
      pending,
    );
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION, lastMessage: "new" });
    expect(await waiting).toMatchObject({
      type: "settlement_unconfirmed",
      reason: "message_correlation_unavailable",
      observedStop: { text: "new" },
    });
  });

  it("keeps a fast Stop during initial dispatch without calling the brief completed", async () => {
    const f = await fixture();
    f.deliver.mockImplementationOnce(async (_seat, text) => {
      f.entries.push({ type: "message", id: "fast-receipt", role: "operator", text: channel(text) });
      f.hooks.record("w1:p1", {
        schemaVersion: 1,
        event: "Stop",
        sessionId: SESSION,
        lastMessage: "fast native stop",
      });
      return true;
    });
    const result = await f.adapter.start(
      { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "brief" },
      f.view,
    );
    if (result.outcome !== "started") throw new Error(JSON.stringify(result));
    expect(await result.control.settled()).toMatchObject({
      type: "settlement_unconfirmed",
      observedStop: { ok: true, text: "fast native stop" },
    });
  });

  it("new attach and a reopened hook log preserve dispatch uncertainty", async () => {
    const f = await ready();
    await f.control.send("accepted message");
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION });
    for (const hooks of [f.hooks, new SeatHookLog(join(f.root, "hooks.json"))]) {
      const adapter = createClaudeWorkerSeatAdapter({ ...f.deps, hooks });
      const attached = await adapter.attach(f.control.ref);
      expect(attached).toBeDefined();
      expect(await attached!.settled()).toMatchObject({
        type: "settlement_unconfirmed",
        reason: "message_correlation_unavailable",
      });
    }
  });

  it("legacy state never infers that no automated dispatch was pending", async () => {
    const f = await ready();
    await writeFile(
      join(f.root, "hooks.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [SESSION]: {
            paneId: "w1:p1",
            last: { type: "turn_completed", at: "2026-10-04T00:00:00Z", ok: true, text: "legacy stop" },
          },
        },
      }),
    );
    const hooks = new SeatHookLog(join(f.root, "hooks.json"));
    const attached = await createClaudeWorkerSeatAdapter({ ...f.deps, hooks }).attach(f.control.ref);
    expect(await attached!.settled()).toMatchObject({
      type: "settlement_unconfirmed",
      reason: "dispatch_boundary_unknown",
      observedStop: { ok: true, text: "legacy stop" },
    });
  });

  it("a boundary save failure prevents any channel handoff", async () => {
    const f = await ready();
    await rm(join(f.root, "hooks.json"));
    await mkdir(join(f.root, "hooks.json"));
    expect(await f.control.send("must not cross")).toMatchObject({ outcome: "unconfirmed" });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("an already-aborted settlement never returns cached success or reads status", async () => {
    const f = await ready();
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    f.agentRead.mockClear();
    await expect(f.control.settled(abort.signal)).rejects.toThrow("cancelled");
    expect(f.agentRead).not.toHaveBeenCalled();
  });

  it("a status lookup error is uncertainty rather than evidence of process exit", async () => {
    const f = await ready();
    f.agentRead.mockRejectedValueOnce(new Error("inventory unavailable"));
    expect(await f.control.settled()).toMatchObject({
      type: "settlement_unconfirmed",
      reason: "status_unavailable",
    });
  });

  it.each(["missing", "unreadable"])(
    "%s boundary preserves a manual Stop without inferring no pending message",
    async (kind) => {
      const f = await ready();
      if (kind === "missing") await rm(join(f.root, "hooks.json"));
      else await writeFile(join(f.root, "hooks.json"), "not JSON");
      const hooks = new SeatHookLog(join(f.root, "hooks.json"));
      hooks.record("w1:p1", { schemaVersion: 1, event: "SessionStart", sessionId: SESSION });
      hooks.record("w1:p1", {
        schemaVersion: 1,
        event: "Stop",
        sessionId: SESSION,
        lastMessage: "actual manual report",
      });
      const control = await createClaudeWorkerSeatAdapter({ ...f.deps, hooks }).attach(f.control.ref);
      expect(await control!.settled()).toMatchObject({
        type: "settlement_unconfirmed",
        reason: "dispatch_boundary_unknown",
        observedStop: { ok: true, text: "actual manual report" },
      });
    },
  );

  it("manual StopFailure stays authentic without claiming dispatched-message correlation", async () => {
    const f = await ready();
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "UserPromptSubmit", sessionId: SESSION });
    f.hooks.record("w1:p1", {
      schemaVersion: 1,
      event: "StopFailure",
      sessionId: SESSION,
      error: "rate_limit",
      lastMessage: "native failure",
    });
    expect(f.hooks.latest(SESSION)).toMatchObject({
      type: "turn_completed",
      ok: false,
      stopReason: "rate_limit",
    });
    expect(await f.control.settled()).toMatchObject({
      type: "settlement_unconfirmed",
      reason: "dispatch_boundary_unknown",
      observedStop: { ok: false, stopReason: "rate_limit", text: "native failure" },
    });
  });

  it("a later owner prompt does not clear automated dispatch uncertainty", async () => {
    const f = await ready();
    await f.control.send("automated followup");
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "UserPromptSubmit", sessionId: SESSION });
    f.hooks.record("w1:p1", {
      schemaVersion: 1,
      event: "Stop",
      sessionId: SESSION,
      lastMessage: "owner turn",
    });
    expect(await f.control.settled()).toMatchObject({
      type: "settlement_unconfirmed",
      reason: "message_correlation_unavailable",
    });
  });

  it("overlapping handoffs finishing in reverse order cannot clear the newest boundary", async () => {
    const f = await ready();
    const releases: (() => void)[] = [];
    f.deliver.mockImplementation(async (_seat, text) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      f.entries.push({ type: "message", id: text, role: "operator", text: channel(text) });
      return true;
    });
    const first = f.control.send("first");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = f.control.send("second");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    f.hooks.record("w1:p1", {
      schemaVersion: 1,
      event: "Stop",
      sessionId: SESSION,
      lastMessage: "older busy turn",
    });
    releases[1]!();
    expect(await second).toMatchObject({ outcome: "accepted" });
    releases[0]!();
    expect(await first).toMatchObject({ outcome: "accepted" });
    const hooks = new SeatHookLog(join(f.root, "hooks.json"));
    const control = await createClaudeWorkerSeatAdapter({ ...f.deps, hooks }).attach(f.control.ref);
    expect(await control!.settled()).toMatchObject({
      type: "settlement_unconfirmed",
      reason: "message_correlation_unavailable",
    });
    expect(f.deliver).toHaveBeenCalledTimes(2);
  });

  it("a new dispatch during an awaited status invalidates the prior Stop snapshot", async () => {
    const f = await ready();
    f.hooks.record("w1:p1", {
      schemaVersion: 1,
      event: "Stop",
      sessionId: SESSION,
      lastMessage: "old cached stop",
    });
    let release!: (agent: WorkerSeatAgent) => void;
    f.agentRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const waiting = f.control.settled();
    await f.control.send("new work");
    release(f.agent);
    const result = await waiting;
    expect(result).toMatchObject({
      type: "settlement_unconfirmed",
      reason: "message_correlation_unavailable",
    });
    expect(result).not.toHaveProperty("observedStop");
  });

  it("cancels a settlement even while status is held", async () => {
    const f = await ready();
    const abort = new AbortController();
    let release!: (agent: WorkerSeatAgent) => void;
    f.agentRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const waiting = f.control.settled(abort.signal);
    abort.abort(new Error("owner cancelled"));
    await expect(waiting).rejects.toThrow("owner cancelled");
    release(f.agent);
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION });
  });

  it.each(["terminal", "session", "pane"])("refuses %s replacement during a held status", async (kind) => {
    const f = await ready();
    await f.control.send("held work");
    let release!: (agent: WorkerSeatAgent) => void;
    f.agentRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const waiting = f.control.settled();
    f.hooks.record("w1:p1", {
      schemaVersion: 1,
      event: "Stop",
      sessionId: SESSION,
      lastMessage: "must not cross replacement",
    });
    const replacement = {
      ...f.agent,
      ...(kind === "terminal" ? { terminalId: "replacement" } : {}),
      ...(kind === "session" ? { session: { kind: "id" as const, value: "replacement" } } : {}),
      ...(kind === "pane" ? { paneId: "w1:p2" } : {}),
    };
    f.agentRead.mockResolvedValue(replacement);
    release(replacement);
    expect(await waiting).toMatchObject({ type: "exited" });
  });

  it("owner blockage and actual missing pane outrank an uncorrelated Stop", async () => {
    const f = await ready();
    await f.control.send("work");
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "Stop", sessionId: SESSION });
    f.agent.status = "blocked";
    expect(await f.control.settled()).toMatchObject({ type: "blocked" });
    f.agentRead.mockResolvedValue(undefined);
    expect(await f.control.settled()).toMatchObject({ type: "exited" });
  });

  it("initial brief also refuses dispatch if its durable boundary cannot be saved", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "hooks.json"));
    const result = await f.adapter.start(
      { resumeSessionId: SESSION, harness: "claude", cwd: "/w", brief: "must not send" },
      f.view,
    );
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
      detail: expect.stringContaining("no message was sent"),
    });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("a same-session replacement terminal cannot be adopted through a reopened log", async () => {
    const f = await ready();
    await f.control.send("work");
    const replacement = { ...f.agent, terminalId: "another-native-terminal" };
    const adapter = createClaudeWorkerSeatAdapter({
      ...f.deps,
      hooks: new SeatHookLog(join(f.root, "hooks.json")),
      agent: async () => replacement,
    });
    expect(await adapter.attach(f.control.ref)).toBeUndefined();
  });

  it("an idle channel receipt stays queued while working status is delayed", async () => {
    const f = await ready();
    const delivery = await f.control.send("channel work");
    expect(f.agent.status).toBe("idle");
    expect(
      f.entries.some(
        (entry) =>
          entry.type === "message" && entry.role === "operator" && entry.text.includes("channel work"),
      ),
    ).toBe(true);
    expect(delivery).toMatchObject({ outcome: "accepted", deliveryStage: "consumed", state: "queued" });
    f.agent.status = "working";
    expect(await f.control.status()).toBe("working");
    expect(delivery).toMatchObject({ state: "queued" });
  });
});

describe("Stop presses one Esc only into the exact working Claude with an empty input line (VUH-2680)", () => {
  const golden = (state: string) =>
    readFile(new URL(`./fixtures/pane-draft/claude-${state}.ansi`, import.meta.url), "utf8");
  async function stopFixture(options: { screen?: string | Error; afterEsc?: string; keyError?: Error } = {}) {
    const f = await fixture();
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "SessionStart", sessionId: SESSION });
    f.agent.status = "working";
    // Captured live from a working Claude (VUH-2680): spinner, "esc to interrupt", empty line.
    const screen = options.screen ?? (await golden("busy-empty"));
    const read = vi.fn(async (_paneId: string) => {
      if (screen instanceof Error) throw screen;
      return screen;
    });
    const sendKeys = vi.fn(async (_paneId: string, _keys: readonly string[]) => {
      if (options.keyError) throw options.keyError;
      if (options.afterEsc !== undefined) f.agent.status = options.afterEsc;
    });
    const adapter = createClaudeWorkerSeatAdapter({
      ...f.deps,
      pane: { read, sendKeys },
      timing: { ...f.deps.timing, stopConfirmMs: 100 },
    });
    const control = await adapter.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
    if (control?.stopTask === undefined) throw new Error("Claude control offered no Stop");
    const guard = vi.fn(async () => {});
    return { ...f, adapter, read, sendKeys, guard, stop: control.stopTask.bind(control) };
  }

  it("is absent without pane access, so the roster never advertises it", async () => {
    const f = await fixture();
    f.hooks.record("w1:p1", { schemaVersion: 1, event: "SessionStart", sessionId: SESSION });
    const control = await f.adapter.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
    expect(control).toBeDefined();
    expect(control?.stopTask).toBeUndefined();
    expect(await control?.interrupt()).toBe(false);
  });

  it("reports stopped only after Claude is seen idle again", async () => {
    const f = await stopFixture({ afterEsc: "idle" });
    expect(await f.stop(f.guard)).toEqual({ outcome: "stopped" });
    expect(f.sendKeys.mock.calls).toEqual([["w1:p1", ["esc"]]]);
    expect(f.guard).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledWith("w1:p1");
  });

  it("sends Esc once and reports it unconfirmed when Claude keeps working", async () => {
    const f = await stopFixture();
    expect(await f.stop(f.guard)).toEqual({
      outcome: "uncertain",
      detail: "Esc was sent once, but Claude was not seen to stop; check its pane before trying again.",
    });
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("calls a session that goes away after the key unconfirmed, not stopped", async () => {
    const f = await stopFixture();
    f.sendKeys.mockImplementationOnce(async () => {
      Object.assign(f.agent, { session: { kind: "id", value: "20000000-0000-4000-8000-000000000002" } });
    });
    expect(await f.stop(f.guard)).toEqual({
      outcome: "uncertain",
      detail: "Esc was sent once, then the seat's Claude session went away; check its pane.",
    });
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("a key press that fails may still have landed, so it is uncertain and never repeated", async () => {
    const f = await stopFixture({ keyError: new Error("herdr timed out") });
    expect(await f.stop(f.guard)).toEqual({
      outcome: "uncertain",
      detail: "Esc may have reached Claude; check its pane before trying again.",
    });
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("two requests at once share one Esc", async () => {
    const f = await stopFixture({ afterEsc: "idle" });
    const [first, second] = await Promise.all([f.stop(f.guard), f.stop(f.guard)]);
    expect(first).toEqual({ outcome: "stopped" });
    expect(second).toEqual({ outcome: "stopped" });
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
    // Afterwards Claude is idle, so a later Stop has nothing to interrupt.
    expect(await f.stop(f.guard)).toEqual({ outcome: "already_finished" });
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "an idle Claude",
      arrange: (f: Awaited<ReturnType<typeof stopFixture>>) => {
        f.agent.status = "idle";
      },
      result: { outcome: "already_finished" },
    },
    {
      name: "a Claude waiting on the owner in its pane",
      arrange: (f: Awaited<ReturnType<typeof stopFixture>>) => {
        f.agent.status = "blocked";
      },
      result: {
        outcome: "unavailable",
        detail: "Claude is waiting on the owner in its pane; nothing was sent.",
      },
    },
    {
      name: "a different session in the pane",
      arrange: (f: Awaited<ReturnType<typeof stopFixture>>) => {
        Object.assign(f.agent, { session: { kind: "id", value: "20000000-0000-4000-8000-000000000002" } });
      },
      result: { outcome: "unavailable", detail: "The seat's Claude session is gone; nothing was sent." },
    },
    {
      name: "a different terminal in the pane",
      arrange: (f: Awaited<ReturnType<typeof stopFixture>>) => {
        Object.assign(f.agent, { terminalId: "term_other" });
      },
      result: { outcome: "unavailable", detail: "The seat's Claude session is gone; nothing was sent." },
    },
    {
      name: "an unreadable Herdr status",
      arrange: (f: Awaited<ReturnType<typeof stopFixture>>) => {
        f.agent.status = "unknown";
      },
      result: { outcome: "unavailable", detail: "Claude's status could not be read; nothing was sent." },
    },
  ])("refuses $name without pressing a key", async ({ arrange, result }) => {
    // Attach already observed the pane, binding its terminal, so a swap is visible.
    const f = await stopFixture();
    arrange(f);
    expect(await f.stop(f.guard)).toEqual(result);
    expect(f.sendKeys).not.toHaveBeenCalled();
    expect(f.guard).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an unsent draft typed while Claude works",
      screen: () => golden("busy-draft"),
      reason: "unsent_draft",
      detail: "Claude's input line holds an unsent draft that Esc would clear; nothing was sent.",
    },
    {
      name: "an unsent draft",
      screen: () => golden("draft"),
      reason: "unsent_draft",
      detail: "Claude's input line holds an unsent draft that Esc would clear; nothing was sent.",
    },
    {
      name: "an unstyled screen",
      // oxlint-disable-next-line no-control-regex -- strip the captured native styling
      screen: async () => (await golden("busy-empty")).replace(/\x1b\[[0-9;]*m/gu, ""),
      detail: "Claude's input line could not be read, so a draft can't be ruled out; nothing was sent.",
    },
    {
      name: "a failed pane read",
      screen: async () => new Error("pane read failed"),
      detail: "Claude's input line could not be read, so a draft can't be ruled out; nothing was sent.",
    },
  ])("refuses $name in the input line", async ({ screen, detail, reason }) => {
    const f = await stopFixture({ screen: await screen() });
    expect(StopNativeTaskResultSchema.parse(await f.stop(f.guard))).toEqual({
      outcome: "unavailable",
      detail,
      ...(reason === undefined ? {} : { reason }),
    });
    expect(f.sendKeys).not.toHaveBeenCalled();
    // The input line is the last thing read, after authority and the re-observation.
    expect(f.guard).toHaveBeenCalledTimes(1);
  });

  it("refuses when owner authority or the binding fails its last check", async () => {
    const f = await stopFixture({ afterEsc: "idle" });
    f.guard.mockRejectedValueOnce(new Error("not the owner"));
    expect(await f.stop(f.guard)).toEqual({
      outcome: "unavailable",
      detail: "Native binding or owner authority changed; nothing was sent.",
    });
    expect(f.sendKeys).not.toHaveBeenCalled();
  });

  it("re-observes the session after authority and refuses one that finished or changed meanwhile", async () => {
    const finished = await stopFixture();
    finished.guard.mockImplementationOnce(async () => {
      finished.agent.status = "idle";
    });
    expect(await finished.stop(finished.guard)).toEqual({ outcome: "already_finished" });
    expect(finished.sendKeys).not.toHaveBeenCalled();

    const swapped = await stopFixture();
    swapped.guard.mockImplementationOnce(async () => {
      Object.assign(swapped.agent, { terminalId: "term_other" });
    });
    expect(await swapped.stop(swapped.guard)).toEqual({
      outcome: "unavailable",
      detail: "The seat's Claude session is gone; nothing was sent.",
    });
    expect(swapped.sendKeys).not.toHaveBeenCalled();

    // A draft typed into the pane while authority is checked still blocks the key.
    const typed = await stopFixture({ afterEsc: "idle" });
    const draft = await golden("busy-draft");
    typed.guard.mockImplementationOnce(async () => {
      typed.read.mockResolvedValue(draft);
    });
    expect(await typed.stop(typed.guard)).toEqual({
      outcome: "unavailable",
      detail: "Claude's input line holds an unsent draft that Esc would clear; nothing was sent.",
      reason: "unsent_draft",
    });
    expect(typed.read).toHaveBeenCalledTimes(1);
    expect(typed.sendKeys).not.toHaveBeenCalled();
  });
});

it("a read-only hire starts Claude in dontAsk with only reading and reporting allowed (ADR 0316)", () => {
  const args = claudeWorkerLaunchArgs({
    harness: "claude",
    cwd: "/w",
    brief: "b",
    readOnly: true,
    maximumTrust: true,
  });
  // The owner's maximum trust mode never lifts a read-only hire's permissions.
  expect(args).not.toContain("--dangerously-skip-permissions");
  const settings = JSON.parse(args[1]!) as { permissions: { allow: string[]; defaultMode: string } };
  expect(settings.permissions.defaultMode).toBe("dontAsk");
  expect(settings.permissions.allow).toEqual(
    expect.arrayContaining(["Read", "Glob", "Grep", "mcp__plugin_clankie-worker_worker__message_clankie"]),
  );
  for (const widening of ["Edit", "Write", "Bash", "WebFetch", "mcp__plugin_clankie-worker_worker"])
    expect(settings.permissions.allow).not.toContain(widening);
  expect(settings.permissions.allow.some((rule) => rule.endsWith("clankie_call"))).toBe(false);
  expect(() =>
    claudeWorkerLaunchArgs({
      harness: "claude",
      cwd: "/w",
      brief: "b",
      readOnly: true,
      harnessArgs: ["--permission-mode", "bypassPermissions"],
    }),
  ).toThrow("read-only");
});
