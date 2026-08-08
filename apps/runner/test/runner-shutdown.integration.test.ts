import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { BODY_LOCK_FILENAME, parseFreePlayJournal, type FreePlayJournalLine } from "@clankie/gba-emulator";
import type { EmbodimentLifecycleReport, EmbodimentSession } from "@clankie/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const RUNNER_ID = "shutdown-integration-runner";
const TOKEN = "runner-shutdown-integration-token";
const runningChildren = new Set<ChildProcess>();

afterEach(() => {
  for (const child of runningChildren) child.kill("SIGKILL");
  runningChildren.clear();
});

describe("runner asked-play process shutdown", () => {
  it("settles SIGTERM at a turn boundary with a journal summary, checkpoint, and released body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clankie-runner-graceful-"));
    const control = await fakeControlPlane({ assigned: session("graceful-session") });
    try {
      const child = startRunner(root, control.url, "shutdown-fixture");
      await vi.waitFor(() => expect(states(control.reports, "graceful-session")).toContain("running"), {
        timeout: 10_000,
      });

      child.kill("SIGTERM");
      await expect(exitOf(child)).resolves.toMatchObject({ code: 143, signal: null });
      expect(states(control.reports, "graceful-session")).toEqual(["running", "stopping", "stopped"]);

      const journal = onlyJournal(path.join(root, "journals"));
      expect(journal.map((line) => line.kind)).toContain("turn");
      expect(journal.at(-1)).toMatchObject({
        kind: "summary",
        outcome: "stopped",
        checkpointId: expect.any(String),
      });
      expect(readdirSync(path.join(root, "checkpoints")).length).toBeGreaterThan(0);
      expect(existsSync(path.join(root, "body", BODY_LOCK_FILENAME))).toBe(false);
    } finally {
      await control.close();
    }
  }, 30_000);

  it("marks a forced deadline, then a restarted runner reconciles the session and reclaims the dead body lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clankie-runner-forced-"));
    const interrupted = session("interrupted-session");
    const firstControl = await fakeControlPlane({ assigned: interrupted });
    try {
      const first = startRunner(root, firstControl.url, "ignore-stop", {
        CLANKIE_PLAY_SHUTDOWN_DEADLINE_MS: "50",
      });
      await vi.waitFor(
        () => expect(states(firstControl.reports, interrupted.sessionId)).toContain("running"),
        {
          timeout: 10_000,
        },
      );
      first.kill("SIGTERM");
      await expect(exitOf(first)).resolves.toMatchObject({ code: 1, signal: null });
      expect(states(firstControl.reports, interrupted.sessionId)).toEqual(["running", "stopping", "failed"]);
      expect(existsSync(path.join(root, "body", BODY_LOCK_FILENAME))).toBe(true);
    } finally {
      await firstControl.close();
    }

    const staleLive = { ...interrupted, state: "running" as const, updatedAt: now() };
    const restarted = session("restarted-session");
    const secondControl = await fakeControlPlane({ assigned: restarted, live: staleLive });
    try {
      const second = startRunner(root, secondControl.url, "shutdown-fixture");
      await vi.waitFor(
        () => {
          expect(
            secondControl.reports.find(
              (report) =>
                report.sessionId === interrupted.sessionId &&
                report.state === "failed" &&
                report.receipt?.outcome === "lease_lapsed",
            ),
          ).toBeDefined();
          expect(states(secondControl.reports, restarted.sessionId)).toContain("running");
        },
        { timeout: 10_000 },
      );
      second.kill("SIGTERM");
      await expect(exitOf(second)).resolves.toMatchObject({ code: 143, signal: null });
      expect(states(secondControl.reports, restarted.sessionId)).toEqual(["running", "stopping", "stopped"]);
      expect(existsSync(path.join(root, "body", BODY_LOCK_FILENAME))).toBe(false);
    } finally {
      await secondControl.close();
    }
  }, 30_000);
});

function session(sessionId: string): EmbodimentSession {
  return {
    schemaVersion: 1,
    sessionId,
    environmentId: "pokemon-firered",
    state: "claimed",
    intentId: `intent-${sessionId}`,
    originLane: "discord_presence",
    requestedBy: "user-1",
    budget: { maxDurationMs: 60_000 },
    requestedAt: now(),
    updatedAt: now(),
    runnerId: RUNNER_ID,
  };
}

function now(): string {
  return new Date().toISOString();
}

function states(reports: readonly EmbodimentLifecycleReport[], sessionId: string): string[] {
  return reports.filter((report) => report.sessionId === sessionId).map((report) => report.state);
}

function startRunner(
  root: string,
  controlPlaneUrl: string,
  fixture: "shutdown-fixture" | "ignore-stop",
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcess {
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const runnerEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const child = spawn(process.execPath, [tsxCli, runnerEntry], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      ...extraEnv,
      CLANKIE_CONTROL_PLANE_URL: controlPlaneUrl,
      CLANKIE_RUNNER_TOKEN: TOKEN,
      CLANKIE_RUNNER_ID: RUNNER_ID,
      CLANKIE_REPO_PATH: "",
      CLANKIE_RUNNER_STATE: path.join(root, "runner-state"),
      CLANKIE_WORKER_TRANSCRIPT_PORT: "0",
      CLANKIE_ACTIVITY_OBSERVATION_PORT: "0",
      CLANKIE_AGENT_CENSUS_PORT: "0",
      CLANKIE_GBA_BODY_ROOT: path.join(root, "body"),
      CLANKIE_GBA_CHECKPOINT_DIR: path.join(root, "checkpoints"),
      CLANKIE_GBA_PLAY_JOURNAL_DIR: path.join(root, "journals"),
      CLANKIE_RUNNER_TEST_PLAY_EXECUTION: fixture,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runningChildren.add(child);
  child.once("exit", () => runningChildren.delete(child));
  return child;
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`runner did not exit after signal:\n${output}`));
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function onlyJournal(directory: string): FreePlayJournalLine[] {
  const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return parseFreePlayJournal(readFileSync(path.join(directory, files[0]!), "utf8"));
}

async function fakeControlPlane(input: { assigned: EmbodimentSession; live?: EmbodimentSession }): Promise<{
  url: string;
  reports: EmbodimentLifecycleReport[];
  close(): Promise<void>;
}> {
  const reports: EmbodimentLifecycleReport[] = [];
  const sessions = new Map<string, EmbodimentSession>([
    [input.assigned.sessionId, input.assigned],
    ...(input.live === undefined ? [] : ([[input.live.sessionId, input.live]] as const)),
  ]);
  let assignmentAvailable = true;
  let live = input.live;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/v1/embodiment/sessions/live") {
      json(response, { session: live ?? null });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/embodiment/claims") {
      await readBody(request);
      if (!assignmentAvailable) {
        response.writeHead(204).end();
        return;
      }
      assignmentAvailable = false;
      live = input.assigned;
      json(response, { assignment: { kind: "start", session: input.assigned } });
      return;
    }
    const reportMatch = request.url?.match(/^\/v1\/embodiment\/sessions\/([^/]+)\/report$/u);
    if (request.method === "POST" && reportMatch !== null) {
      const report = JSON.parse(await readBody(request)) as EmbodimentLifecycleReport;
      reports.push(report);
      const existing = sessions.get(report.sessionId);
      if (existing === undefined) throw new Error(`unknown test session ${report.sessionId}`);
      const updated: EmbodimentSession = {
        ...existing,
        state: report.state,
        updatedAt: report.reportedAt,
        ...(report.resumedFromCheckpointId === undefined
          ? {}
          : { resumedFromCheckpointId: report.resumedFromCheckpointId }),
        ...(report.receipt?.checkpointId === undefined ? {} : { checkpointId: report.receipt.checkpointId }),
      };
      sessions.set(report.sessionId, updated);
      live =
        report.state === "stopped" || report.state === "failed" || report.state === "refused"
          ? undefined
          : updated;
      json(response, { accepted: true, session: updated });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    reports,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
