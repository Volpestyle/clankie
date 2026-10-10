import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { paneDraftState } from "../src/captain/pane-draft.ts";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import type { OperatorSeatSpawnResult, SpawnOperatorSeat } from "@clankie/protocol";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const golden = (harness: string, state: string) =>
  readFile(new URL(`./fixtures/pane-draft/${harness}-${state}.ansi`, import.meta.url), "utf8");
const authority: ConversationAuthority = {
  owner: { conversationId: "lead" },
  current: () => true,
  authorize: async () => true,
};
const session = { source: "herdr:codex", kind: "id" as const, value: "10000000-0000-4000-8000-000000000001" };
const claudeSession = {
  source: "herdr:claude",
  kind: "id" as const,
  value: "20000000-0000-4000-8000-000000000002",
};

// A native boundary fixture feeds production Herdr parsing/close code, real ownership journals,
// real report files, and captured live ANSI. It never reaches a person's Herdr server.
async function fixture(
  options: {
    adopted?: boolean;
    unknown?: boolean;
    reattached?: boolean;
    cwd?: string;
    harness?: "codex" | "claude";
  } = {},
) {
  const harness = options.harness ?? "codex";
  const native = harness === "claude" ? claudeSession : session;
  const root = await mkdtemp(join(tmpdir(), "clankie-tidy-"));
  roots.push(root);
  const watchPath = join(root, "watch.json");
  const owners = new HireOwners(`${watchPath}.owners.json`);
  const occupant = occupantIdForHerdrSession(native);
  const key = JSON.stringify(["local", harness, native.value]);
  if (!options.unknown) {
    if (options.adopted) owners.adopt("w1:p1", "term_111", occupant, authority.owner, key);
    else owners.bind("w1:p1", authority.owner, "term_111", undefined, occupant, key);
  } else owners.bind("w1:p1", authority.owner, "term_111", undefined, "different-session", key);
  let present = true,
    closes = 0,
    reads = 0,
    now = 1_800_000_000_000;
  let ansi = await golden(harness, "empty");
  let finalAnsi: string | undefined;
  const calls: string[][] = [];
  const pane = {
    pane_id: "w1:p1",
    terminal_id: "term_111",
    agent: options.reattached ? "unknown" : harness,
    agent_status: "working",
    title: "Pip",
    cwd: options.cwd ?? root,
    ...(options.reattached ? {} : { agent_session: native }),
  };
  const others: (typeof pane)[] = [];
  const runner = createHerdrWatchRunner(undefined, async (args) => {
    calls.push([...args]);
    if (args[0] === "pane" && args[1] === "list")
      return JSON.stringify({ result: { panes: [...(present ? [pane] : []), ...others] } });
    if (args[0] === "agent" && args[1] === "get") {
      const found = [...(present ? [pane] : []), ...others].find((item) => item.pane_id === args[2]);
      if (found) return JSON.stringify({ result: { agent: found } });
    }
    if (args[0] === "pane" && args[1] === "process-info")
      return JSON.stringify({
        result: {
          process_info: {
            foreground_processes: [
              {
                pid: 123,
                name: "codex",
                argv: ["codex", "--remote", "unix:///fixture.sock", "resume", session.value],
              },
            ],
          },
        },
      });
    if (args[0] === "pane" && args[1] === "read") {
      if (args.includes("ansi")) {
        reads++;
        return reads > 1 && finalAnsi !== undefined ? finalAnsi : ansi;
      }
      return "Pip's completed report: tests passed.";
    }
    if (args[0] === "pane" && args[1] === "close") {
      closes++;
      present = false;
      return "{}";
    }
    throw new Error(`Unexpected fixture native call ${args.join(" ")}`);
  });
  const watch = new HerdrWatchStore(watchPath, { runner });
  const hires: SpawnOperatorSeat[] = [];
  let hireResult: () => Promise<OperatorSeatSpawnResult> = async () => ({
    outcome: "spawned",
    seat: {
      seatId: "term_222",
      occupantId: occupant,
      personaId: "pip",
      harness,
      status: "idle",
      title: "Pip",
    },
  });
  const ports: ConstructorParameters<typeof PaneTidy>[1] = {
    runner,
    provenance: (agent) => watch.tidyProvenance(agent),
    ownerValid: async () => true,
    close: (seat, guard) => watch.closeSeat(seat, guard),
    untrack: (seat) => watch.untrackSeat(seat),
    changed: () => {},
    now: () => now,
    resolve: async (ref) => ({
      ref,
      host: "local",
      sessionId: native.value,
      workingDirectory: root,
      file: { harness, path: join(root, "session.jsonl"), size: 1, mtimeMs: now },
    }),
    hire: async (request) => {
      hires.push(request);
      return hireResult();
    },
  };
  const path = join(root, "tidy.json");
  const tidy = new PaneTidy(path, ports);
  const reportPath = join(root, "REPORT.md");
  await writeFile(reportPath, "Focused tests pass; all work saved.\n");
  return {
    root,
    path,
    ports,
    tidy,
    reportPath,
    hires,
    calls,
    watch,
    setStatus: (status: string) => {
      pane.agent_status = status;
    },
    setAnsi: (next: string) => {
      ansi = next;
    },
    setFinalAnsi: (next: string) => {
      finalAnsi = next;
    },
    advance: () => {
      now += 300_001;
    },
    setHire: (next: () => Promise<OperatorSeatSpawnResult>) => {
      hireResult = next;
    },
    /** Another Herdr pane already running this native session. */
    reopenElsewhere: () => {
      others.push({ ...pane, pane_id: "w1:p9", terminal_id: "term_999" });
    },
    closes: () => closes,
  };
}

it.each(["claude", "codex"])(
  "live %s ANSI distinguishes ghost and actual unsubmitted draft",
  async (harness) => {
    const empty = await golden(harness, "empty"),
      draft = await golden(harness, "draft");
    expect(paneDraftState(harness, empty)).toBe("empty");
    expect(paneDraftState(harness, draft)).toBe("draft");
    // oxlint-disable-next-line no-control-regex -- transform the captured native ANSI boundary
    expect(paneDraftState(harness, empty.replace(/\x1b\[[0-9;]*m/gu, ""))).toBe("unknown");
    // oxlint-disable-next-line no-control-regex -- transform the captured native ANSI boundary
    expect(paneDraftState(harness, empty.replace(/\x1b\[2m/gu, "\x1b[3m"))).toBe("unknown");
  },
);
it("accepts variable Claude ghosts only in the captured bounded composer structure", async () => {
  const empty = (await golden("claude", "empty")).replace(
    'Try "write a test for headless-captain.ts"',
    "a completely different suggested prompt",
  );
  expect(paneDraftState("claude", empty)).toBe("empty");
  expect(paneDraftState("claude", empty.split("\n").slice(1).join("\n"))).toBe("unknown");
  expect(paneDraftState("claude", empty.replace("\x1b[2m", "\x1b[0m"))).toBe("draft");
});
it("closes a reattached pane with no agent_session; preserves output/report across restart and resumes its exact session", async () => {
  const f = await fixture({ reattached: true });
  const result = await f.tidy.close(
    { pane: "w1:p1", reason: "Reviewed and saved Pip's result", reportPath: f.reportPath },
    authority,
  );
  expect(result.outcome).toBe("closed");
  expect(f.closes()).toBe(1);
  expect(f.calls.filter((args) => args.includes("ansi")).length).toBeGreaterThanOrEqual(3);
  const reopenedJournal = new PaneTidy(f.path, f.ports);
  const entry = reopenedJournal.history()[0]!;
  expect(entry.lastOutput).toContain("tests passed");
  await rm(f.reportPath);
  expect(await readFile(entry.reportPath, "utf8")).toContain("all work saved");
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect(await reopenedJournal.undo(entry.id, authority)).toMatchObject({
    outcome: "reopened",
    entry: { resumedSeatId: "term_222" },
  });
  expect(f.hires).toMatchObject([
    { resume: `local:${session.value}`, workingDirectory: f.root, harness: "codex", placement: "new-tab" },
  ]);
  f.watch.close();
});
it.each(["draft", "unstyled", "changed-at-close"])("refuses %s input without closing", async (kind) => {
  const f = await fixture();
  if (kind === "draft") f.setAnsi(await golden("codex", "draft"));
  if (kind === "unstyled") f.setAnsi("› Ask Codex to do anything\n\n");
  if (kind === "changed-at-close") f.setFinalAnsi(await golden("codex", "draft"));
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Finished", reportPath: f.reportPath }, authority),
  ).toEqual(
    kind === "unstyled"
      ? { outcome: "failed", reason: "draft_state_unknown" }
      : { outcome: "refused", reason: "unsent_draft", draft: "Ask Codex to do anything" },
  );
  expect(f.closes()).toBe(0);
  expect(f.tidy.history()).toEqual([]);
  f.watch.close();
});
// VUH-2013: the owner's typed prompt must stop the close in either harness, and come back verbatim.
it.each([
  { harness: "claude" as const, state: "busy-draft", text: "go ahead and move Verifying above In Review" },
  {
    harness: "claude" as const,
    state: "draft",
    text: "Lio disposable unsent draft for ANSI styling evidence",
  },
  { harness: "codex" as const, state: "draft", text: "Ask Codex to do anything" },
])("refuses a typed $harness $state and returns its text verbatim", async ({ harness, state, text }) => {
  const f = await fixture({ harness });
  f.setAnsi(await golden(harness, state));
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Finished", reportPath: f.reportPath }, authority),
  ).toEqual({ outcome: "refused", reason: "unsent_draft", draft: text });
  expect(f.closes()).toBe(0);
  expect(f.tidy.leadHistory()).toEqual([]);
  f.watch.close();
});
it("closes over Claude's faint ghost and keeps it verbatim in the close record", async () => {
  const f = await fixture({ harness: "claude" });
  const closed = await f.tidy.close(
    { pane: "w1:p1", reason: "Finished", reportPath: f.reportPath },
    authority,
  );
  expect(closed).toMatchObject({
    outcome: "closed",
    entry: { input: { text: 'Try "write a test for headless-captain.ts"', typed: false } },
  });
  expect(f.closes()).toBe(1);
  // Durable and private: the lead's history keeps it, the public roster record does not carry it.
  const reopened = new PaneTidy(f.path, f.ports);
  expect(reopened.leadHistory()[0]!.input).toEqual({
    text: 'Try "write a test for headless-captain.ts"',
    typed: false,
  });
  expect(reopened.history()[0]).not.toHaveProperty("input");
  f.watch.close();
});
it("reports exactly why Undo could not resume, then lets a later Undo reopen the session", async () => {
  const f = await fixture({ harness: "claude" });
  const closed = await f.tidy.close(
    { pane: "w1:p1", reason: "Finished", reportPath: f.reportPath },
    authority,
  );
  if (closed.outcome !== "closed") throw new Error(`close ${closed.outcome}`);
  f.setHire(async () => ({
    outcome: "failed",
    reason: "not_ready",
    detail: "Claude did not reach its prompt",
  }));
  expect(await f.tidy.undo(closed.entry.id, authority)).toEqual({
    outcome: "failed",
    reason: "undo_unconfirmed",
    detail: "Resume failed: not_ready (Claude did not reach its prompt)",
  });
  const restarted = new PaneTidy(f.path, f.ports);
  expect(restarted.leadHistory()[0]).toMatchObject({
    state: "closed",
    undoFailure: {
      reason: "undo_unconfirmed",
      detail: "Resume failed: not_ready (Claude did not reach its prompt)",
    },
  });
  f.setHire(async () => {
    throw new Error("herdr socket closed");
  });
  expect(await restarted.undo(closed.entry.id, authority)).toMatchObject({
    reason: "undo_unconfirmed",
    detail: "Resume failed: herdr socket closed",
  });
  f.setHire(async () => ({
    outcome: "spawned",
    seat: {
      seatId: "term_333",
      occupantId: "pip",
      personaId: "pip",
      harness: "claude",
      status: "idle",
      title: "Pip",
    },
  }));
  expect(await restarted.undo(closed.entry.id, authority)).toMatchObject({
    outcome: "reopened",
    entry: { resumedSeatId: "term_333", state: "reopened" },
  });
  expect(restarted.leadHistory()[0]).not.toHaveProperty("undoFailure");
  expect(f.hires).toHaveLength(3);
  expect(f.hires[0]).toMatchObject({ resume: `local:${claudeSession.value}`, harness: "claude" });
  f.watch.close();
});
it("records a session already open again instead of hiring a second copy", async () => {
  const f = await fixture();
  const closed = await f.tidy.close(
    { pane: "w1:p1", reason: "Finished", reportPath: f.reportPath },
    authority,
  );
  if (closed.outcome !== "closed") throw new Error(`close ${closed.outcome}`);
  f.reopenElsewhere();
  expect(await f.tidy.undo(closed.entry.id, authority)).toMatchObject({
    outcome: "reopened",
    entry: { resumedSeatId: "term_999" },
  });
  expect(f.hires).toEqual([]);
  f.watch.close();
});
it.each([
  { options: { adopted: true }, reason: "owner_interactive", outcome: "refused" },
  { options: { unknown: true }, reason: "provenance_unknown", outcome: "failed" },
])("refuses $reason from real persisted ownership records", async ({ options, reason, outcome }) => {
  const f = await fixture(options);
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Finished", reportPath: f.reportPath }, authority),
  ).toEqual({ outcome, reason });
  expect(f.closes()).toBe(0);
  f.watch.close();
});
it("refuses closing another lead's hire, naming its owner, before any close effect", async () => {
  const f = await fixture();
  expect(
    await f.tidy.close(
      { pane: "w1:p1", reason: "Finished", reportPath: f.reportPath },
      { ...authority, owner: { conversationId: "other-lead" } },
    ),
  ).toEqual({ outcome: "refused", reason: "not_owner", ownerConversationId: "lead" });
  expect(f.closes()).toBe(0);
  expect(f.tidy.history()).toEqual([]);
  f.watch.close();
});
it("requires kept results, accepts an authenticated saved report, and expires Undo", async () => {
  const f = await fixture();
  expect(await f.tidy.close({ pane: "w1:p1", reason: "Finished" }, authority)).toEqual({
    outcome: "refused",
    reason: "results_not_kept",
  });
  const agent = await f.ports.runner.get("w1:p1");
  f.tidy.keepReport(agent, "Report delivered through authenticated worker ingress.");
  expect(await f.tidy.close({ pane: "w1:p1", reason: "Report harvested" }, authority)).toMatchObject({
    outcome: "closed",
  });
  f.advance();
  expect(await f.tidy.undo(f.tidy.history()[0]!.id, authority)).toEqual({
    outcome: "failed",
    reason: "undo_expired",
  });
  expect(f.hires).toEqual([]);
  f.watch.close();
});

it("fails closed for legacy records that cannot prove hire versus adoption", async () => {
  const f = await fixture();
  const ownersPath = join(f.root, "watch.json.owners.json");
  const state = JSON.parse(await readFile(ownersPath, "utf8"));
  delete state.hires[0].hired;
  await writeFile(ownersPath, JSON.stringify(state));
  const reopened = new HerdrWatchStore(join(f.root, "watch.json"), { runner: f.ports.runner });
  const tidy = new PaneTidy(f.path, { ...f.ports, provenance: (agent) => reopened.tidyProvenance(agent) });
  expect(
    await tidy.close({ pane: "w1:p1", reason: "Finished", reportPath: f.reportPath }, authority),
  ).toEqual({ outcome: "failed", reason: "provenance_unknown" });
  expect(f.closes()).toBe(0);
  reopened.close();
  f.watch.close();
});
it("keeps uncertain closes durable and prevents an automatic second close or Undo", async () => {
  const f = await fixture();
  const tidy = new PaneTidy(f.path, { ...f.ports, close: async () => false });
  expect(
    await tidy.close({ pane: "w1:p1", reason: "Finished", reportPath: f.reportPath }, authority),
  ).toEqual({ outcome: "failed", reason: "close_unconfirmed" });
  const restarted = new PaneTidy(f.path, f.ports);
  expect(restarted.history()[0]).toMatchObject({ state: "close_unconfirmed" });
  expect(
    await restarted.close({ pane: "w1:p1", reason: "Retry", reportPath: f.reportPath }, authority),
  ).toEqual({ outcome: "failed", reason: "busy" });
  expect(await restarted.undo(restarted.history()[0]!.id, authority)).toEqual({
    outcome: "failed",
    reason: "undo_unknown",
    detail: "The close record is close_unconfirmed",
  });
  expect(f.closes()).toBe(0);
  f.watch.close();
});

it("stops before native close when its admitted turn is cancelled during the final input read", async () => {
  const f = await fixture();
  const stopped: ConversationAuthority = {
    ...authority,
    current: () => f.calls.filter((args) => args.includes("ansi")).length < 2,
  };
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Finished", reportPath: f.reportPath }, stopped),
  ).toEqual({ outcome: "failed", reason: "authority_unavailable" });
  expect(f.closes()).toBe(0);
  expect(f.tidy.history()).toEqual([]);
  f.watch.close();
});

it("explicit restart refuses the captured busy Codex occupant before close or resume", async () => {
  const f = await fixture();
  expect(await f.tidy.restart({ pane: "w1:p1", reportPath: f.reportPath }, authority)).toEqual({
    outcome: "failed",
    reason: "busy",
  });
  expect(f.closes()).toBe(0);
  expect(f.hires).toEqual([]);
  expect(f.tidy.history()).toEqual([]);
  expect(await f.tidy.restart({ pane: "pc/w1:p1" }, authority)).toEqual({
    outcome: "failed",
    reason: "restart_unsupported",
  });
  expect(f.closes()).toBe(0);
});

it("idle legacy restart without native exit refuses before saving a close intent, and terminal aliases cannot bypass pane guards", async () => {
  const f = await fixture();
  f.setStatus("idle");
  expect(await f.tidy.restart({ pane: "w1:p1", reportPath: f.reportPath }, authority)).toEqual({
    outcome: "failed",
    reason: "native_exit_unavailable",
  });
  expect(await f.tidy.restart({ pane: "term_111", reportPath: f.reportPath }, authority)).toEqual({
    outcome: "failed",
    reason: "provenance_unknown",
  });
  expect(f.closes()).toBe(0);
  expect(f.hires).toEqual([]);
  expect(f.tidy.history()).toEqual([]);
  expect(await f.tidy.restart({ pane: "w1:p1" }, authority)).toEqual({
    outcome: "failed",
    reason: "native_exit_unavailable",
  });
  expect(f.tidy.history()).toEqual([]);
});

const exec = promisify(execFile);
async function git(path: string, ...args: string[]) {
  const { stdout } = await exec(
    "git",
    ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) },
  );
  return stdout.trim();
}
/** A real repository whose origin/main is a remote-tracking ref, and a worker's linked worktree. */
async function workerWorktree() {
  const base = await mkdtemp(join(tmpdir(), "clankie-tidy-worktree-"));
  roots.push(base);
  const repo = join(base, "repo");
  await exec("git", ["init", "--quiet", "--initial-branch", "main", repo]);
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "base.txt");
  await git(repo, "commit", "--quiet", "-m", "base");
  await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const tree = join(base, "worker");
  await git(repo, "worktree", "add", "--quiet", "-b", "pip/vuh-1", tree, "main");
  return { repo, tree };
}

it("refuses to close a worker whose worktree holds unlanded commits or uncommitted files, until a reason is recorded", async () => {
  const w = await workerWorktree();
  await writeFile(join(w.tree, "feature.txt"), "unlanded\n");
  await git(w.tree, "add", "feature.txt");
  await git(w.tree, "commit", "--quiet", "-m", "unlanded feature");
  await writeFile(join(w.tree, "notes.txt"), "uncommitted\n");
  const f = await fixture({ cwd: w.tree });
  const refused = await f.tidy.close({ pane: "w1:p1", reason: "Done", reportPath: f.reportPath }, authority);
  expect(refused).toMatchObject({
    outcome: "refused",
    reason: "unlanded_work",
    worktrees: [{ state: "unreconciled", branch: "pip/vuh-1", unlandedCommits: 1, dirtyFiles: 1 }],
  });
  expect(f.closes()).toBe(0);
  const closed = await f.tidy.close(
    {
      pane: "w1:p1",
      reason: "Done",
      reportPath: f.reportPath,
      unlandedReason: "Spike superseded by the landed design",
    },
    authority,
  );
  expect(closed).toMatchObject({
    outcome: "closed",
    entry: {
      unlanded: {
        reason: "Spike superseded by the landed design",
        worktrees: [{ unlandedCommits: 1, dirtyFiles: 1 }],
      },
    },
  });
  expect(f.closes()).toBe(1);
  // The reason survives in the close record and the per-worktree decision ledger.
  const reopened = new PaneTidy(f.path, f.ports);
  expect(reopened.history()[0]!.unlanded?.reason).toBe("Spike superseded by the landed design");
  const head = await git(w.tree, "rev-parse", "HEAD");
  const path = await git(w.tree, "rev-parse", "--show-toplevel");
  expect(reopened.decisions.latest(path, head)).toMatchObject({
    decision: "closed_unreconciled",
    reason: "Spike superseded by the landed design",
    by: "lead: Pip",
  });
  f.watch.close();
});

it("closes a worker whose commits reached main by content after a rebase, without a reason", async () => {
  const w = await workerWorktree();
  await writeFile(join(w.tree, "feature.txt"), "landed\n");
  await git(w.tree, "add", "feature.txt");
  await git(w.tree, "commit", "--quiet", "-m", "feature");
  // The integrator lands the same patch on main as a different commit.
  await writeFile(join(w.repo, "other.txt"), "main moved\n");
  await git(w.repo, "add", "other.txt");
  await git(w.repo, "commit", "--quiet", "-m", "main moved");
  await git(w.repo, "cherry-pick", "pip/vuh-1");
  await git(w.repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const f = await fixture({ cwd: w.tree });
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Landed", reportPath: f.reportPath }, authority),
  ).toMatchObject({ outcome: "closed" });
  expect(f.tidy.history()[0]!.unlanded).toBeUndefined();
  f.watch.close();
});

it("holds a merge's unique resolution even when git cherry says every patch landed", async () => {
  const w = await workerWorktree();
  await writeFile(join(w.tree, "feature.txt"), "feature\n");
  await git(w.tree, "add", "feature.txt");
  await git(w.tree, "commit", "--quiet", "-m", "feature");
  const feature = await git(w.tree, "rev-parse", "HEAD");
  await writeFile(join(w.repo, "other.txt"), "main moved\n");
  await git(w.repo, "add", "other.txt");
  await git(w.repo, "commit", "--quiet", "-m", "main moved");
  await git(w.tree, "merge", "--no-commit", "main");
  await writeFile(join(w.tree, "resolution.txt"), "only in the merge\n");
  await git(w.tree, "add", "resolution.txt");
  await git(w.tree, "commit", "--quiet", "-m", "merge with unique resolution");
  await git(w.repo, "cherry-pick", feature);
  await git(w.repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const cherry = await git(w.tree, "cherry", "origin/main");
  expect(cherry).toMatch(/^-[ ]/u);
  expect(cherry).not.toMatch(/^\+/mu);
  const f = await fixture({ cwd: w.tree });
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Done", reportPath: f.reportPath }, authority),
  ).toMatchObject({
    outcome: "refused",
    reason: "unlanded_work",
    worktrees: [{ unlandedCommits: 1, dirtyFiles: 0 }],
  });
  expect(f.closes()).toBe(0);
  expect(await readFile(join(w.tree, "resolution.txt"), "utf8")).toBe("only in the merge\n");
  f.watch.close();
});
