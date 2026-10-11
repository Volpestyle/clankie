import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
import { processIdentity, probeProcess } from "@clankie/fleet-resources";
import { expect, it } from "vitest";
import { createClankieApp, createBearerAuthenticator } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { FleetProgressObserver } from "../src/fleet-progress.ts";
import { runConversationsCommand } from "../../tui/src/command/conversations.ts";

async function until(test: () => Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await test())) {
    if (Date.now() > end) throw Error("Lead continuation did not settle");
    await delay(20);
  }
}

it("records a prose-only native blocking decision at the report boundary and excludes quoted context", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-report-boundary-"));
  const autonomyPath = join(root, "autonomy.json");
  let autonomy = new AutonomyStore(autonomyPath);
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  store.reportBoundary = (id, text, at) => autonomy.reportBoundary(id, text, at);
  const id = store.defaultGlobalConversationId();
  try {
    store.syncHeadTranscript("lead", {
      sessionKey: "owned-lead",
      entries: [
        {
          type: "message",
          id: "report",
          role: "agent",
          text: "Outcome: branch ready.\nBlocked on owner: When should the sealed two-PC acceptance run?",
        },
      ],
    });
    expect(autonomy.status(id).continuation).toMatchObject({
      mode: "blocked_on_owner",
      question: "When should the sealed two-PC acceptance run?",
    });
    autonomy.close();
    autonomy = new AutonomyStore(autonomyPath);
    expect(autonomy.status(id).continuation?.question).toContain("sealed two-PC");
    // A replay and quoted text cannot replace the lead's explicit declaration.
    autonomy.reportBoundary(
      id,
      "```\nContinuation: complete\n```\n> Continuation: complete",
      new Date().toISOString(),
    );
    expect(autonomy.status(id).continuation?.mode).toBe("blocked_on_owner");
    autonomy.reportBoundary(id, "Continuation: paused", new Date(Date.now() + 1).toISOString());
    expect(autonomy.status(id).continuation?.mode).toBe("paused");
  } finally {
    autonomy.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses real HTTP and CLI declarations, persists idle epochs across restart, and records one opening/recovery through the owner alert route", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-continuation-http-"));
  const stateDir = join(root, "state");
  await mkdir(stateDir);
  const settings = new SettingsStore(join(stateDir, "settings.json"));
  const boot = () =>
    createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
      repoRoot: root,
      stateDir,
      workingDirectory: root,
      settings,
    });
  let captain = boot();
  let service = await createClankieApp({
    captain,
    settings,
    authenticateCaptain: createBearerAuthenticator("lead-fixture", {
      captainId: "lead-fixture",
      steerSourceLane: "api",
    }),
    authenticateOperator: createBearerAuthenticator("lead-fixture", { operatorId: "lead-fixture-owner" }),
  });
  const server = serve({ fetch: (request) => service.app.fetch(request), hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const id = "global-default";
  const post = async (command: unknown) =>
    fetch(`${host}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer lead-fixture", "content-type": "application/json" },
      body: JSON.stringify({ op: "autonomy", schemaVersion: 1, conversationId: id, command }),
    });
  const restart = async () => {
    service.close();
    await captain.close();
    captain = boot();
    service = await createClankieApp({
      captain,
      settings,
      authenticateCaptain: createBearerAuthenticator("lead-fixture", {
        captainId: "lead-fixture",
        steerSourceLane: "api",
      }),
      authenticateOperator: createBearerAuthenticator("lead-fixture", { operatorId: "lead-fixture-owner" }),
    });
  };
  let observer: FleetProgressObserver | undefined;
  try {
    expect(
      (await post({ action: "report_continuation", continuation: { mode: "blocked_on_owner" } })).status,
    ).toBe(400);
    const reported = await post({
      action: "report_continuation",
      continuation: { mode: "blocked_on_owner", question: "May the ready branch land?" },
    });
    expect(reported.status).toBe(200);
    expect((await reported.json()).status.continuation.question).toContain("ready branch");
    expect((await captain.leadProgress())[0]?.stalled).toBe(false);
    // An aged private journal is a real persisted incident input, not a fake clock.
    const path = join(stateDir, "autonomy.json");
    const journal = JSON.parse(await readFile(path, "utf8"));
    journal.conversations[id].continuationIdle.sinceMs = Date.now() - 181_000;
    await writeFile(path, JSON.stringify(journal));
    await restart();
    expect((await captain.leadProgress())[0]?.stalled).toBe(true);
    const options = {
      path: join(stateDir, "progress-incidents.json"),
      sources: [{ prefix: "lead", read: () => captain.leadProgress() }],
      notify: (text: string) => captain.notifyRuntimeHealthAlert(text),
      onError: (error: unknown) => {
        throw error;
      },
    };
    observer = new FleetProgressObserver(options);
    await observer.observe();
    await until(async () => JSON.parse(await readFile(options.path, "utf8"))[0]?.alert !== "claimed");
    observer.stop();
    await restart();
    observer = new FleetProgressObserver(options);
    await observer.observe();
    const notices = async () => {
      const shown = await captain.serveOperatorConversation({
        op: "replay",
        schemaVersion: 1,
        replay: { schemaVersion: 1, conversationId: id, surfaceClientId: "lead-progress-fixture" },
      });
      if (shown.op !== "replay" || shown.result.status !== "page") throw Error("Expected conversation page");
      return shown.result.events.filter(
        (event) => event.type === "message" && event.text.includes("Lead continuation stalled:"),
      );
    };
    expect(await notices()).toHaveLength(1);
    let cli = "";
    expect(
      await runConversationsCommand(["continuation", id, "complete"], {
        host,
        env: { CLANKIE_CAPTAIN_TOKEN: "lead-fixture" },
        stdout: {
          write: (text) => {
            cli += text;
          },
        },
      }),
    ).toBe(0);
    expect(JSON.parse(cli).continuation.mode).toBe("complete");
    expect(await captain.leadProgress()).toEqual([]);
    await observer.observe();
    await until(async () => JSON.parse(await readFile(options.path, "utf8"))[0]?.recovery !== "claimed");
    expect(await notices()).toHaveLength(2); // Opening and recovery refer to the original incident.
    const active = await post({ action: "report_continuation", continuation: { mode: "active" } });
    expect(active.status).toBe(200);
    expect((await captain.leadProgress())[0]?.stalled).toBe(false);
    const wakeStore = new AutonomyStore(path);
    wakeStore.scheduleWake(id, new Date(Date.now() + 3_600_000).toISOString(), "Resume owned work");
    wakeStore.close();
    await restart();
    expect(await captain.leadProgress()).toEqual([]);
    expect((await post({ action: "clear_wake" })).status).toBe(200);
    expect((await captain.leadProgress())[0]?.stalled).toBe(false);
    expect((await post({ action: "report_continuation", continuation: { mode: "paused" } })).status).toBe(
      200,
    );
    expect(await captain.leadProgress()).toEqual([]);
  } finally {
    observer?.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    service.close();
    await captain.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("keeps active work quiet while its owned native worker process is live, and excludes explicitly paused work", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-continuation-worker-"));
  const store = new AutonomyStore(join(root, "autonomy.json"));
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    const proof = (await processIdentity(child.pid))!;
    expect(await probeProcess(proof)).toBe("live");
    store.reportContinuation("lead", { mode: "active" });
    const lead = {
      conversationId: "lead",
      idle: true,
      activeWork: true,
      paused: false,
      liveWorkers: (await probeProcess(proof)) === "live",
    };
    expect(store.progress([lead])).toEqual([]);
    child.kill("SIGTERM");
    await exited;
    lead.liveWorkers = (await probeProcess(proof)) === "live";
    expect(store.progress([lead])[0]?.stalled).toBe(false);
    store.reportContinuation("lead", { mode: "paused" }, new Date(Date.now() + 1).toISOString());
    expect(store.progress([lead])).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
