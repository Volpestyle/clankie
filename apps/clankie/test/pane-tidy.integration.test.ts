import type { SeatControl } from "@clankie/agent-hosts";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Socket } from "node:net";
import { nativeRequest } from "../src/herdr-native-request.ts";
import { nativeHerdrRead } from "../src/herdr-native-read.ts";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { afterEach, expect, it } from "vitest";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { paneDraftState } from "../src/captain/pane-draft.ts";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import {
  SpawnOperatorSeatSchema,
  type OperatorSeatSpawnResult,
  type SpawnOperatorSeat,
} from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { ProjectHires, type ProjectHireProcessProof } from "../src/captain/project-hires.ts";
import { createRemoteHireReceipts } from "../src/remote-hire-receipts.ts";
import { codex0160Protocol } from "./fixtures/codex-0160-protocol.ts";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import { remoteRetirementWork } from "../src/captain/remote-retirement-work.ts";
import { DeliveryFence, ReceiptSchema } from "../src/captain/delivery-fence.ts";

const roots: string[] = [];
const socketCleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(socketCleanups.splice(0).map((close) => close()));
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
    legacy?: boolean;
    reattached?: boolean;
    readopt?: boolean;
    remote?: boolean;
    socket?: boolean;
    projectHire?: boolean;
    controller?: boolean;
    reload?: boolean;
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
  const paneId = options.remote ? "pc/w1:p1" : "w1:p1";
  const seatId = options.remote ? "pc/term_111" : "term_111";
  const original = options.readopt
    ? { ...native, kind: "path" as const, value: join(root, `rollout-${native.value}.jsonl`) }
    : native;
  const occupant = occupantIdForHerdrSession(original);
  const key = JSON.stringify([options.remote ? "pc" : "local", harness, native.value]);
  if (!options.unknown) {
    if (options.adopted) owners.adopt(paneId, seatId, occupant, authority.owner, key);
    else owners.bind(paneId, authority.owner, seatId, undefined, occupant, key);
  } else owners.bind(paneId, authority.owner, seatId, undefined, "different-session", key);
  if (options.legacy) {
    const state = JSON.parse(await readFile(`${watchPath}.owners.json`, "utf8"));
    delete state.hires[0].hired;
    await writeFile(`${watchPath}.owners.json`, JSON.stringify(state));
  }
  let present = true,
    closes = 0,
    reads = 0,
    now = 1_800_000_000_000;
  let ansi = await golden(harness, "empty");
  let finalAnsi: string | undefined;
  let replaceHostOnClose = false;
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
  const execute = async (args: readonly string[]) => {
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
      if (replaceHostOnClose) fixtureHost = "replacement-host";
      return "{}";
    }
    throw new Error(`Unexpected fixture native call ${args.join(" ")}`);
  };
  let transport = execute;
  if (options.socket) {
    const socketPath = join(root, "herdr.sock");
    const binding = { runtime: "external" as const, socketPath, session: "fixture" };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.split("\n")[0]!);
        const params = request.params;
        const args: string[] =
          request.method === "pane.list"
            ? ["pane", "list"]
            : request.method === "agent.get"
              ? ["agent", "get", params.target]
              : request.method === "pane.read"
                ? ["pane", "read", params.pane_id, "--source", params.source, "--format", params.format]
                : request.method === "pane.close"
                  ? ["pane", "close", params.pane_id]
                  : [];
        void execute(args)
          .then((result) => {
            socket.end(
              JSON.stringify({
                id: request.id,
                ...(request.method === "pane.read" ? { result: { text: result } } : JSON.parse(result)),
              }) + "\n",
            );
          })
          .catch(() =>
            socket.end(JSON.stringify({ id: request.id, error: { code: "pane_not_found" } }) + "\n"),
          );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    socketCleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    transport = async (args) => {
      const read = nativeHerdrRead(binding, args);
      if (read) return read;
      const method = args[1] === "read" ? "pane.read" : "pane.close";
      const reply = (await nativeRequest(binding, method, {
        pane_id: args[2],
        source: args[4],
        format: args[6],
      })) as { result: { text?: string } };
      return method === "pane.read" ? reply.result.text! : JSON.stringify(reply);
    };
  }
  const baseRunner = createHerdrWatchRunner(undefined, transport);
  const routedRunner = options.remote
    ? routeHerdrFleets(baseRunner, new Map([["pc", baseRunner]]))
    : baseRunner;
  const runner = options.reload
    ? {
        ...routedRunner,
        createTab: async () => {
          pane.pane_id = "w1:p2";
          pane.terminal_id = "term_222";
          present = true;
          return "pc/w1:p2";
        },
        startAgent: async ({ args }: { args: readonly string[] }) => {
          expect(args).toContain(native.value);
          nativeProtocol!.startView();
        },
      }
    : routedRunner;
  const settings = ProjectsSettingsSchema.parse({ projects: [{ id: "fixture", name: "Fixture" }] });
  const proof: ProjectHireProcessProof = {
    nativeOccupantId: occupant,
    fleet: "pc",
    pane: paneId,
    binding: { socketPath: "fixture.sock", session: "fixture" },
    shell: { pid: 100, startTime: "original-shell" },
    processes: [{ pid: 123, startTime: "original-codex" }],
  };
  const ledger = new ProjectHires(`${watchPath}.project-hires.json`);
  let proofReads = 0;
  let refuseProofAt = Infinity;
  let fixtureHost = "fixture-host";
  const remoteHireReceipts = createRemoteHireReceipts({
    fleet: async () => ({ id: "pc", session: "fixture", ssh: { host: fixtureHost, shell: "posix" } }),
    shell: () => async (command) => {
      if (!options.reload) throw new Error("No host mutation in a census proof");
      return (
        await promisify(execFile)("/bin/sh", ["-c", command], {
          timeout: 15000,
          env: { ...process.env, HOME: root },
        })
      ).stdout;
    },
  });
  if (options.projectHire) {
    const request = SpawnOperatorSeatSchema.parse({
      schemaVersion: 1,
      fleet: "pc",
      harness,
      title: "Pip",
      workingDirectory: options.cwd ?? root,
    });
    const allocation = ledger.reserve(settings, "fixture", request);
    ledger.launch(allocation.id, settings);
    ledger.pane(allocation.id, paneId);
    ledger.observe(allocation.id, seatId, occupant, proof);
    ledger.confirmed(allocation.id);
    const golden = JSON.parse(
      await readFile(new URL("./fixtures/hire-receipts/completed-hire.json", import.meta.url), "utf8"),
    );
    const claim = (await remoteHireReceipts.claim("pc", {
      receiptId: golden.messageId,
      receiptKey: "completed-original",
      fingerprint: golden.fingerprint,
    }))!;
    const receipt = ReceiptSchema.parse({
      ...golden,
      paneId,
      sessionId: native.value,
      occupantId: occupant,
      remoteAdmission: { target: claim.target, nonce: claim.nonce },
    });
    await writeFile(`${watchPath}.hire-receipts.json`, JSON.stringify({ "completed-original": receipt }));
  }
  let controllerStopped = false;
  let nativeProtocol = options.controller
    ? await codex0160Protocol(root, { threadId: native.value, workingDirectory: options.cwd ?? root })
    : undefined;
  if (nativeProtocol) nativeProtocol.turns.push({ id: "saved-turn", status: "completed", items: [] });
  const adapter = nativeProtocol
    ? createCodexSeatAdapter({
        server: async (input) => {
          if (controllerStopped) {
            nativeProtocol = await codex0160Protocol(root, {
              threadId: native.value,
              workingDirectory: options.cwd ?? root,
            });
            nativeProtocol.turns.push({ id: "saved-turn", status: "completed", items: [] });
            controllerStopped = false;
          }
          const original = nativeProtocol!;
          return {
            ...(await original.launch(input)),
            close: async () => {
              controllerStopped = true;
              await original.close();
            },
          };
        },
        trackerOverrides: async () => [],
        herdr: async () => {},
      })
    : undefined;
  let control: SeatControl | undefined;
  if (adapter && nativeProtocol) {
    const started = await adapter.start(
      { harness: "codex", cwd: options.cwd ?? root, brief: "", resumeSessionId: native.value },
      {
        paneId,
        run: async () => {
          throw new Error("No terminal fallback");
        },
        start: async () => {
          nativeProtocol!.startView();
        },
      },
    );
    if (started.outcome !== "started") throw new Error(JSON.stringify(started));
    control = started.control;
    socketCleanups.push(async () => {
      await started.control.close();
      await nativeProtocol!.close();
    });
  }
  let watch = new HerdrWatchStore(watchPath, {
    runner,
    ...(adapter ? { remoteSeatAdapters: () => [adapter] } : {}),
    ...(options.reload
      ? {
          validateOwner: async () => true,
          remoteWorkspace: async (fleet: string, directory: string) =>
            fleet === "pc" && directory === options.cwd,
          nativeLaunchPolicy: { admit: async () => {}, prepare: async () => ({ args: [], env: {} }) },
        }
      : {}),
    ...(options.projectHire
      ? {
          remoteHireReceipts,
          projectHirePolicy: {
            settings: async () => settings,
            project: async () => "fixture",
            tools: async () => [],
            proof: async () =>
              ++proofReads >= refuseProofAt || controllerStopped
                ? undefined
                : { ...proof, pane: `pc/${pane.pane_id}` },
          },
        }
      : {}),
  });
  if (options.readopt) {
    // Replacement service loads the original journal, then admits path→id reattachment.
    watch.close();
    watch = new HerdrWatchStore(watchPath, { runner });
    await watch.readoptSeat(seatId, authority);
    watch.close();
    watch = new HerdrWatchStore(watchPath, { runner });
  }

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
    ...(options.projectHire
      ? {
          retirementGuard: (agent: Parameters<HerdrWatchStore["retirementGuard"]>[0]) =>
            watch.retirementGuard(agent),
        }
      : {}),
    ownerValid: async () => true,
    ...(options.projectHire
      ? {
          worktreeHold: () =>
            remoteRetirementWork(
              { id: "pc", session: "fixture", ssh: { host: "fixture-host", shell: "posix" } },
              async (command: string) =>
                (await promisify(execFile)("/bin/sh", ["-c", command], { timeout: 15000 })).stdout,
              [options.cwd ?? root],
            ),
        }
      : {}),
    close: (seat, guard) => watch.closeSeat(seat, guard),
    untrack: (seat) => watch.untrackSeat(seat),
    changed: () => {},
    now: () => now,
    resolve: async (ref) => ({
      ref,
      host: "local",
      sessionId: native.value,
      workingDirectory: options.cwd ?? root,
      file: { harness, path: join(root, "session.jsonl"), size: 1, mtimeMs: now },
    }),
    hire: async (request, brief, source) => {
      hires.push(request);
      if (options.reload)
        return watch.spawnSeat(
          request,
          undefined,
          brief,
          {
            ref: `pc:${native.value}`,
            host: { id: "pc", ssh: "fixture-host", shell: "posix" },
            sessionId: native.value,
            workingDirectory: options.cwd!,
            file: { harness, path: nativeProtocol!.rolloutPath, size: 1, mtimeMs: now },
          },
          source,
        );
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
    watchPath,
    ledger,
    refuseProofAfter: (reads: number) => {
      refuseProofAt = proofReads + reads;
    },
    replaceHostOnClose: () => {
      replaceHostOnClose = true;
    },
    control,
    protocol: () => nativeProtocol!,
    closeController: async () => {
      await (
        await adapter?.attach({ harness: "codex", sessionId: native.value, paneId: `pc/${pane.pane_id}` })
      )?.close();
    },
    controllerStopped: () => controllerStopped,
    receipts: () => new DeliveryFence(`${watchPath}.hire-receipts.json`).all(),
  };
}

// VUH-2311: production close, allocation, ownership and completed-receipt journals
// across the remote native socket boundary. No live PC panes are contacted.
it("records a completed remote project hire close without re-running live admission after exit", async () => {
  const f = await fixture({ remote: true, socket: true, projectHire: true });
  try {
    const result = await f.tidy.close(
      {
        pane: "pc/w1:p1",
        reason: "Reload the saved thread",
        reportPath: f.reportPath,
        unlandedReason: "Resume this same worktree and thread; clean commits remain retained",
      },
      authority,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "closed" });
    expect(f.closes()).toBe(1);
    expect(f.ledger.retirementCandidate("pc", "pc/w1:p1")).toBeUndefined();
    expect(f.receipts()[0]![1].retired).toBeDefined();
    expect(new PaneTidy(f.path, f.ports).history()).toMatchObject([{ state: "closed" }]);
  } finally {
    f.watch.close();
  }
});

it("a remote provenance refusal preserves allocation, owner, receipt and native roster", async () => {
  const f = await fixture({ remote: true, socket: true, projectHire: true, controller: true });
  try {
    const journals = [".owners.json", ".project-hires.json", ".hire-receipts.json"];
    const before = await Promise.all(journals.map((suffix) => readFile(f.watchPath + suffix, "utf8")));
    const roster = await f.ports.runner.list!("pc");
    // Capture valid original proof, then refuse its final native observation.
    f.refuseProofAfter(4);
    expect(
      await f.tidy.close(
        {
          pane: "pc/w1:p1",
          reason: "Reload",
          reportPath: f.reportPath,
          unlandedReason: "Resume the same saved work",
        },
        authority,
      ),
    ).toMatchObject({
      outcome: "failed",
      reason: "provenance_unknown",
    });
    expect(await Promise.all(journals.map((suffix) => readFile(f.watchPath + suffix, "utf8")))).toEqual(
      before,
    );
    expect(await f.ports.runner.list!("pc")).toEqual(roster);
    expect(f.closes()).toBe(0);
    expect(f.controllerStopped()).toBe(false);
    expect(await f.control!.status()).toBe("idle");
    expect(await f.control!.send("One distinct message after the refused close")).toMatchObject({
      outcome: "accepted",
    });
    expect(f.tidy.history()).toEqual([]);
  } finally {
    f.watch.close();
  }
});

it("reloads a remote Codex thread through close and ordinary hire/resume with four clean unlanded commits", async () => {
  const w = await workerWorktree();
  for (let i = 1; i <= 4; i++) {
    await writeFile(join(w.tree, "feature.txt"), `unlanded ${i}\n`);
    await git(w.tree, "add", "feature.txt");
    await git(w.tree, "commit", "--quiet", "-m", `Retained fixture ${i}`);
  }
  const head = await git(w.tree, "rev-parse", "HEAD");
  const f = await fixture({
    remote: true,
    socket: true,
    projectHire: true,
    controller: true,
    reload: true,
    cwd: w.tree,
  });
  try {
    expect(
      await f.tidy.close({ pane: "pc/w1:p1", reason: "Plugin reload", reportPath: f.reportPath }, authority),
    ).toMatchObject({
      outcome: "refused",
      reason: "unlanded_work",
      worktrees: [{ dirtyFiles: 0, unlandedCommits: 4 }],
    });
    expect(f.controllerStopped()).toBe(false);
    const closed = await f.tidy.close(
      {
        pane: "pc/w1:p1",
        reason: "Plugin reload",
        reportPath: f.reportPath,
        unlandedReason: "Resume the exact thread in this retained worktree; all four commits remain needed",
      },
      authority,
    );
    expect(closed).toMatchObject({
      outcome: "closed",
      entry: {
        unlanded: {
          reason: expect.stringContaining("all four commits"),
          worktrees: [{ dirtyFiles: 0, unlandedCommits: 4, head }],
        },
      },
    });
    if (closed.outcome !== "closed") throw new Error(JSON.stringify(closed));
    expect(f.controllerStopped()).toBe(true);
    const restarted = new PaneTidy(f.path, f.ports);
    const reopened = await restarted.undo(closed.entry.id, authority);
    expect(reopened, JSON.stringify(reopened)).toMatchObject({
      outcome: "reopened",
      entry: { resumedSeatId: "pc/term_222" },
    });
    expect(f.hires).toMatchObject([
      { fleet: "pc", harness: "codex", resume: `pc:${session.value}`, workingDirectory: w.tree },
    ]);
    expect(f.protocol().requests.filter(({ method }) => method === "thread/resume")).toMatchObject([
      { params: { threadId: session.value } },
    ]);
    expect(f.protocol().requests.some(({ method }) => method === "turn/start")).toBe(false);
    expect(await git(w.tree, "rev-parse", "HEAD")).toBe(head);
    expect(await git(w.tree, "status", "--porcelain")).toBe("");
    expect(await git(w.tree, "rev-list", "--count", "origin/main..HEAD")).toBe("4");
  } finally {
    f.watch.close();
    await f.closeController();
  }
});

it("retains an uncertain remote close when the host changes during post-exit bookkeeping", async () => {
  const f = await fixture({ remote: true, socket: true, projectHire: true });
  try {
    f.replaceHostOnClose();
    expect(
      await f.tidy.close({ pane: "pc/w1:p1", reason: "Reload", reportPath: f.reportPath }, authority),
    ).toMatchObject({
      outcome: "failed",
      reason: "close_unconfirmed",
    });
    expect(f.closes()).toBe(1);
    expect(f.receipts()[0]![1].retired).toBeUndefined();
    const restarted = new PaneTidy(f.path, f.ports);
    expect(restarted.history()).toMatchObject([{ state: "close_unconfirmed" }]);
    expect(await restarted.undo(restarted.history()[0]!.id, authority)).toMatchObject({
      reason: "undo_unknown",
    });
    expect(f.hires).toEqual([]);
  } finally {
    f.watch.close();
  }
});

it("keeps a remote uncertain resume visible and discovers its same thread before any second hire", async () => {
  const f = await fixture({ remote: true, socket: true, projectHire: true });
  try {
    const closed = await f.tidy.close(
      { pane: "pc/w1:p1", reason: "Reload", reportPath: f.reportPath },
      authority,
    );
    if (closed.outcome !== "closed") throw new Error(JSON.stringify(closed));
    f.setHire(async () => ({
      outcome: "failed",
      reason: "start_unconfirmed",
      detail: "fleet_command_failed: Native Herdr observation failed",
    }));
    expect(await f.tidy.undo(closed.entry.id, authority)).toMatchObject({
      reason: "undo_unconfirmed",
      detail: expect.stringContaining("Native Herdr observation failed"),
    });
    const restarted = new PaneTidy(f.path, f.ports);
    expect(restarted.leadHistory()).toMatchObject([
      { state: "closed", undoFailure: { detail: expect.stringContaining("start_unconfirmed") } },
    ]);
    f.reopenElsewhere();
    expect(await restarted.undo(closed.entry.id, authority)).toMatchObject({
      outcome: "reopened",
      entry: { resumedSeatId: "pc/term_999" },
    });
    expect(f.hires).toHaveLength(1);
    expect(f.hires[0]).toMatchObject({
      fleet: "pc",
      resume: `pc:${session.value}`,
      workingDirectory: f.root,
    });
  } finally {
    f.watch.close();
  }
});

// VUH-2130: actual Unix socket requests, production fleet qualification, and journals
// reloaded on both sides of re-adoption. No live owner panes or terminal typing.
it.each([false, true])("closes a proven hire after deploy/re-adoption (remote=%s)", async (remote) => {
  const f = await fixture({ socket: true, readopt: true, remote });
  const pane = remote ? "pc/w1:p1" : "w1:p1";
  const seat = remote ? "pc/term_111" : "term_111";
  await f.watch.adoptSeat(seat, authority);
  if (remote) {
    expect(
      await f.tidy.close({ pane, reason: "Harvested", reportPath: f.reportPath }, authority),
    ).toMatchObject({ outcome: "refused", reason: "unlanded_work" });
    expect(f.closes()).toBe(0);
  }
  const closed = await f.tidy.close(
    {
      pane,
      reason: "Landed and harvested",
      reportPath: f.reportPath,
      ...(remote ? { unlandedReason: "Remote work handed back to its project lead" } : {}),
    },
    authority,
  );
  if (remote) {
    // A reason cannot replace unavailable host-side work evidence (VUH-2153/2169).
    expect(closed).toMatchObject({ outcome: "refused", reason: "unlanded_work" });
    expect(f.closes()).toBe(0);
    f.watch.close();
    return;
  }
  expect(closed).toMatchObject({ outcome: "closed" });
  expect(f.closes()).toBe(1);
  expect(await f.ports.runner.resolveTerminal(seat)).toBeUndefined();
  expect(f.tidy.leadHistory()[0]).toMatchObject({ paneId: pane });
  f.watch.close();
});
it.each([false, true])(
  "re-adoption cannot turn a hand-started pane into a hire (remote=%s)",
  async (remote) => {
    const f = await fixture({ socket: true, readopt: true, adopted: true, remote });
    const pane = remote ? "pc/w1:p1" : "w1:p1";
    expect(await f.tidy.close({ pane, reason: "Finished", reportPath: f.reportPath }, authority)).toEqual({
      outcome: "refused",
      reason: "owner_interactive",
    });
    expect(f.closes()).toBe(0);
    f.watch.close();
  },
);
it("re-adoption cannot manufacture missing legacy hire provenance", async () => {
  const f = await fixture({ socket: true, readopt: true, legacy: true });
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Finished", reportPath: f.reportPath }, authority),
  ).toEqual({ outcome: "failed", reason: "provenance_unknown" });
  expect(f.closes()).toBe(0);
  f.watch.close();
});
it("still refuses a re-adopted hire's unsent draft over the Herdr socket", async () => {
  const f = await fixture({ socket: true, readopt: true });
  f.setAnsi(await golden("codex", "draft"));
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Finished", reportPath: f.reportPath }, authority),
  ).toMatchObject({ outcome: "refused", reason: "unsent_draft" });
  expect(f.closes()).toBe(0);
  f.watch.close();
});

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

it("refuses dirty files even with a reason, and allows an explicit reason for clean local commits", async () => {
  const w = await workerWorktree();
  await writeFile(join(w.tree, "feature.txt"), "unlanded\n");
  await git(w.tree, "add", "feature.txt");
  await git(w.tree, "commit", "--quiet", "-m", "unlanded feature");
  await writeFile(join(w.tree, "notes.txt"), "uncommitted\n");
  const f = await fixture({ cwd: w.tree, socket: true, readopt: true });
  const refused = await f.tidy.close({ pane: "w1:p1", reason: "Done", reportPath: f.reportPath }, authority);
  expect(refused).toMatchObject({
    outcome: "refused",
    reason: "unlanded_work",
    worktrees: [{ state: "unreconciled", branch: "pip/vuh-1", unlandedCommits: 1, dirtyFiles: 1 }],
  });
  expect(f.closes()).toBe(0);
  expect(
    await f.tidy.close(
      { pane: "w1:p1", reason: "Done", reportPath: f.reportPath, unlandedReason: "Superseded" },
      authority,
    ),
  ).toMatchObject({ outcome: "refused", reason: "unlanded_work" });
  await rm(join(w.tree, "notes.txt"));
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Done", reportPath: f.reportPath }, authority),
  ).toMatchObject({ outcome: "refused", reason: "unlanded_work" });
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
        worktrees: [{ unlandedCommits: 1, dirtyFiles: 0 }],
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

it.each(["worth_landing", "safe_to_drop"] as const)(
  "closes clean commits covered by a current HEAD %s decision, retaining its receipt",
  async (decision) => {
    const w = await workerWorktree();
    await writeFile(join(w.tree, "feature.txt"), "feature\n");
    await git(w.tree, "add", "feature.txt");
    await git(w.tree, "commit", "--quiet", "-m", "feature");
    const f = await fixture({ cwd: w.tree, socket: true });
    const recorded = await f.tidy.decideWorktree(
      { repository: w.repo, path: w.tree, decision, reason: "Reviewed handoff" },
      "lead",
    );
    const closed = await f.tidy.close({ pane: "w1:p1", reason: "Done", reportPath: f.reportPath }, authority);
    expect(closed).toMatchObject({
      outcome: "closed",
      entry: { handoffs: [{ kind: decision, reference: recorded.id, head: recorded.head }] },
    });
    expect(new PaneTidy(f.path, f.ports).leadHistory()[0]?.handoffs?.[0]?.reference).toBe(recorded.id);
    f.watch.close();
  },
);

it("refuses stale decisions and partially pushed history, then closes only when every commit is pushed", async () => {
  const w = await workerWorktree();
  const origin = join(w.repo, "..", "remote.git");
  await exec("git", ["init", "--quiet", "--bare", origin]);
  await git(w.repo, "remote", "add", "origin", origin);
  await git(w.repo, "push", "origin", "main");
  await writeFile(join(w.tree, "feature.txt"), "first\n");
  await git(w.tree, "add", "feature.txt");
  await git(w.tree, "commit", "--quiet", "-m", "first");
  const f = await fixture({ cwd: w.tree, socket: true });
  await f.tidy.decideWorktree(
    { repository: w.repo, path: w.tree, decision: "worth_landing", reason: "First only" },
    "lead",
  );
  await git(w.tree, "push", "origin", "HEAD:refs/heads/park/first");
  await writeFile(join(w.tree, "feature.txt"), "second\n");
  await git(w.tree, "commit", "--quiet", "-am", "second");
  // A fabricated tracking ref must not count as a pushed ref.
  await git(w.tree, "update-ref", "refs/remotes/origin/park/fake", "HEAD");
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Done", reportPath: f.reportPath }, authority),
  ).toMatchObject({ outcome: "refused", reason: "unlanded_work" });
  await git(w.tree, "push", "origin", "HEAD:refs/heads/park/all");
  expect(
    await f.tidy.close({ pane: "w1:p1", reason: "Done", reportPath: f.reportPath }, authority),
  ).toMatchObject({
    outcome: "closed",
    entry: { handoffs: expect.arrayContaining([expect.objectContaining({ kind: "remote_ref" })]) },
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
