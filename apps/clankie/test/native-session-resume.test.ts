import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessSeatAdapter,
  SeatControl,
  SeatDelivery,
  SeatProcessIdentity,
} from "@clankie/agent-hosts";
import type { SavedAgentSession } from "../src/agent-sessions.ts";
import {
  HerdrWatchStore,
  createHerdrWatchRunner,
  type HerdrAgentSnapshot,
} from "../src/captain/herdr-watch.ts";
import {
  existingNativeSession,
  nativeResumeArgs,
  savedCodexAccount,
  savedSessionFleet,
} from "../src/captain/native-session-resume.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";

const UUID = "10000000-0000-4000-8000-000000000001";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "native-resume-"));
  roots.push(root);
  return root;
}
function saved(root = "/work"): Extract<SavedAgentSession, { file: unknown }> {
  return {
    ref: `local:${UUID}`,
    host: "local",
    sessionId: UUID,
    workingDirectory: root,
    file: { harness: "claude", path: `${root}/${UUID}.jsonl`, size: 1, mtimeMs: Date.now() },
  };
}
async function fixture() {
  const root = await scratch();
  const session = saved(root);
  const live: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_one",
    agent: "claude",
    status: "idle",
    title: "Existing worker",
    workingDirectory: root,
    session: { source: "herdr:claude", kind: "id", value: UUID },
  };
  let panes: HerdrAgentSnapshot[] = [];
  const send = vi.fn(
    async (): Promise<SeatDelivery> => ({
      outcome: "accepted",
      messageId: "native-receipt",
      state: "queued",
    }),
  );
  const control: SeatControl = {
    ref: { harness: "claude", sessionId: UUID, paneId: live.paneId },
    send,
    status: async () => "idle",
    settled: async () => ({ type: "turn_completed", at: "now", ok: true }),
    interrupt: async () => false,
    close: async () => undefined,
  };
  const adapter: HarnessSeatAdapter = {
    harness: "claude",
    attach: vi.fn(async () => control),
    start: vi.fn(async () => {
      panes = [live];
      return { outcome: "started" as const, control };
    }),
  };
  const runner = {
    list: vi.fn(async () => panes),
    get: vi.fn(async () => live),
    resolveTerminal: vi.fn(async () => live),
    wait: vi.fn(async () => live),
    runInPane: vi.fn(async () => undefined),
    createTab: vi.fn(async ({ label }: { label: string }) => {
      const { session: _session, ...shell } = live;
      panes = [{ ...shell, agent: "shell", title: label }];
      return live.paneId;
    }),
    startAgent: vi.fn(async () => undefined),
    promptAgent: vi.fn(async () => undefined),
    closePane: vi.fn(async () => undefined),
  };
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner,
    seatAdapters: [adapter],
    hireCapacity: async () => ({ live: 0, limit: 1 }),
  });
  const hire = (brief?: string) =>
    store.spawnSeat(
      { schemaVersion: 1, harness: "claude", resume: session.ref, title: "Resume", workingDirectory: root },
      undefined,
      brief,
      session,
    );
  return {
    root,
    session,
    live,
    send,
    adapter,
    runner,
    store,
    hire,
    setPanes: (value: HerdrAgentSnapshot[]) => {
      panes = value;
    },
  };
}

describe("native saved-session hires", () => {
  it("reopens a recently written session in the ordinary adapter without a quiet-window guess", async () => {
    const f = await fixture();
    expect(await f.hire()).toMatchObject({
      outcome: "spawned",
      seat: { seatId: "term_one" },
      control: { mode: "channel" },
    });
    expect(f.adapter.start).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: UUID, brief: "" }),
      expect.objectContaining({ paneId: "w1:p1" }),
    );
    expect(f.runner.promptAgent).not.toHaveBeenCalled();
  });
  it("serializes concurrent resumes and reuses the first native seat", async () => {
    const f = await fixture();
    const results = await Promise.all([f.hire(), f.hire("follow-up")]);
    expect(results.map((result) => result.outcome)).toEqual(["spawned", "spawned"]);
    expect(f.runner.createTab).toHaveBeenCalledOnce();
    expect(f.adapter.start).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith("follow-up");
    expect(f.runner.list).toHaveBeenCalledTimes(2);
  });
  it.each(["accepted", "unconfirmed", "offline", "released", "throws"] as const)(
    "existing seat delivery %s never starts another writer or types a retry",
    async (outcome) => {
      const f = await fixture();
      f.setPanes([f.live]);
      if (outcome === "throws") f.send.mockRejectedValue(new Error("reply lost"));
      else
        f.send.mockResolvedValue({
          outcome,
          messageId: "m",
          state: "queued",
          detail: "lost reply",
        } as SeatDelivery);
      const result = await f.hire("continue");
      expect(result.outcome).toBe(outcome === "accepted" ? "spawned" : "failed");
      if (outcome === "unconfirmed" || outcome === "throws")
        expect(result).toMatchObject({ reason: "delivery_unconfirmed" });
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.runner.createTab).not.toHaveBeenCalled();
      expect(f.adapter.start).not.toHaveBeenCalled();
      expect(f.runner.promptAgent).not.toHaveBeenCalled();
      expect(f.runner.closePane).not.toHaveBeenCalled();
    },
  );
  it("reuses an existing seat at capacity and accepts native session paths", async () => {
    const f = await fixture();
    f.setPanes([
      { ...f.live, session: { source: "herdr:claude", kind: "path", value: `/history/${UUID}.jsonl` } },
    ]);
    const store = new HerdrWatchStore(join(f.root, "capacity.json"), {
      runner: f.runner,
      hireCapacity: async () => ({ live: 1, limit: 1 }),
    });
    expect(
      await store.spawnSeat(
        { schemaVersion: 1, harness: "claude", title: "Resume", workingDirectory: f.root },
        undefined,
        undefined,
        f.session,
      ),
    ).toMatchObject({ outcome: "spawned" });
    expect(f.runner.createTab).not.toHaveBeenCalled();
  });
  it("does not fork an uncontrolled live seat just because attachment is unavailable", async () => {
    const f = await fixture();
    f.setPanes([f.live]);
    vi.mocked(f.adapter.attach).mockResolvedValue(undefined);
    expect(await f.hire("continue")).toMatchObject({ outcome: "failed", reason: "not_ready" });
    expect(f.runner.createTab).not.toHaveBeenCalled();
    expect(f.runner.promptAgent).not.toHaveBeenCalled();
  });
  it("keeps an uncertain start visible and refuses a second start after service recreation", async () => {
    const f = await fixture();
    vi.mocked(f.adapter.start).mockResolvedValue({
      outcome: "failed",
      reason: "not_ready",
      detail: "brief_delivery_unverified",
    });
    expect(await f.hire("continue")).toMatchObject({ outcome: "failed", reason: "delivery_unconfirmed" });
    const recreated = new HerdrWatchStore(join(f.root, "new-service.json"), {
      runner: f.runner,
      seatAdapters: [f.adapter],
    });
    expect(
      await recreated.spawnSeat(
        { schemaVersion: 1, harness: "claude", title: "Resume", workingDirectory: f.root },
        undefined,
        "continue",
        f.session,
      ),
    ).toMatchObject({ outcome: "failed", reason: "not_ready" });
    expect(f.runner.createTab).toHaveBeenCalledOnce();
    expect(f.adapter.start).toHaveBeenCalledOnce();
    expect(f.runner.closePane).not.toHaveBeenCalled();
  });
  it("fails closed on incomplete inventory or uncertain session identity", async () => {
    const f = await fixture();
    f.runner.list.mockRejectedValueOnce(new Error("SSH link lost"));
    expect(await f.hire()).toMatchObject({ outcome: "failed" });
    const { session: _session, ...unidentified } = f.live;
    f.setPanes([unidentified]);
    expect(await f.hire()).toMatchObject({ outcome: "failed" });
    f.setPanes([f.live, { ...f.live, paneId: "w1:p2" }]);
    expect(await f.hire()).toMatchObject({ outcome: "failed" });
    expect(f.runner.createTab).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "a resumed terminal brief needs a new transcript receipt (new receipt: %s)",
    async (fresh) => {
      const f = await fixture();
      let entries = [{ type: "message" as const, id: "old", role: "operator" as const, text: "repeat" }];
      const transcript = vi.fn(async () => ({ sessionKey: "native", entries }));
      f.runner.promptAgent.mockImplementation(async () => {
        if (fresh) entries = [...entries, { ...entries[0]!, id: "new" }];
      });
      const store = new HerdrWatchStore(join(f.root, "terminal.json"), {
        runner: { ...f.runner, transcript },
      });
      vi.useFakeTimers();
      try {
        const result = store.spawnSeat(
          { schemaVersion: 1, harness: "claude", title: "Resume", workingDirectory: f.root },
          undefined,
          "repeat",
          f.session,
        );
        await vi.advanceTimersByTimeAsync(10_500);
        expect(await result).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
        expect(f.runner.createTab).not.toHaveBeenCalled();
        expect(f.runner.startAgent).not.toHaveBeenCalled();
        expect(f.runner.promptAgent).not.toHaveBeenCalled();
        expect(f.runner.closePane).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("never sends a terminal brief to a different native session", async () => {
    const f = await fixture();
    f.runner.get.mockResolvedValue({
      ...f.live,
      session: { source: "herdr:claude", kind: "id", value: "other-session" },
    });
    const store = new HerdrWatchStore(join(f.root, "wrong-session.json"), { runner: f.runner });
    expect(
      await store.spawnSeat(
        { schemaVersion: 1, harness: "claude", title: "Resume", workingDirectory: f.root },
        undefined,
        "do not send",
        f.session,
      ),
    ).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
    expect(f.runner.promptAgent).not.toHaveBeenCalled();
  });
});

it("binds remote transcripts by exact SSH target and shell, never by a matching friendly id", () => {
  const session = { ...saved(), host: { id: "pc", ssh: "owner@actual", shell: "powershell" as const } };
  const fleet = {
    id: "different-label",
    session: "default",
    ssh: { host: "owner@actual", shell: "powershell" as const },
  };
  expect(savedSessionFleet(session, undefined, [fleet])).toBe("different-label");
  expect(() =>
    savedSessionFleet(session, "pc", [{ ...fleet, id: "pc", ssh: { host: "other", shell: "powershell" } }]),
  ).toThrow(/exact SSH/);
  expect(() =>
    savedSessionFleet(session, undefined, [{ ...fleet, ssh: { host: "owner@actual", shell: "posix" } }]),
  ).toThrow(/exact SSH/);
  expect(() => savedSessionFleet(saved(), "pc", [fleet])).toThrow(/local transcript/);
  expect(savedSessionFleet(saved(), "work", [fleet], [{ id: "work" }])).toBe("work");
  expect(() => savedSessionFleet(session, "work", [fleet], [{ id: "work" }])).toThrow(/exact SSH/);
});

it("uses a fresh qualified remote inventory and refuses malformed panes before a native start", async () => {
  const exec = vi.fn(async () =>
    JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p1",
            terminal_id: "term_one",
            agent: "claude",
            agent_session: { source: "herdr:claude", kind: "id", value: UUID },
          },
        ],
      },
    }),
  );
  const remote = createHerdrWatchRunner(undefined, exec);
  const routed = routeHerdrFleets(
    createHerdrWatchRunner(() => false),
    new Map([["pc", remote]]),
  );
  expect(existingNativeSession(await routed.list!("pc"), saved())).toMatchObject({
    paneId: "pc/w1:p1",
    terminalId: "pc/term_one",
  });
  exec.mockResolvedValue(JSON.stringify({ result: { panes: [{ pane_id: "malformed" }] } }));
  await expect(routed.list!("pc")).rejects.toThrow(/identify/);
});

it("resumes Codex with its original real account root and rejects another account or an escaped symlink", async () => {
  const root = await scratch();
  const original = { label: "original", home: join(root, "original") };
  const other = { label: "other", home: join(root, "other") };
  await mkdir(join(original.home, "sessions"), { recursive: true });
  await mkdir(join(other.home, "sessions"), { recursive: true });
  const path = join(original.home, "sessions", `${UUID}.jsonl`);
  await writeFile(path, "history");
  const session = { ...saved(), file: { ...saved().file, harness: "codex" as const, path } };
  expect(await savedCodexAccount(session, [other, original])).toEqual(original);
  await expect(savedCodexAccount(session, [original, other], "other")).rejects.toThrow(/owns/);
  const outside = join(root, "outside.jsonl");
  await writeFile(outside, "foreign history");
  const link = join(original.home, "sessions", "escape.jsonl");
  await symlink(outside, link);
  await expect(
    savedCodexAccount({ ...session, file: { ...session.file, path: link } }, [original]),
  ).rejects.toThrow(/owns/);
});

it("uses each harness's exact interactive resume flags", () => {
  const session = saved();
  expect(nativeResumeArgs(session)).toEqual(["--resume", UUID]);
  expect(nativeResumeArgs({ ...session, file: { ...session.file, harness: "codex" } })).toEqual([
    "resume",
    UUID,
  ]);
  expect(nativeResumeArgs({ ...session, file: { ...session.file, harness: "pi" } })).toEqual([
    "--session",
    session.file.path,
  ]);
  expect(nativeResumeArgs({ ...session, file: { ...session.file, harness: "grok" } })).toEqual([
    "--resume",
    UUID,
  ]);
});

describe("prepared native saved-session reuse", () => {
  async function nativeFixture(harness: "opencode" | "pi" = "opencode") {
    const f = await fixture();
    const sessionId = harness === "opencode" ? "ses_nativeReuse" : UUID;
    const session: SavedAgentSession =
      harness === "opencode"
        ? {
            ref: `local:${sessionId}`,
            host: "local",
            sessionId,
            workingDirectory: f.root,
            source: {
              kind: "opencode-sqlite",
              machineId: "local",
              profileId: "worker-fixture",
              database: `${f.root}/opencode.db`,
              databaseIdentity: "1:2",
              sessionId,
              version: "1.18.18",
              workingDirectory: f.root,
            },
          }
        : { ...saved(f.root), file: { ...saved(f.root).file, harness: "pi" } };
    const live: HerdrAgentSnapshot = {
      ...f.live,
      agent: harness,
      session: { source: `herdr:${harness}`, kind: "id", value: sessionId },
    };
    const proof: SeatProcessIdentity = {
      nativeOccupantId: occupantIdForHerdrSession(live.session!),
      fleet: "default",
      pane: live.paneId,
      binding: { socketPath: "/tmp/native-owned", session: "owned" },
      processes: [{ pid: 44, startTime: "123.456789" }],
      shell: { pid: 44, startTime: "123.456789" },
    };
    const verify = vi.fn(async () => structuredClone(proof));
    const control: SeatControl = {
      ref: { harness: "opencode", sessionId, paneId: live.paneId },
      verify,
      send: f.send,
      status: async () => "idle",
      settled: async () => new Promise<never>(() => {}),
      interrupt: async () => false,
      close: async () => {},
    };
    const adapter: HarnessSeatAdapter = {
      harness: "opencode",
      attach: vi.fn(async () => control),
      start: vi.fn(async () => ({ outcome: "started" as const, control })),
    };
    f.runner.list.mockImplementation(async () => [structuredClone(live)]);
    f.runner.get.mockImplementation(async () => structuredClone(live));
    const store = new HerdrWatchStore(join(f.root, "native.json"), {
      runner: f.runner,
      seatAdapters: harness === "opencode" ? [adapter] : [],
    });
    const hire = (brief?: string) =>
      store.spawnSeat(
        { schemaVersion: 1, harness, resume: session.ref, title: "Resume", workingDirectory: f.root },
        undefined,
        brief,
        session,
      );
    return { ...f, live, proof, control, verify, adapter, store, hire };
  }
  it.each(["opencode", "pi"] as const)(
    "refuses metadata-only %s reuse even with no brief",
    async (harness) => {
      const f = await nativeFixture(harness);
      vi.mocked(f.adapter.attach).mockResolvedValue(undefined);
      expect(await f.hire()).toMatchObject({ outcome: "failed", reason: "not_ready" });
      expect(f.runner.createTab).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it("requires the original verification callback, not merely an attached controller", async () => {
    const f = await nativeFixture();
    delete f.control.verify;
    expect(await f.hire()).toMatchObject({ outcome: "failed", reason: "not_ready" });
    expect(f.runner.createTab).not.toHaveBeenCalled();
  });
  it.each([undefined, "continue"])("reuses an exact held controller with brief %s", async (brief) => {
    const f = await nativeFixture();
    expect(await f.hire(brief)).toMatchObject({ outcome: "spawned" });
    expect(f.verify.mock.calls.length).toBeGreaterThan(3);
    expect(f.runner.createTab).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(brief === undefined ? 0 : 1);
  });
  it("preserves uncertain delivery when the original process is lost after native acceptance", async () => {
    const f = await nativeFixture();
    f.send.mockImplementation(async () => {
      Object.assign(f.proof, { processes: [{ pid: 44, startTime: "123.456790" }] });
      return { outcome: "accepted", messageId: "accepted", state: "queued" };
    });
    expect(await f.hire("continue")).toMatchObject({ outcome: "failed", reason: "delivery_unconfirmed" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.runner.createTab).not.toHaveBeenCalled();
  });
  it.each(["ref", "terminal", "session", "birth", "occupant", "pane", "fleet"] as const)(
    "refuses changed %s without a duplicate launch or message",
    async (field) => {
      const f = await nativeFixture();
      if (field === "ref") Object.assign(f.control.ref, { paneId: "w1:p2" });
      else if (field === "occupant") Object.assign(f.proof, { nativeOccupantId: "another" });
      else if (field === "pane") Object.assign(f.proof, { pane: "w1:p2" });
      else if (field === "fleet") Object.assign(f.proof, { fleet: "another" });
      else
        f.runner.get.mockImplementation(async () => {
          if (field === "birth")
            Object.assign(f.proof, { processes: [{ pid: 44, startTime: "123.456790" }] });
          return {
            ...f.live,
            ...(field === "terminal" ? { terminalId: "replacement" } : {}),
            ...(field === "session"
              ? { session: { source: "herdr:opencode", kind: "id" as const, value: "ses_other" } }
              : {}),
          };
        });
      expect(await f.hire("continue")).toMatchObject({ outcome: "failed", reason: "not_ready" });
      expect(f.send).not.toHaveBeenCalled();
      expect(f.runner.createTab).not.toHaveBeenCalled();
    },
  );
});
