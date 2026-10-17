import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { expect, test } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { createRemoteLeadBridge } from "../src/remote-lead-bridge.ts";
import { RemoteLeadDelegations } from "../src/remote-lead-delegations.ts";

// VUH-2075: real bundled hooks, a disappearing HTTP listener, persisted
// delegation and captain journal. Only Windows/native process proof is a fixture.
// This does not sign in a profile, run a model or restart the installed service.
test("SessionStart survives a service listener restart without reviving a revoked launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-session-start-"));
  const repo = resolve(import.meta.dirname, "../../..");
  const sessionId = randomUUID();
  const transcript = join(root, `${sessionId}.jsonl`);
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  const conversation = captain.createRemoteWorkspaceConversation({
    title: "SessionStart restart proof",
    workspaceId: "C:\\scratch",
    machineId: "pc",
  });
  const binding = {
    fleet: "pc",
    machine: "pc",
    pane: "w1:p1",
    conversationId: conversation.conversationId,
    nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:claude", kind: "id", value: sessionId }),
    workingDirectory: "C:\\scratch",
    connectionKey: "fixture",
    shell: { pid: 123, startTime: "2026-10-09T00:00:00.0000000Z" },
  };
  const identity = {
    fleet: binding.fleet,
    pane: binding.pane,
    current: () => true,
    validate: async () => true,
    projectProof: async () => ({
      fleet: binding.fleet,
      pane: binding.pane,
      nativeOccupantId: binding.nativeOccupantId,
      shell: binding.shell,
      binding: { socketPath: "fixture", session: "default" },
      workspace: { machineId: "pc", platform: "windows" as const, canonicalPath: "C:\\scratch" },
      processes: [{ pid: 456, startTime: "2026-10-09T00:00:01.0000000Z" }],
    }),
  };
  const directory = join(root, "delegations");
  let grants = new RemoteLeadDelegations(async () => {}, directory);
  const issued = await grants.issue(binding);
  const makeBridge = () => createRemoteLeadBridge({ captain, delegations: grants, identity: () => identity });
  let bridge = makeBridge();
  const startHost = () => serve({ hostname: "127.0.0.1", port: 0, fetch: bridge.app.fetch }) as Server;
  let host = startHost();
  const children = new Set<ReturnType<typeof spawn>>();
  const measurements: { event: string; code: number | null; elapsedMs: number }[] = [];
  try {
    await promisify(execFile)(process.execPath, [join(repo, "scripts/build-remote-lead.mjs")], { cwd: repo });
    await mkdir(join(root, ".clankie/links"), { recursive: true });
    const publishAddress = async () => {
      if (!host.listening) await once(host, "listening");
      const address = host.address();
      if (!address || typeof address === "string") throw Error("Missing fixture listener");
      await writeFile(
        join(root, ".clankie/links/pc.json"),
        JSON.stringify({
          schemaVersion: 2,
          authentication: "local-process",
          fleet: "pc",
          url: `http://127.0.0.1:${address.port}`,
        }),
      );
    };
    await publishAddress();
    const record = (index: number) =>
      JSON.stringify({
        uuid: `message-${index}`,
        parentUuid: index ? `message-${index - 1}` : null,
        type: "user",
        message: { content: `SessionStart proof ${index}` },
      }) + "\n";
    await writeFile(transcript, record(0));
    const runHook = (event: string) => {
      const started = performance.now();
      const child = spawn(
        process.execPath,
        [join(repo, ".local/remote-lead/remote-lead-mcp.mjs"), "--sync"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: root,
            CLANKIE_REMOTE_LEAD_TOKEN: issued.token,
            CLANKIE_REMOTE_LEAD_FLEET: "pc",
            HERDR_PANE_ID: binding.pane,
            CLANKIE_CONVERSATION_ID: binding.conversationId,
            CLANKIE_SEAT_SESSION_ID: sessionId,
            CLANKIE_SEAT_HARNESS: "claude",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.add(child);
      let stderr = "";
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const done = once(child, "exit")
        .then(([code, signal]) => {
          measurements.push({ event, code, elapsedMs: Math.round(performance.now() - started) });
          return { code, signal, stderr };
        })
        .finally(() => {
          clearTimeout(watchdog);
          children.delete(child);
        });
      child.stdin.end(
        JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: transcript }),
      );
      return done;
    };
    const messages = () =>
      new ConversationJournal(join(root, "conversations"))
        .read(binding.conversationId)
        .filter((event) => event.type === "message");
    // Establish an original native proof before restart; unproved launches must
    // still refuse recovery under the existing VUH-2141 authority contract.
    expect(await runHook("UserPromptSubmit")).toEqual({ code: 0, signal: null, stderr: "" });
    expect(messages()).toHaveLength(1);
    await bridge.close();
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await appendFile(transcript, record(1));
    const startup = runHook("SessionStart");
    // The real listener stays absent beyond the everyday hook's two-second budget.
    await delay(3_000);
    grants = new RemoteLeadDelegations(async () => {}, directory);
    bridge = makeBridge();
    host = startHost();
    await publishAddress();
    expect(await startup).toEqual({ code: 0, signal: null, stderr: "" });
    expect(messages(), await readFile(join(root, ".clankie/remote-leads/hooks.log"), "utf8")).toHaveLength(2);
    // A permanent refusal never becomes a fresh authority claim on another retry.
    grants.revoke(issued.id);
    await appendFile(transcript, record(2));
    const refused = await runHook("SessionStart");
    expect(refused.code).toBe(1);
    expect(refused.signal).toBeNull();
    expect(refused.stderr).toContain("Remote lead delegation explicitly revoked");
    expect(refused.stderr).not.toContain(issued.token);
    expect(messages()).toHaveLength(2);
    console.info("VUH-2075 owned SessionStart restart", { measurements });
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await bridge.close();
    await captain.close();
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
