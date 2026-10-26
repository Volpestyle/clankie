import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import type { HarnessSeatAdapter, SeatControl, SeatEvent, SeatLaunch } from "@clankie/agent-hosts";
import { HiredSeatRestarts, type OriginalHiredRuntime } from "../src/captain/hired-seat-restart.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { nativeSessionId } from "../src/captain/native-session-resume.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { ProjectHires, type ProjectHireProcessProof } from "../src/captain/project-hires.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { nativeProcessStart, observeNativeBirth } from "../src/local-fleet-process.ts";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import { createClaudeWorkerSeatAdapter, SeatHookLog } from "../src/captain/claude-worker-seat.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
const shellProgram = `
const {spawn}=require('node:child_process');
let child;
process.on('message', message => {
 if(message==='start') {
  child=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.stdout.write('ready')"],{env:process.env,stdio:['ignore','pipe','ignore']});
  child.stdout.once('data',()=>process.send({started:child.pid}));
  child.once('exit',()=>{child=undefined;process.send({exited:true})});
 }
 if(message==='close') { if(child) child.kill('SIGTERM'); process.exit(0); }
});process.send({ready:true});`;
async function fixture(harness: "claude" | "codex") {
  const root = mkdtempSync(join(tmpdir(), "hired-native-restart-"));
  for (const name of ["home", "config", "data", "state", "cache", "runtime", "claude", "codex"])
    mkdirSync(join(root, name), { recursive: true });
  const shell: ChildProcess = spawn(process.execPath, ["-e", shellProgram], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    cwd: root,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
    },
  });
  await once(shell, "message");
  let nativePid: number | undefined;
  let afterExit = () => {};
  shell.on("message", (message) => {
    if (typeof message === "object" && message && "exited" in message) {
      nativePid = undefined;
      afterExit();
    }
  });
  cleanup.push(async () => {
    if (shell.exitCode === null) {
      const closed = once(shell, "exit");
      shell.send("close");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  async function startNative() {
    const started = new Promise<number>((resolve) => {
      const listener = (message: unknown) => {
        if (
          typeof message === "object" &&
          message &&
          "started" in message &&
          typeof message.started === "number"
        ) {
          shell.off("message", listener);
          resolve(message.started);
        }
      };
      shell.on("message", listener);
    });
    shell.send("start");
    nativePid = await started;
  }
  await startNative();
  const shellBirth = await observeNativeBirth(shell.pid!);
  expect(shellBirth, "native shell birth helper must be available").toBeDefined();
  const shellIdentity = { pid: shell.pid!, startTime: nativeProcessStart(shellBirth!) };
  const session = () => ({
    source: `herdr:${harness}`,
    kind: "path" as const,
    value: join(root, `${randomUUID()}.jsonl`),
  });
  let agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "original",
    agent: harness,
    status: "idle",
    title: "fixture",
    session: session(),
    workingDirectory: root,
  };
  writeFileSync(agent.session!.value, "");
  let proofOverride: ((proof: ProjectHireProcessProof) => ProjectHireProcessProof) | undefined;
  async function proof() {
    if (!nativePid) return;
    const birth = await observeNativeBirth(nativePid);
    if (!birth) return;
    const value: ProjectHireProcessProof = {
      nativeOccupantId: occupantIdForHerdrSession(agent.session!),
      fleet: "default",
      pane: agent.paneId,
      binding: { socketPath: join(root, "herdr.sock"), session: "fixture" },
      shell: shellIdentity,
      processes: [{ pid: nativePid, startTime: nativeProcessStart(birth) }],
    };
    return proofOverride ? proofOverride(value) : value;
  }
  let ansi = readFileSync(new URL(`./fixtures/pane-draft/${harness}-empty.ansi`, import.meta.url), "utf8");
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    readPane: async () => ansi,
    paneShell: async () => ({
      shellPid: shell.pid!,
      foreground: [{ pid: nativePid ?? shell.pid!, name: nativePid ? harness : "shell" }],
    }),
  };
  let messageId = "";
  let reply = "";
  let stop: SeatEvent = {
    type: "settlement_unconfirmed",
    at: new Date().toISOString(),
    reason: "no_native_completion",
  };
  let sends = 0;
  let closes = 0;
  let preparing = false;
  let interfere = false;
  const control: SeatControl = {
    ref: { harness, paneId: agent.paneId, sessionId: nativeSessionId(agent)! },
    status: async () => (preparing || agent.status !== "idle" ? "working" : "idle"),
    send: async (message, options) => {
      preparing = harness === "codex";
      try {
        await options?.beforeDispatch?.();
      } finally {
        preparing = false;
      }
      sends++;
      const uuid = randomUUID();
      messageId = harness === "claude" ? `claude:${uuid}` : uuid;
      const nonce = message.match(/handoff ID ([a-f0-9-]{36})/u)?.[1];
      reply = `handoff ID ${nonce}: exact remaining patch and receipts`;
      const now = new Date().toISOString();
      if (harness === "claude") {
        const prompt = {
          type: "user",
          uuid,
          parentUuid: null,
          isMeta: true,
          promptSource: "system",
          timestamp: now,
          message: { role: "user", content: `<channel source="fixture">${message}</channel>` },
        };
        const human = {
          type: "user",
          uuid: randomUUID(),
          parentUuid: uuid,
          timestamp: now,
          message: { role: "user", content: "owner changed the task" },
        };
        const answer = {
          type: "assistant",
          uuid: randomUUID(),
          parentUuid: interfere ? human.uuid : uuid,
          timestamp: now,
          message: { role: "assistant", content: [{ type: "text", text: reply }], stop_reason: "end_turn" },
        };
        appendFileSync(
          agent.session!.value,
          [prompt, ...(interfere ? [human] : []), answer].map((record) => JSON.stringify(record)).join("\n") +
            "\n",
        );
        stop = {
          type: "settlement_unconfirmed",
          at: now,
          reason: "message_correlation_unavailable",
          observedStop: { at: now, ok: true, text: reply },
        };
      } else {
        appendFileSync(
          agent.session!.value,
          [
            { type: "event_msg", timestamp: now, payload: { type: "user_message", message } },
            { type: "event_msg", timestamp: now, payload: { type: "agent_message", message: reply } },
          ]
            .map((record) => JSON.stringify(record))
            .join("\n") + "\n",
        );
        stop = { type: "turn_completed", at: now, messageId, ok: true, text: reply };
      }
      return { outcome: "accepted", messageId, state: "queued" };
    },
    settled: async () => stop,
    interrupt: async () => false,
    close: async () => {
      closes++;
    },
  };
  const launches: SeatLaunch[] = [];
  let failLaunch = false;
  const adapter: HarnessSeatAdapter = {
    harness,
    attach: async () => control,
    start: async (launch, view) => {
      if (failLaunch) throw new Error("injected failure after old exit");
      await view.guard?.();
      launches.push(launch);
      await startNative();
      agent = { ...agent, terminalId: "successor", session: session() };
      writeFileSync(agent.session!.value, "");
      const ref = { harness, paneId: agent.paneId, sessionId: nativeSessionId(agent)! };
      await view.bound?.(ref);
      return { outcome: "started", control: { ...control, ref } };
    },
  };
  let signals = 0;
  let afterSignal = () => {};
  const engine = new HiredSeatRestarts(join(root, "restarts.json"), runner, proof, (pid) => {
    signals++;
    process.kill(pid, "SIGTERM");
    afterSignal();
  });
  const originalProof = (await proof())!;
  const owners = new HireOwners(join(root, "owners.json"));
  const owner = { conversationId: "original-lead" };
  const originalOwnerIntent = owners.intent(owner);
  const sessionKey = (value: HerdrAgentSnapshot) =>
    JSON.stringify(["local", harness, nativeSessionId(value)]);
  owners.bind(
    agent.paneId,
    owner,
    agent.terminalId,
    originalOwnerIntent,
    occupantIdForHerdrSession(agent.session!),
    sessionKey(agent),
    "fixture",
  );
  const projects = new ProjectHires(join(root, "projects.json"));
  const allocation = projects.reserve(
    ProjectsSettingsSchema.parse({ projects: [{ id: "fixture", name: "Fixture" }] }),
    "fixture",
    {
      schemaVersion: 1,
      workingDirectory: root,
      title: "Fixture",
      harness,
      deliverable: "VUH-2824",
      model: "fixture-model",
      effort: "low",
    },
  );
  projects.pane(allocation.id, agent.paneId);
  projects.observe(allocation.id, agent.terminalId, originalProof.nativeOccupantId, originalProof);
  projects.confirmed(allocation.id);
  const successors: string[] = [];
  const runtime: OriginalHiredRuntime = {
    agent,
    originalBrief: "Work on VUH-2824 only",
    workItem: "VUH-2824",
    owner: { conversationId: "original-lead" },
    launch: {
      harness,
      cwd: root,
      brief: "Work on VUH-2824 only",
      model: "fixture-model",
      effort: "low",
      env: {
        HOME: join(root, "home"),
        CODEX_HOME: join(root, "codex"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
      },
      mcpServers: ["worker"],
    },
    view: {
      paneId: agent.paneId,
      name: "fixture",
      run: async () => {
        throw new Error("terminal fallback forbidden");
      },
    },
    control,
    adapter,
    proof: originalProof,
    prepared: false,
    admitRestart: async () => {},
    successor: async (previous, next, observed, id) => {
      expect(nativeSessionId(previous)).not.toBe(nativeSessionId(next));
      expect(observed.shell).toEqual(originalProof.shell);
      const receipt = engine.journal().find((entry) => entry.id === id)!;
      expect(receipt.stage).toBe("launching");
      projects.restartSuccessor(
        allocation.id,
        id,
        {
          pane: previous.paneId,
          seat: previous.terminalId,
          occupantId: occupantIdForHerdrSession(previous.session!),
          proof: receipt.previousProof as ProjectHireProcessProof,
        },
        { seat: next.terminalId, occupantId: observed.nativeOccupantId, proof: observed },
      );
      owners.restartSuccessor({
        receiptId: id,
        paneId: previous.paneId,
        previousSeatId: previous.terminalId,
        previousOccupantId: occupantIdForHerdrSession(previous.session!),
        previousSessionKey: sessionKey(previous),
        seatId: next.terminalId,
        occupantId: observed.nativeOccupantId,
        sessionKey: sessionKey(next),
        owner,
      });
      expect(owners.owner(next.paneId, next.terminalId, observed.nativeOccupantId)).toEqual(owner);
      expect(projects.retirementCandidate("default", next.paneId)?.request.deliverable).toBe("VUH-2824");
      expect(projects.retirementCandidate("default", next.paneId)?.restartPredecessors?.at(-1)).toMatchObject(
        {
          receiptId: id,
          seat: previous.terminalId,
          occupantId: occupantIdForHerdrSession(previous.session!),
        },
      );
      const ownership = JSON.parse(readFileSync(join(root, "owners.json"), "utf8"));
      expect(ownership.restartSuccessors.at(-1)).toMatchObject({
        receiptId: id,
        previous: { sessionKey: sessionKey(previous), owner },
        next: { sessionKey: sessionKey(next), owner },
      });
      successors.push(id);
    },
  };
  engine.register(runtime);
  const candidate = (await engine.candidates())[0]!;
  const request = `Write handoff ID ${randomUUID()} and repeat it in your final native reply.`;
  return {
    root,
    engine,
    candidate,
    request,
    launches,
    successors,
    originalProof,
    runtime,
    runner,
    adapter,
    proof,
    currentAgent: () => agent,
    appendRecord: (record: unknown) => appendFileSync(agent.session!.value, JSON.stringify(record) + "\n"),
    closes: () => closes,
    signals: () => signals,
    afterExit: (callback: () => void) => {
      afterExit = callback;
    },
    afterSignal: (callback: () => void) => {
      afterSignal = callback;
    },
    reply: () => reply,
    nativePid: () => nativePid,
    sends: () => sends,
    status: (status: string) => {
      agent = { ...agent, status };
    },
    draft: () => {
      ansi = readFileSync(new URL(`./fixtures/pane-draft/${harness}-draft.ansi`, import.meta.url), "utf8");
    },
    changeProof: (mutate: (proof: ProjectHireProcessProof) => ProjectHireProcessProof) => {
      proofOverride = mutate;
    },
    interfere: () => {
      interfere = true;
    },
    failLaunch: () => {
      failLaunch = true;
    },
  };
}

it.each(["claude", "codex"] as const)(
  "restarts original %s fixture subprocess in its own surviving shell, once",
  async (harness) => {
    const f = await fixture(harness);
    const oldPid = f.nativePid();
    const result = await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
    expect(result.outcome).toBe("replied");
    const restarted = await f.candidate.restart(
      `Original work item plus saved file.\n${f.reply()}`,
      async () => {},
    );
    expect(restarted.outcome).toBe("restarted");
    expect(f.nativePid()).not.toBe(oldPid);
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({
      model: "fixture-model",
      effort: "low",
      mcpServers: ["worker"],
      env: { HOME: join(f.root, "home") },
    });
    expect(f.launches[0]!.brief).toContain("Work on VUH-2824 only");
    expect(f.launches[0]!.brief).toContain(f.reply());
    expect(f.successors).toEqual([restarted.receiptId]);
    expect(f.closes()).toBe(1);
    expect(f.engine.journal().find((row) => row.id === restarted.receiptId)?.stage).toBe("restarted");
  },
);
it.each(["busy", "draft", "birth", "binding"])(
  "refuses %s before native effects and persists why",
  async (reason) => {
    const f = await fixture("codex");
    if (reason === "busy") f.status("working");
    if (reason === "draft") f.draft();
    if (reason === "birth")
      f.changeProof((proof) => ({ ...proof, processes: [{ ...proof.processes[0]!, startTime: "changed" }] }));
    if (reason === "binding") f.changeProof((proof) => ({ ...proof, binding: { socketPath: "changed" } }));
    const result = await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
    expect(result.outcome).toBe("refused");
    expect(f.sends()).toBe(0);
    expect(f.launches).toHaveLength(0);
    expect(f.engine.journal().at(-1)?.stage).toBe("refused");
  },
);
it("retains uncertainty after the old process exits and refuses a second launch", async () => {
  const f = await fixture("codex");
  await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
  f.failLaunch();
  expect((await f.candidate.restart(f.reply(), async () => {})).outcome).toBe("uncertain");
  expect(f.nativePid()).toBeUndefined();
  expect((await f.candidate.restart(f.reply(), async () => {})).outcome).toBe("refused");
  expect(f.launches).toHaveLength(0);
});
it("does not correlate a Claude Stop across an intervening owner prompt", async () => {
  const f = await fixture("claude");
  f.interfere();
  expect(
    (await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(250))).outcome,
  ).toBe("uncertain");
  expect(f.sends()).toBe(1);
  expect(f.launches).toHaveLength(0);
  expect(
    (await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(250))).outcome,
  ).toBe("refused");
  expect(f.sends()).toBe(1);
});
it("shows original runtime loss after service replacement without reconstructing authority", async () => {
  const f = await fixture("codex");
  const runner: HerdrWatchRunner = {
    get: async () => f.candidate.agent,
    resolveTerminal: async () => f.candidate.agent,
    wait: async () => f.candidate.agent,
  };
  const replacement = new HiredSeatRestarts(join(f.root, "restarts.json"), runner, async () => undefined);
  const candidate = (await replacement.candidates())[0]!;
  const result = await candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(250));
  expect(result).toMatchObject({
    outcome: "refused",
    reason: "original_runtime_unavailable_after_service_restart",
  });
  expect(f.sends()).toBe(0);
});

it("refuses a Claude home-directory trust boundary before sending a handoff", async () => {
  const f = await fixture("claude");
  f.engine.register({ ...f.runtime, launch: { ...f.runtime.launch, cwd: f.runtime.launch.env!.HOME! } });
  const candidate = (await f.engine.candidates())[0]!;
  const result = await candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
  expect(result).toMatchObject({ outcome: "refused", reason: "Error: trust_required" });
  expect(f.sends()).toBe(0);
});
it("rechecks native idle after policy awaits and leaves a late pre-signal refusal retryable", async () => {
  const f = await fixture("codex");
  await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
  const oldPid = f.nativePid();
  let guards = 0;
  const refused = await f.candidate.restart(f.reply(), async () => {
    if (++guards === 2) f.status("working");
  });
  expect(refused).toMatchObject({ outcome: "refused", reason: "Error: not_idle" });
  expect(f.nativePid()).toBe(oldPid);
  expect(f.launches).toHaveLength(0);
  f.status("idle");
  expect((await f.candidate.restart(f.reply(), async () => {})).outcome).toBe("restarted");
  expect(f.sends()).toBe(1);
  expect(f.launches).toHaveLength(1);
});

it.each([
  "unchanged",
  "maximum-trust",
  "account-key",
  "identity",
  "identity-unknown",
  "home",
  "canonical-home",
  "signed-out",
  "unknown",
  "usage",
  "benign-after-exit",
  "revoked-after-exit",
  "trust-revoked-after-exit",
])("uses fresh persisted-owner authority and checks %s at the native restart boundary", async (change) => {
  const f = await fixture("codex");
  let live = false;
  let initial = true;
  let sourceCurrent = true;
  const launches: string[] = [];
  const runner: HerdrWatchRunner = {
    ...f.runner,
    list: async () => (live ? [f.currentAgent()] : []),
    createTab: async () => f.currentAgent().paneId,
    startAgent: async () => {
      launches.push("native-start");
    },
    runInPane: async () => {
      launches.push("native-run");
    },
  };
  const adapter: HarnessSeatAdapter = {
    harness: "codex",
    attach: async () => f.runtime.control,
    start: async (launch, view) => {
      await view.guard?.();
      await view.start?.("codex", []);
      if (initial) {
        initial = false;
        live = true;
        await view.bound?.(f.runtime.control.ref);
        return { outcome: "started", control: f.runtime.control };
      }
      return f.adapter.start(launch, view);
    },
  };
  const settings = ProjectsSettingsSchema.parse({ projects: [{ id: "fixture", name: "Fixture" }] });
  let projectChecks = 0;
  let maximumTrust = change === "trust-revoked-after-exit";
  let ownerValid = true;
  const accountHome = join(f.root, "account-profile");
  mkdirSync(join(f.root, "account-a"));
  mkdirSync(join(f.root, "account-b"));
  symlinkSync(join(f.root, "account-a"), accountHome, "dir");
  let account: import("../src/captain/harness-accounts.ts").WorkerAccountStatus = {
    harness: "codex",
    label: "fixture",
    accountKey: "fixture-account",
    identity: "fixture@example.test",
    aliases: ["fixture-account"],
    home: accountHome,
    signedIn: true,
    usable: true,
    plan: "pro",
    headroom: 0.8,
    usage: {
      source: "codex-rate-limits",
      observedAt: new Date().toISOString(),
      windows: [{ id: "week", label: "Week", usedPercent: 20 }],
    },
  };
  const accountReport = async () => ({
    machine: "local",
    shell: "posix" as const,
    observedAt: new Date().toISOString(),
    accounts: [account],
  });
  const store = new HerdrWatchStore(join(f.root, "watcher.json"), {
    runner,
    seatAdapters: [adapter],
    validateOwner: async (owner) => ownerValid && owner.conversationId === "original-lead",
    requireWorkerAccess: async () => {},
    maximumTrustMode: async () => maximumTrust,
    workerAccounts: accountReport,
    nativeLaunchPolicy: { admit: async () => {} },
    projectHirePolicy: {
      settings: async () => settings,
      tools: async () => [],
      proof: async () => f.proof(),
      project: async (_input, _settings, authority) => {
        if (!authority?.current() || !(await authority.authorize()))
          throw new Error("expired project authority");
        projectChecks++;
        return "fixture";
      },
    },
    workerAccountsReport: accountReport,
  });
  cleanup.push(async () => store.close());
  const hired = await store.spawnSeat(
    {
      schemaVersion: 1,
      harness: "codex",
      title: "Fixture",
      projectId: "fixture",
      workingDirectory: f.root,
      deliverable: "VUH-2824",
      model: "fixture-model",
      effort: "low",
      effortReason: "Focused original native fixture deliverable",
    },
    "fixture",
    "Work on VUH-2824 only",
    undefined,
    {
      owner: { conversationId: "original-lead" },
      ...(change === "usage" ? { ownerHire: { surface: "desktop" as const, overrideUsage: true } } : {}),
      current: () => sourceCurrent,
      authorize: async () => sourceCurrent,
    },
  );
  expect(hired.outcome, JSON.stringify(hired)).toBe("spawned");
  sourceCurrent = false;
  const candidate = (await store.freshRestartCandidates())[0]!;
  expect((await candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000))).outcome).toBe(
    "replied",
  );
  const oldPid = f.nativePid();
  if (change === "maximum-trust") maximumTrust = true;
  if (change === "account-key") account = { ...account, accountKey: "changed-account" };
  if (change === "identity") account = { ...account, identity: "other@example.test" };
  if (change === "identity-unknown") account = { ...account, identity: "" };
  if (change === "canonical-home") {
    unlinkSync(accountHome);
    symlinkSync(join(f.root, "account-b"), accountHome, "dir");
  }
  if (change === "home") account = { ...account, home: join(f.root, "other") };
  if (change === "signed-out") account = { ...account, signedIn: false };
  if (change === "unknown") account = { ...account, signedIn: null };
  if (change === "usage")
    account = {
      ...account,
      headroom: 0.05,
      usable: true,
      usage: {
        source: "codex-rate-limits",
        observedAt: new Date().toISOString(),
        windows: [{ id: "week", label: "Week", usedPercent: 95 }],
      },
    };
  if (change === "benign-after-exit")
    f.afterExit(() => {
      maximumTrust = true;
      account = { ...account, headroom: 0, usable: false };
    });
  if (change === "revoked-after-exit")
    f.afterExit(() => {
      ownerValid = false;
    });
  if (change === "trust-revoked-after-exit")
    f.afterExit(() => {
      maximumTrust = false;
    });
  const result = await candidate.restart(f.reply(), async () => {});
  if (["revoked-after-exit", "trust-revoked-after-exit"].includes(change)) {
    expect(result.outcome, JSON.stringify(result)).toBe("uncertain");
    expect(f.nativePid()).toBeUndefined();
    expect(launches).toHaveLength(1);
    return;
  }
  if (!["unchanged", "benign-after-exit"].includes(change)) {
    expect(result.outcome, JSON.stringify(result)).toBe("refused");
    expect(f.nativePid()).toBe(oldPid);
    expect(f.closes()).toBe(0);
    expect(launches).toHaveLength(1);
    return;
  }
  expect(result.outcome, JSON.stringify(result)).toBe("restarted");
  expect(projectChecks).toBeGreaterThan(1);
  expect(launches).toHaveLength(2);
  expect(store.nativeOwner(f.currentAgent())).toEqual({ conversationId: "original-lead" });
});

it.each(["claude-human-channel", "claude-compaction", "codex-input", "codex-compaction"])(
  "refuses a kept handoff superseded by %s",
  async (kind) => {
    const harness = kind.startsWith("claude") ? "claude" : "codex";
    const f = await fixture(harness);
    expect(
      (await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000))).outcome,
    ).toBe("replied");
    const oldPid = f.nativePid();
    if (kind === "claude-human-channel")
      f.appendRecord({
        type: "user",
        uuid: randomUUID(),
        isMeta: false,
        promptSource: "human",
        message: { role: "user", content: "<channel>human typed this</channel>" },
      });
    if (kind === "claude-compaction")
      f.appendRecord({
        type: "system",
        uuid: randomUUID(),
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto" },
      });
    if (kind === "codex-input")
      f.appendRecord({ type: "event_msg", payload: { type: "user_message", message: "new native work" } });
    if (kind === "codex-compaction")
      f.appendRecord({ type: "compacted", payload: { message: "native compact summary" } });
    expect(await f.candidate.restart(f.reply(), async () => {})).toMatchObject({
      outcome: "refused",
      reason: "Error: handoff_superseded",
    });
    expect(f.nativePid()).toBe(oldPid);
    expect(f.closes()).toBe(0);
    expect(f.launches).toHaveLength(0);
    expect(f.sends()).toBe(1);
  },
);
it("ignores Codex token-only counters when proving the kept handoff is still latest", async () => {
  const f = await fixture("codex");
  await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
  f.appendRecord({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500000 } } },
  });
  expect((await f.candidate.restart(f.reply(), async () => {})).outcome).toBe("restarted");
});

it.each(["account", "project", "tools", "resources"])(
  "keeps the original native process when %s admission refuses at the restart boundary",
  async (boundary) => {
    const f = await fixture("codex");
    await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
    const oldPid = f.nativePid();
    f.runtime.admitRestart = async () => {
      expect(f.nativePid()).toBe(oldPid);
      expect(f.signals()).toBe(0);
      throw new Error(`${boundary}_refused`);
    };
    expect(await f.candidate.restart(f.reply(), async () => {})).toMatchObject({
      outcome: "refused",
      reason: `Error: ${boundary}_refused`,
    });
    expect(f.signals()).toBe(0);
    expect(f.nativePid()).toBe(oldPid);
    expect(f.closes()).toBe(0);
    expect(f.launches).toHaveLength(0);
    f.runtime.admitRestart = async () => {};
    expect((await f.candidate.restart(f.reply(), async () => {})).outcome).toBe("restarted");
    expect(f.signals()).toBe(1);
  },
);
it("completes admitted replacement despite benign policy changes after signal", async () => {
  const f = await fixture("codex");
  await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
  let policyCurrent = true;
  let admissions = 0;
  f.runtime.admitRestart = async () => {
    admissions++;
    expect(f.signals()).toBe(0);
    if (!policyCurrent) throw new Error("policy_changed");
  };
  f.afterSignal(() => {
    policyCurrent = false;
  });
  const phases: (string | undefined)[] = [];
  const result = await f.candidate.restart(f.reply(), async (phase) => {
    phases.push(phase);
    if (phase !== "successor" && !policyCurrent) throw new Error("policy_changed");
  });
  expect(result.outcome).toBe("restarted");
  expect(admissions).toBe(1);
  expect(phases.filter((phase) => phase === "successor")).toHaveLength(2);
  expect(f.successors).toEqual([result.receiptId]);
});
it.each(["owner_revoked", "service_shutdown"])(
  "retains uncertainty and prevents successor launch on %s after signal",
  async (reason) => {
    const f = await fixture("codex");
    await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
    let revoked = false;
    f.afterSignal(() => {
      revoked = true;
    });
    const result = await f.candidate.restart(f.reply(), async (phase) => {
      if (phase === "successor" && revoked) throw new Error(reason);
    });
    expect(result).toMatchObject({ outcome: "uncertain", reason: `Error: ${reason}` });
    expect(f.signals()).toBe(1);
    expect(f.nativePid()).toBeUndefined();
    expect(f.launches).toHaveLength(0);
    expect(f.successors).toHaveLength(0);
    expect((await f.candidate.restart(f.reply(), async () => {})).outcome).toBe("refused");
    expect(f.signals()).toBe(1);
  },
);

it("preserves the unresolved-effect fence when later native input supersedes the handoff", async () => {
  const f = await fixture("codex");
  await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
  f.failLaunch();
  expect((await f.candidate.restart(f.reply(), async () => {})).outcome).toBe("uncertain");
  f.appendRecord({ type: "event_msg", payload: { type: "user_message", message: "later native input" } });
  expect(await f.candidate.restart(f.reply(), async () => {})).toMatchObject({
    outcome: "refused",
    reason: "Error: unresolved_original_receipt",
  });
  expect(f.signals()).toBe(1);
  expect(f.launches).toHaveLength(0);
});
it("runs adapter startup admission before signalling and preserves the original on refusal", async () => {
  const f = await fixture("codex");
  await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
  const oldPid = f.nativePid();
  let admittedLaunch: SeatLaunch | undefined;
  f.adapter.admitRestart = async (launch) => {
    expect(f.nativePid()).toBe(oldPid);
    expect(f.signals()).toBe(0);
    admittedLaunch = launch;
    throw new Error("native_startup_admission_refused");
  };
  expect(await f.candidate.restart(f.reply(), async () => {})).toMatchObject({
    outcome: "refused",
    reason: "Error: native_startup_admission_refused",
  });
  expect(f.nativePid()).toBe(oldPid);
  expect(f.signals()).toBe(0);
  f.adapter.admitRestart = async (launch) => {
    admittedLaunch = launch;
  };
  expect((await f.candidate.restart(f.reply(), async () => {})).outcome).toBe("restarted");
  expect(f.launches[0]).toBe(admittedLaunch);
  expect(admittedLaunch?.resumeSessionId).toBeUndefined();
});

it.each(["claude", "codex"] as const)(
  "runs the real %s adapter admission before any original native signal",
  async (harness) => {
    const f = await fixture(harness);
    await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
    const oldPid = f.nativePid();
    const adapter =
      harness === "claude"
        ? createClaudeWorkerSeatAdapter({
            consent: async () => ({
              approved: false,
              detail: "owner consent absent",
              fix: "approve channel",
            }),
            hooks: new SeatHookLog(join(f.root, "hooks.jsonl")),
            agent: async () => undefined,
            transcript: async () => undefined,
            mailbox: { bound: () => false, deliver: async () => false },
          })
        : createCodexSeatAdapter({
            fleetGates: async () => {
              throw new Error("fleet gates unavailable");
            },
          });
    f.adapter.admitRestart = (launch) => adapter.admitRestart!(launch);
    const result = await f.candidate.restart(f.reply(), async () => {});
    expect(result.outcome).toBe("refused");
    expect(result.reason).toContain(harness === "claude" ? "consent_required" : "fleet gates unavailable");
    expect(f.nativePid()).toBe(oldPid);
    expect(f.signals()).toBe(0);
    expect(f.closes()).toBe(0);
    expect(f.launches).toHaveLength(0);
  },
);

it.each(["handoff_sending", "handoff_sent"] as const)(
  "refuses a retained old handoff behind a newer unresolved %s receipt",
  async (stage) => {
    const f = await fixture("codex");
    await f.candidate.requestHandoff(f.request, async () => {}, AbortSignal.timeout(2000));
    f.appendRecord({
      type: "event_msg",
      payload: { type: "user_message", message: "newer unresolved send" },
    });
    const receipts = [
      ...f.engine.journal(),
      {
        id: randomUUID(),
        paneId: f.currentAgent().paneId,
        previousSessionId: nativeSessionId(f.currentAgent()),
        at: new Date().toISOString(),
        stage,
      },
    ];
    const path = join(f.root, "restarts.json");
    writeFileSync(path, JSON.stringify(receipts));
    const engine = new HiredSeatRestarts(path, f.runner, f.proof);
    engine.register(f.runtime);
    const candidate = (await engine.candidates())[0]!;
    expect(await candidate.restart(f.reply(), async () => {})).toMatchObject({
      outcome: "refused",
      reason: "Error: unresolved_original_receipt",
    });
    expect(f.nativePid()).toBe(f.originalProof.processes[0]!.pid);
    expect(f.closes()).toBe(0);
    expect(f.launches).toHaveLength(0);
  },
);
