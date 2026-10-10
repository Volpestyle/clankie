import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  OperatorConversationServiceRequestSchema,
  type OperatorConversationStreamEvent,
} from "@clankie/protocol";
import { expect, it } from "vitest";
import { ownProcess } from "../../../scripts/testing/owned-process.ts";

const repo = resolve(import.meta.dirname, "../../..");
const loader = join(repo, "apps/tui/node_modules/tsx/dist/loader.mjs");
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  detail: () => string = () => "condition",
  ms = 15_000,
) {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() >= end) throw new Error(`Timed out: ${detail()}`);
    await pause(25);
  }
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 6_000);
  await exited;
  clearTimeout(timer);
}

/** Pi emits each real terminal frame inside synchronized-output markers. */
class Frames {
  readonly screens: string[][] = [];
  raw = "";
  private pending = "";
  private rows: string[] = Array.from({ length: 28 }, () => "");
  add(bytes: string) {
    this.raw += bytes;
    this.pending += bytes;
    for (;;) {
      const start = this.pending.indexOf("\x1b[?2026h");
      const end = this.pending.indexOf("\x1b[?2026l", start);
      if (start < 0 || end < 0) return;
      const frame = this.pending.slice(start + 8, end);
      this.pending = this.pending.slice(end + 8);
      if (frame.includes("\x1b[2J")) this.rows.fill("");
      // oxlint-disable-next-line no-control-regex -- actual PTY cursor-position writes
      const writes = [...frame.matchAll(/\x1b\[(\d+);(\d+)H([^]*?)(?=\x1b\[\d+;\d+H|$)/gu)];
      for (const write of writes) {
        const row = Number(write[1]) - 1;
        const text = stripTerminalSequences(write[3]!);
        if (write[3]!.includes("\x1b[2K")) this.rows[row] = text;
      }
      if (writes.length > 0) this.screens.push([...this.rows]);
    }
  }
  latest() {
    return this.screens.at(-1)?.join("\n") ?? "";
  }
}

it("opens the production console at the latest first frame, lazily anchors older pages and preserves concurrent live entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankie-tui-history-"));
  // Local evidence opts into this one read of James's real link. CI uses a sentinel.
  const link = process.env.TUI_OWNER_LINK_GUARD ?? join(dir, "owner-links/default-local.json");
  if (!process.env.TUI_OWNER_LINK_GUARD) {
    await mkdir(join(dir, "owner-links"));
    await writeFile(link, '{"owner":"unchanged"}\n');
  }
  const linkBefore = await readFile(link);
  let service: ChildProcess | undefined;
  let consoleProcess: ChildProcess | undefined;
  let serviceLog = "";
  const frames = new Frames();
  const snapshotTaken = gate(),
    releaseSnapshot = gate();
  const olderTaken = gate(),
    releaseOlder = gate();
  const requests: unknown[] = [];
  let snapshotHeld = false,
    olderHeld = false;
  const proxy = createServer();
  try {
    const home = join(dir, "home");
    const state = join(dir, "state");
    const conversation = join(state, "captain/conversations/global-default");
    await mkdir(conversation, { recursive: true });
    await mkdir(join(home, "config/clankie"), { recursive: true });
    const at = new Date().toISOString();
    await writeFile(
      join(conversation, "meta.json"),
      JSON.stringify({
        conversationId: "global-default",
        scope: { kind: "global" },
        title: "History integration",
        isDefault: true,
        createdAt: at,
        updatedAt: at,
        revision: 0,
        sessionState: "waiting",
      }),
    );
    let sequence = 0;
    const event = (
      text: string,
      role: "operator" | "captain" = "captain",
    ): Extract<OperatorConversationStreamEvent, { type: "message" }> => ({
      schemaVersion: 1,
      conversationId: "global-default",
      cursor: String(++sequence).padStart(12, "0"),
      revision: 0,
      occurredAt: at,
      type: "message",
      role,
      text,
      streaming: false,
    });
    const entries = Array.from({ length: 350 }, (_, index) =>
      event(
        Array.from({ length: 6 }, (_, row) => `history-${String(index).padStart(4, "0")} row-${row}`).join(
          "\n",
        ),
        index % 2 === 0 ? "operator" : "captain",
      ),
    );
    const journal = join(conversation, "events.jsonl");
    await writeFile(journal, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const persona = join(state, "captain/conversations/persona-history");
    await mkdir(persona, { recursive: true });
    await writeFile(
      join(persona, "meta.json"),
      JSON.stringify({
        conversationId: "persona-history",
        scope: { kind: "persona", personaId: "pip-history" },
        title: "Pip history",
        isDefault: false,
        createdAt: at,
        updatedAt: at,
        revision: 0,
        sessionState: "waiting",
      }),
    );
    await writeFile(
      join(persona, "events.jsonl"),
      entries
        .map((entry) =>
          JSON.stringify({
            ...entry,
            conversationId: "persona-history",
            text: entry.text.replaceAll("history-", "persona-"),
          }),
        )
        .join("\n") + "\n",
    );
    const publish = async (text: string) => appendFile(journal, `${JSON.stringify(event(text))}\n`);
    const settings = join(dir, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        schemaVersion: 1,
        herdr: { runtime: "disabled" },
        captain: { workingDirectory: dir },
      }),
    );
    // Allocate a real ephemeral loopback port, then boot the production composition root.
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No loopback port");
    await new Promise<void>((done) => reservation.close(() => done()));
    const host = `http://127.0.0.1:${address.port}`;
    // Allowlist: no inherited CLANKIE_*, fleet, model credentials or harness homes.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      PI_CODING_AGENT_DIR: join(home, "pi"),
      CI: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
      CLANKIE_STATE: state,
      CLANKIE_STATE_HOME: join(home, "state"),
      CLANKIE_INSTALL_ROOT: repo,
      CLANKIE_SETTINGS_FILE: settings,
      CLANKIE_CREDENTIALS_FILE: join(dir, "credentials.json"),
      CLANKIE_OPERATOR_TOKEN: "history-private-operator",
      CLANKIE_CAPTAIN_TOKEN: "history-private-captain",
      CLANKIE_BROWSER_ENABLED: "false",
      CLANKIE_RELAY_PORT: "0",
      CLANKIE_HEADER: "0",
      PORT: String(address.port),
      CLANKIE_CONTROL_PLANE_URL: host,
    };
    await writeFile(
      join(home, "config/clankie/clankie.json"),
      JSON.stringify({
        model: "private/transcript",
        provider: { private: { options: { baseURL: host } } },
      }),
    );
    service = spawn(process.execPath, ["--import", loader, join(repo, "apps/clankie/src/index.ts")], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A bailed or timed-out fork skips `finally`; its exit still stops the service (VUH-2027).
    ownProcess(service);
    service.stdout?.on("data", (chunk) => {
      serviceLog += String(chunk);
    });
    service.stderr?.on("data", (chunk) => {
      serviceLog += String(chunk);
    });
    let healthy = false;
    const deadline = Date.now() + 30_000;
    while (!healthy && Date.now() < deadline) {
      if (service.exitCode !== null) throw new Error(`Host exited: ${serviceLog}`);
      healthy = await fetch(`${host}/health`)
        .then((response) => response.ok)
        .catch(() => false);
      if (!healthy) await pause(100);
    }
    expect(healthy, serviceLog).toBe(true);

    // Delay real HTTP responses; producer, auth, schemas and transcript remain production code.
    proxy.on("request", async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        let body = Buffer.concat(chunks).toString();
        const operation =
          request.url === "/operator/v1/dispatch"
            ? OperatorConversationServiceRequestSchema.parse(JSON.parse(body))
            : undefined;
        if (operation) requests.push(operation);
        if (operation?.op === "tail") {
          // Shorten the actual supported long-poll interval for externally appended journal rows.
          operation.tail.waitMs = 50;
          body = JSON.stringify(operation);
        }
        const upstream = await fetch(`${host}${request.url}`, {
          method: request.method ?? "GET",
          headers: { "content-type": "application/json", authorization: request.headers.authorization ?? "" },
          ...(body ? { body } : {}),
        });
        const bytes = await upstream.text();
        if (operation?.op === "replay" && !snapshotHeld) {
          snapshotHeld = true;
          snapshotTaken.release();
          await releaseSnapshot.promise;
        } else if (
          operation?.op === "replay" &&
          operation.replay.direction === "backward" &&
          operation.replay.cursor &&
          !olderHeld
        ) {
          olderHeld = true;
          olderTaken.release();
          await releaseOlder.promise;
        }
        if (!response.destroyed) {
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(bytes);
        }
      } catch (error) {
        if (!response.destroyed) {
          response.writeHead(500);
          response.end(String(error));
        }
      }
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("No proxy port");
    const startConsole = () => {
      const child = spawn(
        "python3",
        [
          join(import.meta.dirname, "fixtures/conversation-pty.py"),
          process.execPath,
          "--import",
          loader,
          join(repo, "apps/tui/src/index.ts"),
        ],
        {
          cwd: repo,
          env: { ...env, CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${proxyAddress.port}` },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      ownProcess(child);
      let pending = "";
      const decoder = new StringDecoder("utf8");
      child.stdout?.on("data", (chunk) => {
        pending += String(chunk);
        for (;;) {
          const end = pending.indexOf("\n");
          if (end < 0) break;
          const line = JSON.parse(pending.slice(0, end)) as { data: string };
          pending = pending.slice(end + 1);
          frames.add(decoder.write(Buffer.from(line.data, "base64")));
        }
      });
      child.stderr?.on("data", (chunk) => {
        serviceLog += String(chunk);
      });
      return child;
    };
    consoleProcess = startConsole();
    await Promise.race([
      snapshotTaken.promise,
      until(
        () => snapshotHeld,
        () => serviceLog + frames.raw,
      ),
    ]);
    expect(frames.screens).toHaveLength(0); // No partial history frame while hydration is pending.
    await publish("live-during-open-A");
    releaseSnapshot.release();
    await until(
      () => frames.screens.length > 0,
      () => frames.raw + serviceLog,
    );
    // The console opens on a blank page; restored history waits above it.
    expect(frames.screens[0]!.join("\n")).toContain("↑ scroll up for earlier messages");
    expect(frames.screens[0]!.join("\n")).not.toContain("history-0349");
    await until(
      () => frames.latest().includes("live-during-open-A"),
      () => frames.latest(),
    );
    const backwardRequests = () =>
      requests.filter((item) => {
        const op = OperatorConversationServiceRequestSchema.parse(item);
        return op.op === "replay" && op.replay.direction === "backward";
      });
    expect(backwardRequests()).toHaveLength(1); // Older history was not fetched during startup.
    const input = (text: string) => consoleProcess?.stdin?.write(`${JSON.stringify({ input: text })}\n`);
    input("\x1b[H");
    await Promise.race([
      olderTaken.promise,
      until(
        () => olderHeld,
        () => frames.latest(),
      ),
    ]);
    await until(
      () => frames.latest().includes("history-0330"),
      () => frames.latest(),
    );
    const visibleContent = () =>
      frames.screens
        .at(-1)!
        .slice(0, 12)
        .map((row) => row.replace(/[│┃]$/u, "").trimEnd());
    const anchor = visibleContent();
    input("\x1b[H"); // Repeated scrolls while loading share one backward request.
    await publish("live-during-backfill-B");
    await publish("live-during-backfill-C");
    const tailState = join(home, "state/clankie/tui/operator-conversation-tail.json");
    const cursor = async () => {
      const saved = JSON.parse(await readFile(tailState, "utf8")) as {
        cursors: Array<{ conversationId: string; cursor: string }>;
      };
      return saved.cursors.find((item) => item.conversationId === "global-default")?.cursor;
    };
    // Persistence proves the actual consumer applied B/C before backfill is released.
    await until(async () => (await cursor()) === "000000000353");
    releaseOlder.release();
    await until(() => backwardRequests().length >= 2);
    await pause(200);
    expect(backwardRequests()).toHaveLength(2);
    expect(visibleContent()).toEqual(anchor);
    input("\x1b[5~");
    await until(
      () => frames.latest().includes("history-0328"),
      () => frames.latest(),
    );
    input("\x1b[F");
    await until(
      () => frames.latest().includes("live-during-backfill-C"),
      () => frames.latest(),
    );
    const bottom = frames.latest();
    expect(bottom.indexOf("live-during-open-A")).toBeLessThan(bottom.indexOf("live-during-backfill-B"));
    expect(bottom.indexOf("live-during-backfill-B")).toBeLessThan(bottom.indexOf("live-during-backfill-C"));
    for (const marker of ["live-during-open-A", "live-during-backfill-B", "live-during-backfill-C"])
      expect(bottom.split(marker)).toHaveLength(2);
    // Traverse every remaining page to the retained origin with real scroll input.
    for (let page = 0; page < 20 && !frames.latest().includes("history-0000"); page += 1) {
      const count = backwardRequests().length;
      input("\x1b[H");
      await until(() => backwardRequests().length > count || frames.latest().includes("history-0000"));
      await pause(100);
    }
    input("\x1b[H");
    await until(
      () => frames.latest().includes("history-0000"),
      () => frames.latest(),
    );
    expect(await cursor()).toBe("000000000353"); // Backfill never rewinds the applied live cursor.
    // Persona selection and returning to its parent use the same production selection path.
    const personaStart = frames.screens.length;
    input("\x1b[200~/history persona-history\x1b[201~");
    await until(
      () => frames.latest().includes("/history persona-history"),
      () => frames.latest(),
    );
    input("\r");
    await until(
      () => frames.latest().includes("persona-0349 row-5"),
      () => frames.latest(),
    );
    const personaFirst = frames.screens
      .slice(personaStart)
      .find((screen) => /persona-\d{4} row-/u.test(screen.join("\n")));
    expect(personaFirst?.join("\n")).toContain("persona-0349 row-5");
    expect(personaFirst?.join("\n")).not.toContain("persona-0000");
    const parentStart = frames.screens.length;
    input("\x1b[200~/history global-default\x1b[201~");
    await until(
      () => frames.latest().includes("/history global-default"),
      () => frames.latest(),
    );
    input("\r");
    await until(
      () => frames.latest().includes("live-during-backfill-C"),
      () => frames.latest(),
    );
    const parentFirst = frames.screens
      .slice(parentStart)
      .find(
        (screen) =>
          screen.join("\n").includes("live-during-backfill-C") || screen.join("\n").includes("history-"),
      );
    expect(parentFirst?.join("\n")).toContain("live-during-backfill-C");
    await stop(consoleProcess);
    consoleProcess = undefined;
    const resumedAt = frames.screens.length;
    consoleProcess = startConsole();
    await until(
      () => frames.screens.length > resumedAt,
      () => frames.raw + serviceLog,
    );
    // A reopened console starts on a blank page again; the last message waits just above it.
    expect(frames.screens[resumedAt]!.join("\n")).toContain("↑ scroll up for earlier messages");
    expect(frames.screens[resumedAt]!.join("\n")).not.toContain("live-during-backfill-C");
    input("\x1b[5~");
    await until(
      () => frames.latest().includes("live-during-backfill-C"),
      () => frames.latest(),
    );
    expect(await readFile(link)).toEqual(linkBefore);
  } finally {
    releaseSnapshot.release();
    releaseOlder.release();
    await stop(consoleProcess);
    await stop(service);
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
    expect(await readFile(link)).toEqual(linkBefore);
    if (process.env.TUI_HISTORY_EVIDENCE_DIR) {
      const evidence = process.env.TUI_HISTORY_EVIDENCE_DIR;
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, "frames.json"), JSON.stringify(frames.screens, null, 2));
      await writeFile(join(evidence, "terminal.ansi"), frames.raw);
      await writeFile(join(evidence, "requests.json"), JSON.stringify(requests, null, 2));
      await writeFile(join(evidence, "service.log"), serviceLog);
      await writeFile(join(evidence, "first-frame.txt"), frames.screens[0]?.join("\n") ?? "");
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);
