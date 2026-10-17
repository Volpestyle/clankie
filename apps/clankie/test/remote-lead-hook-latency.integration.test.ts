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

// VUH-2161: real bundled hook processes, HTTP admission and captain journal.
// Only the native Windows proof is a fixture, with 250 ms of observation latency.
// This does not establish PC/SSH performance or the required live one-hour soak.
test("remote transcript hooks checkpoint history and bound a stalled upload without losing records", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-hook-latency-"));
  const repo = resolve(import.meta.dirname, "../../..");
  const sessionId = randomUUID();
  const transcriptPath = join(root, `${sessionId}.jsonl`);
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  const conversation = captain.createRemoteWorkspaceConversation({
    title: "Local latency proof",
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
  const grants = new RemoteLeadDelegations(async () => {}, join(root, "delegations"));
  const issued = await grants.issue(binding);
  const identity = {
    fleet: binding.fleet,
    pane: binding.pane,
    current: () => true,
    validate: async () => true,
    projectProof: async () => {
      await delay(250);
      return {
        fleet: binding.fleet,
        pane: binding.pane,
        nativeOccupantId: binding.nativeOccupantId,
        shell: binding.shell,
        binding: { socketPath: "fixture", session: "default" },
        workspace: { machineId: "pc", platform: "windows" as const, canonicalPath: "C:\\scratch" },
        processes: [{ pid: 456, startTime: "2026-10-09T00:00:01.0000000Z" }],
      };
    },
  };
  const bridge = createRemoteLeadBridge({ captain, delegations: grants, identity: () => identity });
  let stall = false;
  let requests = 0;
  const timings: string[] = [];
  const stop = new AbortController();
  const host = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests++;
      if (stall) {
        // Actual transport fault: accept the body but withhold the HTTP response.
        await request.arrayBuffer();
        await delay(60_000, undefined, { signal: AbortSignal.any([request.signal, stop.signal]) }).catch(
          () => {},
        );
        return new Response(null, { status: 503 });
      }
      const response = await bridge.app.fetch(request);
      timings.push(response.headers.get("server-timing") ?? "");
      return response;
    },
  }) as Server;
  const children = new Set<ReturnType<typeof spawn>>();
  const measurements: { event: string; elapsedMs: number; code: number | null; requests: number }[] = [];
  try {
    await promisify(execFile)(process.execPath, [join(repo, "scripts/build-remote-lead.mjs")], { cwd: repo });
    if (!host.listening) await once(host, "listening");
    const address = host.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    await mkdir(join(root, ".clankie/links"), { recursive: true });
    await writeFile(
      join(root, ".clankie/links/pc.json"),
      JSON.stringify({
        schemaVersion: 2,
        authentication: "local-process",
        fleet: "pc",
        url: `http://127.0.0.1:${address.port}`,
      }),
    );
    const record = (index: number) =>
      JSON.stringify({
        uuid: `message-${index}`,
        parentUuid: index ? `message-${index - 1}` : null,
        type: "user",
        message: { content: `Latency proof ${index}: ${"x".repeat(3_000)}` },
      }) + "\n";
    // Comparable to the incident's 0.8 MB / 227 lines; large enough to page.
    await writeFile(transcriptPath, Array.from({ length: 227 }, (_, index) => record(index)).join(""));
    const runHook = async (event: string) => {
      const started = performance.now();
      const before = requests;
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
      // A broken deadline fails promptly instead of hanging the suite for 37 s.
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        const done = once(child, "exit");
        child.stdin.end(
          JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: transcriptPath }),
        );
        const [code, signal] = await done;
        const elapsedMs = Math.round(performance.now() - started);
        measurements.push({ event, elapsedMs, code, requests: requests - before });
        expect(signal).toBeNull();
        expect(elapsedMs).toBeLessThan(3_500);
        return { code, stderr };
      } finally {
        clearTimeout(watchdog);
        children.delete(child);
      }
    };
    const messages = () =>
      new ConversationJournal(join(root, "conversations"))
        .read(binding.conversationId)
        .filter((event) => event.type === "message");
    expect(await runHook("UserPromptSubmit")).toEqual({ code: 0, stderr: "" });
    expect(messages(), await readFile(join(root, ".clankie/remote-leads/hooks.log"), "utf8")).toHaveLength(
      227,
    );
    await appendFile(transcriptPath, record(227));
    expect(await runHook("PostToolUse")).toEqual({ code: 0, stderr: "" });
    expect(messages()).toHaveLength(228);
    expect(measurements.at(-1)!.elapsedMs).toBeLessThan(1_500);
    // Acknowledged history needs no fresh multi-page proof on the next hook.
    expect(measurements.at(-1)!.requests).toBe(1);
    expect(timings.every((timing) => /auth;dur=\d+\.\d+, store;dur=\d+\.\d+/u.test(timing))).toBe(true);

    await appendFile(transcriptPath, record(228));
    stall = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await runHook("Stop");
      expect(result.code).toBe(attempt < 2 ? 0 : 1);
      if (attempt < 2) expect(result.stderr).toBe("");
      else {
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
        expect(result.stderr).toContain("Clankie seat sync failed 3 hooks in a row:");
      }
      expect(measurements.at(-1)!.requests).toBe(1);
    }
    expect(messages()).toHaveLength(228);
    stall = false;
    expect(await runHook("Stop")).toEqual({ code: 0, stderr: "" });
    expect(messages()).toHaveLength(229);
    const log = await readFile(join(root, ".clankie/remote-leads/hooks.log"), "utf8");
    expect(log).toContain("consecutiveFailures=3");
    expect(log.trim().split("\n").at(-1)).toMatch(/Stop exit=0 ms=\d+$/u);
    expect(log).not.toContain(issued.token);
    console.info("VUH-2161 local hook profile", {
      measurements,
      serverTimings: timings,
      hookRuns: log.split("\n").filter((line) => / exit=\d ms=/u.test(line)),
    });
  } finally {
    stop.abort();
    for (const child of children) child.kill("SIGKILL");
    await bridge.close();
    await captain.close();
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
