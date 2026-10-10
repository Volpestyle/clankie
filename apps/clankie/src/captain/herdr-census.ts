import { nativeHerdrRead } from "../herdr-native-read.ts";
import { inspectLiveHarnessBridges } from "../../../../integrations/claude-plugin/worker/bin/harness-live.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  OPERATOR_HEAD_AGENT_NAME,
  type OperatorHerdrPlacement,
  type OperatorFleetSeat,
  type OperatorTerminalSession,
} from "@clankie/protocol";
import { readHerdrSummariesFile, type HerdrAgentSummary } from "./herdr-summaries.ts";
import { readLocalCodexRecords, isLocalCodexEndpoint } from "../local-codex-records.ts";
import { CodexAppServerClient, openCodexSocket } from "./codex-app-server.ts";
import { observeNativeProcesses, observeCodexServer, nativeProcessReceipt } from "../local-fleet-process.ts";
import { nativeRequest } from "../herdr-native-request.ts";

const execFileAsync = promisify(execFile);

export type HerdrCensusRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface HerdrCensusAgent {
  readonly paneId: string;
  /** Stable operator-assigned identity for a managed agent. */
  readonly name?: string;
  readonly agent: string;
  readonly status: string;
  readonly title: string;
  /** Stable terminal address for this pane; not the occupying agent's identity. */
  readonly terminalId?: string;
  /** Pane that ran `agent start` for this agent, when Herdr recorded one. */
  readonly parentPaneId?: string;
  /** Absolute path the agent runs in; the commons district key (ADR 0022). */
  readonly cwd?: string;
  /** Harness-native session identity, independent of the pane holding it. */
  readonly session?: { readonly source: string; readonly kind: "id" | "path"; readonly value: string };
}

/** A remote Herdr fleet the census also reads (ADR 0184); `run` executes one herdr argv there. */
export interface HerdrCensusFleet {
  readonly id: string;
  readonly session: string;
  readonly host: string;
  run(args: readonly string[]): Promise<string>;
}

/** Remote ids carry their fleet, so every tool that takes one routes back to it. */
function qualifyAgent(fleet: string, entry: HerdrCensusAgent): HerdrCensusAgent {
  return {
    ...entry,
    paneId: `${fleet}/${entry.paneId}`,
    ...(entry.terminalId === undefined ? {} : { terminalId: `${fleet}/${entry.terminalId}` }),
    ...(entry.parentPaneId === undefined ? {} : { parentPaneId: `${fleet}/${entry.parentPaneId}` }),
  };
}

type RemoteFleetAgents =
  | { readonly fleet: HerdrCensusFleet; readonly agents: readonly HerdrCensusAgent[] }
  | { readonly fleet: HerdrCensusFleet; readonly error: string };

/** Each fleet answers or is unreachable on its own; one down machine hides nobody else (ADR 0184). */
async function readRemoteFleets(fleets: readonly HerdrCensusFleet[]): Promise<readonly RemoteFleetAgents[]> {
  return Promise.all(
    fleets.map(async (fleet): Promise<RemoteFleetAgents> => {
      try {
        const agents = parseHerdrAgentList(await fleet.run(["agent", "list"]));
        return { fleet, agents: agents.map((entry) => qualifyAgent(fleet.id, entry)) };
      } catch (caught) {
        return { fleet, error: caught instanceof Error ? caught.message : String(caught) };
      }
    }),
  );
}

function formatRemoteFleet(remote: RemoteFleetAgents): string {
  const heading = `HERDR FLEET ${remote.fleet.id} (ssh ${remote.fleet.host}, session ${remote.fleet.session}; ids carry the ${remote.fleet.id}/ prefix)`;
  if ("error" in remote)
    return `${heading}
  unreachable: ${bounded(remote.error, 200)}`;
  return formatHerdrSessionCensus(undefined, remote.agents).replace(/^[^\n]*/u, heading);
}

export type HerdrSessionCensus =
  | { readonly outcome: "ok"; readonly text: string }
  | { readonly outcome: "unavailable"; readonly error: string };

const CENSUS_TIMEOUT_MS = 5_000;
const SEAT_DIRECTORY_MAX = 1_024;
const MAX_AGENTS = 48;

export function occupantIdForHerdrSession(session: {
  readonly source: string;
  readonly kind: "id" | "path";
  readonly value: string;
}): string {
  const digest = createHash("sha256")
    .update(session.source)
    .update("\0")
    .update(session.kind)
    .update("\0")
    .update(session.value)
    .digest("hex");
  return `session-${digest}`;
}

/** Stable fallback identity for an unnamed agent while its Herdr pane exists. */
function subjectForHerdrPane(paneId: string): string {
  return `adhoc-${createHash("sha256").update(paneId).digest("hex").slice(0, 20)}`;
}

/**
 * A binding subject for a name Herdr accepted. Herdr names are free-form, and a
 * subject is a persisted key, so an operator typing `herdr agent rename p1 Atlas`
 * must not write a record the store can never read back. The slug is
 * deterministic — the same name always recovers the same character — and a name
 * with nothing to slug leaves the seat on its pane-derived subject.
 */
export function subjectForHerdrName(name: string, fleet?: string): string | undefined {
  const slug = (fleet === undefined ? name : `${fleet}-${name}`)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 32);
  return slug.length === 0 ? undefined : slug;
}

export interface ObservedFleetSeat {
  readonly harnessBridge?: OperatorFleetSeat["harnessBridge"];
  readonly account?: { label: string; home: string };
  readonly seatId: string;
  /**
   * The Herdr pane holding this seat, and the pane that started it. Herdr keys
   * its agent edges by pane, seats are keyed by terminal, and these two fields
   * are the join between them. They stay internal to the captain: the wire
   * carries seat ids only.
   */
  readonly paneId: string;
  readonly parentPaneId?: string;
  /** Managed-agent name, or pane-derived fallback, used to recover the persona binding. */
  readonly subject: string;
  /**
   * Set once Herdr has named this seat: the operator's chosen name and the
   * pane-derived subject the character was filed under before it. Naming an
   * agent re-keys a character the operator may already be talking to; without
   * the old key the rename would strand that persona and mint a stranger.
   */
  readonly renamed?: { readonly name: string; readonly from: string };
  readonly occupantId: string;
  readonly harness: string;
  readonly status: string;
  readonly title: string;
  readonly summary?: string;
  readonly next?: string;
  readonly workingDirectory?: string;
  /** Herdr's workspace and tab for this seat's terminal, when the snapshot answered. */
  readonly placement?: OperatorHerdrPlacement;
  /** The registered remote fleet (machine) holding this seat; absent on the local fleet (ADR 0184). */
  readonly fleet?: string;
  readonly machine?: string;
  readonly herdrSession?: string;
  /**
   * The observed harness session, so a seat the host already has an address for
   * can read its own transcript (ADR 0188). Internal like the pane ids; the
   * wire never carries it. Remote reads use the registered fleet transport.
   */
  readonly session?: { readonly source: string; readonly kind: "id" | "path"; readonly value: string };
}

function defaultRunner(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, [...args], { env, timeout: CENSUS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }),
  );
}

export interface LocalCodexRecoveryOptions {
  readonly runCommand?: HerdrCensusRunner;
  readonly localCodexRecordsPath?: string;
  readonly bridgeSocket?: string;
  readonly herdrSession?: string;
  /** Trusted observer selects native guards when it supplies its own Herdr transport. */
  readonly nativeProof?: true;
  readonly signal?: AbortSignal;
}

/**
 * A resumed private TUI need not emit Herdr's SessionStart hook. Recover only
 * the exact controller-created server lifetime and thread named by native argv.
 * No label, terminal title, or stale launch record is enough.
 */
export async function recoverLocalCodexSession(
  entry: Pick<HerdrCensusAgent, "paneId" | "agent" | "session">,
  options: LocalCodexRecoveryOptions = {},
): Promise<HerdrCensusAgent["session"]> {
  options.signal?.throwIfAborted();
  if (entry.agent !== "codex" || entry.session !== undefined) return entry.session;
  const socket =
    options.bridgeSocket ?? process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock");
  const session = options.herdrSession ?? "default";
  const records = readLocalCodexRecords(options.localCodexRecordsPath).filter(
    (record) =>
      record.pane === entry.paneId &&
      record.binding.socketPath === socket &&
      record.binding.session === session,
  );
  if (records.length === 0) return undefined;
  const run = options.runCommand ?? defaultRunner;
  const nativeProof =
    options.nativeProof ||
    (process.platform === "darwin" &&
      (options.runCommand === undefined ||
        options.runCommand === defaultRunner ||
        records.some((record) => /^\d+\.\d{6}$/u.test(record.start))));
  try {
    const observePane = async () => {
      options.signal?.throwIfAborted();
      const response =
        options.runCommand === undefined && nativeProof
          ? JSON.stringify(
              await nativeRequest(
                { runtime: "external", socketPath: socket, session },
                "pane.process_info",
                { pane_id: entry.paneId },
                { timeoutMs: 2_000, ...(options.signal ? { signal: options.signal } : {}) },
              ),
            )
          : (await run("herdr", ["pane", "process-info", "--pane", entry.paneId])).stdout;
      options.signal?.throwIfAborted();
      const value = JSON.parse(response)?.result?.process_info;
      if (value?.pane_id !== entry.paneId || value.foreground_process_group_id === value.shell_pid)
        throw new Error("No native foreground occupant");
      const processes: unknown[] = Array.isArray(value.foreground_processes)
        ? value.foreground_processes
        : [];
      const native = processes.filter((item) => {
        const process = item as { pid?: unknown; argv?: unknown };
        return (
          Number.isSafeInteger(process?.pid) &&
          Number(process.pid) > 1 &&
          Array.isArray(process.argv) &&
          process.argv.every((arg) => typeof arg === "string") &&
          basename(process.argv[0] ?? "") === "codex"
        );
      });
      if (native.length !== 1) throw new Error("Ambiguous native occupant");
      const process = native[0] as { pid: number; argv: string[] };
      const remote = process.argv.indexOf("--remote");
      const resume = process.argv.indexOf("resume");
      const endpoint = remote < 0 ? undefined : process.argv[remote + 1];
      const threadId = resume < 0 ? undefined : process.argv[resume + 1];
      if (!endpoint || !isLocalCodexEndpoint(endpoint) || !threadId || threadId.startsWith("-"))
        throw new Error("Exact remote resume address unavailable");
      return {
        pid: process.pid,
        endpoint,
        threadId,
        shell: value.shell_pid,
        foreground: value.foreground_process_group_id,
      };
    };
    const native = await observePane();
    const recovered = { source: "herdr:codex", kind: "id" as const, value: native.threadId };
    const occupantId = occupantIdForHerdrSession(recovered);
    const matching = records.filter(
      (record) =>
        record.nativeOccupantId === occupantId &&
        (record.threadId === undefined || record.threadId === native.threadId) &&
        (record.endpoint === undefined || record.endpoint === native.endpoint),
    );
    if (matching.length !== 1) return undefined;
    const launch = matching[0]!;
    const lifetime = async (pid: number) => {
      options.signal?.throwIfAborted();
      if (nativeProof) {
        const observed = (
          await observeNativeProcesses(process.pid, pid, undefined, undefined, options.signal)
        )?.processes[1];
        options.signal?.throwIfAborted();
        if (!observed || basename(observed.executable) !== "codex")
          throw new Error("Native process lifetime unavailable");
        return nativeProcessReceipt(observed.birth, pid === launch.pid ? launch.start : undefined);
      }
      const output = (await run("/bin/ps", ["-p", String(pid), "-o", "lstart=,comm="])).stdout;
      options.signal?.throwIfAborted();
      const match =
        /^\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(
          output,
        );
      if (!match || basename(match[2]!) !== "codex") throw new Error("Native process lifetime unavailable");
      return match[1]!;
    };
    const serverProof = async () => {
      options.signal?.throwIfAborted();
      if (nativeProof) {
        const canonicalSocketPath = await realpath(native.endpoint.slice("unix://".length));
        options.signal?.throwIfAborted();
        const birth = await observeCodexServer(
          launch.pid,
          native.endpoint,
          canonicalSocketPath,
          options.signal,
        );
        options.signal?.throwIfAborted();
        if (!birth || nativeProcessReceipt(birth, launch.start) !== launch.start)
          throw new Error("Private server identity unavailable");
        return;
      }
      if ((await lifetime(launch.pid)) !== launch.start) throw new Error("Private server lifetime changed");
      const command = (await run("/bin/ps", ["-p", String(launch.pid), "-o", "command="])).stdout.trim();
      options.signal?.throwIfAborted();
      if (!command.endsWith(` app-server --listen ${native.endpoint}`))
        throw new Error("Private server address changed");
      const sockets = (await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(launch.pid), "-U", "-Fn"]))
        .stdout;
      // Codex 0.160 aliases --listen paths to its private daemon socket directory.
      const socketPath = await realpath(native.endpoint.slice("unix://".length));
      if (!sockets.split("\n").some((line) => line === `n${socketPath}`))
        throw new Error("Private server does not own its socket");
    };
    const started = await lifetime(native.pid);
    await serverProof();
    // argv identifies the requested resume. The live server must still have
    // exactly that native thread loaded; a later /new or /resume cannot reuse
    // the old process command as authority for its previous occupant.
    options.signal?.throwIfAborted();
    const codexSocket = await openCodexSocket(`ws+unix://${native.endpoint.slice("unix://".length)}:/`);
    if (!codexSocket) return undefined;
    const client = new CodexAppServerClient(codexSocket, () => {}, 2_000);
    const abort = () => {
      client.close();
      // This read-only proof owns its socket; do not await a broken peer's close handshake.
      codexSocket.terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      options.signal?.throwIfAborted();
      await client.initialize();
      options.signal?.throwIfAborted();
      const loaded = (await client.request("thread/loaded/list", {})) as {
        data?: unknown;
        nextCursor?: unknown;
      };
      options.signal?.throwIfAborted();
      if (
        !Array.isArray(loaded.data) ||
        loaded.data.length === 0 ||
        loaded.data.length > MAX_AGENTS ||
        !loaded.data.every((id) => typeof id === "string") ||
        !loaded.data.includes(native.threadId) ||
        loaded.nextCursor != null
      )
        return undefined;
      // Native parallel workers may remain loaded. They must be descendants of
      // this root; a second independent root makes the pane's selection ambiguous.
      const parents = new Map<string, string>();
      for (const id of loaded.data) {
        options.signal?.throwIfAborted();
        if (id === native.threadId) continue;
        const response = (await client.request("thread/read", { threadId: id, includeTurns: false })) as {
          thread?: { id?: unknown; parentThreadId?: unknown };
        };
        if (response.thread?.id !== id || typeof response.thread.parentThreadId !== "string")
          return undefined;
        parents.set(id, response.thread.parentThreadId);
      }
      for (const id of parents.keys()) {
        let current = id;
        const seen = new Set<string>();
        while (current !== native.threadId) {
          if (seen.has(current) || !parents.has(current)) return undefined;
          seen.add(current);
          current = parents.get(current)!;
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      client.close();
    }
    options.signal?.throwIfAborted();
    if (
      JSON.stringify(await observePane()) !== JSON.stringify(native) ||
      (await lifetime(native.pid)) !== started
    )
      return undefined;
    await serverProof();
    options.signal?.throwIfAborted();
    // Revocation/replacement during the observation cannot resurrect a record.
    if (
      !readLocalCodexRecords(options.localCodexRecordsPath).some(
        (record) => JSON.stringify(record) === JSON.stringify(launch),
      )
    )
      return undefined;
    return recovered;
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }
}

/** Restore only a recorded native launcher that still occupies the same seat. */
export async function recoverLocalCodexParent(
  entry: Pick<HerdrCensusAgent, "paneId" | "agent" | "session" | "parentPaneId">,
  options: LocalCodexRecoveryOptions = {},
): Promise<string | undefined> {
  if (entry.parentPaneId !== undefined || entry.agent !== "codex" || entry.session === undefined)
    return entry.parentPaneId;
  const bindingSocket =
    options.bridgeSocket ?? process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock");
  const records = readLocalCodexRecords(options.localCodexRecordsPath).filter(
    (record) =>
      record.pane === entry.paneId &&
      record.binding.socketPath === bindingSocket &&
      record.binding.session === (options.herdrSession ?? "default") &&
      record.nativeOccupantId === occupantIdForHerdrSession(entry.session!) &&
      record.parent !== undefined,
  );
  if (records.length !== 1) return undefined;
  const launch = records[0]!;
  const parent = launch.parent!;
  const run = options.runCommand ?? defaultRunner;
  const observe = async () => {
    const result = JSON.parse((await run("herdr", ["agent", "get", parent.paneId])).stdout)?.result?.agent;
    const native = parseHerdrAgentList(JSON.stringify({ result: { agents: [result] } }))[0];
    if (native?.paneId !== parent.paneId) return undefined;
    const session = native.session ?? (await recoverLocalCodexSession(native, options));
    return session === undefined ? undefined : occupantIdForHerdrSession(session);
  };
  try {
    if ((await observe()) !== parent.occupantId || (await observe()) !== parent.occupantId) return undefined;
    return readLocalCodexRecords(options.localCodexRecordsPath).some(
      (record) => JSON.stringify(record) === JSON.stringify(launch),
    )
      ? parent.paneId
      : undefined;
  } catch {
    return undefined;
  }
}

function titleOf(pane: Record<string, unknown>): string {
  for (const key of ["title", "terminal_title_stripped", "terminal_title"] as const) {
    const value = pane[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

export function parseHerdrAgentList(stdout: string): HerdrCensusAgent[] {
  const parsed = JSON.parse(stdout) as { result?: { agents?: unknown } };
  const rows = Array.isArray(parsed.result?.agents) ? parsed.result.agents : [];
  const agents: HerdrCensusAgent[] = [];
  for (const value of rows) {
    if (value === null || typeof value !== "object") continue;
    const pane = value as Record<string, unknown>;
    const paneId = typeof pane.pane_id === "string" ? pane.pane_id : undefined;
    const agent = typeof pane.agent === "string" ? pane.agent : undefined;
    if (paneId === undefined || agent === undefined) continue;
    const rawSession = pane.agent_session;
    const session =
      rawSession !== null && typeof rawSession === "object"
        ? (rawSession as Record<string, unknown>)
        : undefined;
    agents.push({
      paneId,
      ...(typeof pane.name === "string" && pane.name.length > 0 ? { name: pane.name } : {}),
      agent,
      status: typeof pane.agent_status === "string" ? pane.agent_status : "unknown",
      title: titleOf(pane),
      ...(typeof pane.terminal_id === "string" && pane.terminal_id.length > 0
        ? { terminalId: pane.terminal_id }
        : {}),
      ...(typeof pane.parent_pane_id === "string" && pane.parent_pane_id.length > 0
        ? { parentPaneId: pane.parent_pane_id }
        : {}),
      ...(typeof pane.cwd === "string" && pane.cwd.length > 0 ? { cwd: pane.cwd } : {}),
      ...(typeof session?.source === "string" &&
      (session.kind === "id" || session.kind === "path") &&
      typeof session.value === "string" &&
      session.source.length > 0 &&
      session.value.length > 0
        ? { session: { source: session.source, kind: session.kind, value: session.value } }
        : {}),
    });
  }
  return agents;
}

/**
 * A pane's own terminal grid in cells. A native surface renders the pane into a
 * viewport of its own size; without the real grid it can only crop, which is
 * what truncates wide agent output on a phone.
 */
export interface HerdrPaneGrid {
  readonly paneId?: string;
  readonly columns: number;
  readonly rows: number;
}

/**
 * The grid a terminal is actually running at. Undefined for an unknown terminal,
 * a down socket, or malformed vanilla Herdr output — callers keep their own
 * fallback rather than guessing a width. `pane layout` reports the pane's
 * content rectangle in cells; its height matches `scroll.viewport_rows`.
 */
export async function readTerminalGrid(
  terminalId: string,
  options: { readonly runCommand?: HerdrCensusRunner; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<HerdrPaneGrid | undefined> {
  const run = options.runCommand ?? ((command, args) => defaultRunner(command, args, options.env));
  try {
    const listed = JSON.parse((await run("herdr", ["pane", "list"])).stdout) as {
      result?: { panes?: unknown };
    };
    const pane = (Array.isArray(listed.result?.panes) ? listed.result.panes : []).find(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        (value as Record<string, unknown>).terminal_id === terminalId,
    ) as Record<string, unknown> | undefined;
    const paneId = pane?.pane_id;
    if (typeof paneId !== "string") return undefined;

    const laidOut = JSON.parse((await run("herdr", ["pane", "layout", "--pane", paneId])).stdout) as {
      result?: { layout?: { panes?: unknown } };
    };
    const layoutPane = (Array.isArray(laidOut.result?.layout?.panes) ? laidOut.result.layout.panes : []).find(
      (value) =>
        value !== null && typeof value === "object" && (value as Record<string, unknown>).pane_id === paneId,
    ) as Record<string, unknown> | undefined;
    const rect = layoutPane?.rect;
    if (rect === null || typeof rect !== "object") return undefined;
    const { width, height } = rect as Record<string, unknown>;
    if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
    if ((width as number) <= 0 || (height as number) <= 0) return undefined;
    return { paneId, columns: width as number, rows: height as number };
  } catch {
    return undefined;
  }
}

export function formatHerdrSessionCensus(
  herdrPaneId: string | undefined,
  agents: readonly HerdrCensusAgent[],
  summaries: Readonly<Record<string, HerdrAgentSummary>> = {},
): string {
  const counts = new Map<string, number>();
  const lines = [
    herdrPaneId === undefined
      ? "HERDR SESSION (led from the service — no pane is you)"
      : `HERDR SESSION (joined as ${herdrPaneId})`,
  ];
  const shown = agents.slice(0, MAX_AGENTS);
  for (const entry of shown) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    const mark = entry.paneId === herdrPaneId ? "  <- YOU" : "";
    const title = entry.title.length <= 60 ? entry.title : `${entry.title.slice(0, 59)}…`;
    lines.push(`  ${entry.paneId}  ${entry.agent}  ${entry.status}  ${title}${mark}`);
    const written = summaries[entry.paneId];
    if (written) {
      lines.push(`        summary: ${written.summary}`);
      if (written.next) lines.push(`        next: ${written.next}`);
    }
  }
  if (agents.length > shown.length) lines.push(`  … ${agents.length - shown.length} more agents not listed`);
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  lines.push(`  ${agents.length} agents${summary.length === 0 ? "" : ` — ${summary}`}`);
  const done = counts.get("done") ?? 0;
  const blocked = counts.get("blocked") ?? 0;
  if (done > 0) lines.push(`  ${done} done — finished work nobody has read. Harvest first.`);
  if (blocked > 0) lines.push(`  ${blocked} blocked — waiting on a human. Surface those before dispatching.`);
  return lines.join("\n");
}

/** Matches the protocol's OPERATOR_CONVERSATION_SUMMARY_MAX bound. */
const SEAT_SUMMARY_MAX = 512;

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function recordMap(values: unknown, idKey: string): Map<string, Record<string, unknown>> {
  if (!Array.isArray(values)) return new Map();
  return new Map(
    values.flatMap((value) => {
      if (value === null || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const id = record[idKey];
      return typeof id === "string" ? [[id, record] as const] : [];
    }),
  );
}

/** Projects one Herdr API snapshot without flattening its workspace hierarchy. */
export function parseHerdrTerminalCatalog(stdout: string): OperatorTerminalSession[] {
  const parsed = JSON.parse(stdout) as { result?: { snapshot?: Record<string, unknown> } };
  const snapshot = parsed.result?.snapshot;
  if (!snapshot) return [];
  const workspaces = recordMap(snapshot.workspaces, "workspace_id");
  const tabs = recordMap(snapshot.tabs, "tab_id");
  const panes = Array.isArray(snapshot.panes)
    ? snapshot.panes
    : Array.isArray(snapshot.agents)
      ? snapshot.agents
      : [];

  return panes.flatMap((value): OperatorTerminalSession[] => {
    if (value === null || typeof value !== "object") return [];
    const pane = value as Record<string, unknown>;
    const terminalId = pane.terminal_id;
    const workspaceId = pane.workspace_id;
    const tabId = pane.tab_id;
    const paneId = pane.pane_id;
    if (
      typeof terminalId !== "string" ||
      typeof workspaceId !== "string" ||
      typeof tabId !== "string" ||
      typeof paneId !== "string"
    )
      return [];
    const workspace = workspaces.get(workspaceId);
    const tab = tabs.get(tabId);
    if (
      typeof workspace?.label !== "string" ||
      typeof workspace.number !== "number" ||
      typeof tab?.label !== "string" ||
      typeof tab.number !== "number"
    )
      return [];
    // Herdr names the harness only where one is seated; older builds spell a
    // plain shell out as "shell" instead of omitting the field.
    const agent = typeof pane.agent === "string" ? pane.agent.trim() : "";
    return [
      {
        terminalId,
        label: bounded(titleOf(pane), 200),
        workspace: { id: workspaceId, label: bounded(workspace.label, 200), number: workspace.number },
        tab: { id: tabId, label: bounded(tab.label, 200), number: tab.number },
        pane: { id: paneId },
        ...(agent === "" || agent === "shell" ? {} : { agent: bounded(agent, 128) }),
      },
    ];
  });
}

/** Bounded observable terminal catalog, in Herdr's native workspace/tab/pane order. */
export async function readTerminalCatalog(
  options: { readonly runCommand?: HerdrCensusRunner; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<OperatorTerminalSession[]> {
  const run = options.runCommand ?? ((command, args) => defaultRunner(command, args, options.env));
  try {
    const { stdout } = await run("herdr", ["api", "snapshot"]);
    return parseHerdrTerminalCatalog(stdout).slice(0, MAX_AGENTS);
  } catch {
    return [];
  }
}

/**
 * Which seat a Herdr pane is, for a caller that can only name the pane it sits
 * in (ADR 0148). This lookup is what makes an agent-reachable op safe: the seat
 * comes from the live census rather than from the caller's word, so a pane can
 * only ever resolve to itself. Undefined for a shell pane, an unknown pane, or
 * a down socket.
 */
export async function readSeatIdForHerdrPane(
  herdrPaneId: string,
  options: { readonly runCommand?: HerdrCensusRunner } = {},
): Promise<string | undefined> {
  const run = options.runCommand ?? defaultRunner;
  try {
    const { stdout } = await run("herdr", ["agent", "list"]);
    return parseHerdrAgentList(stdout).find((entry) => entry.paneId === herdrPaneId)?.terminalId;
  } catch {
    return undefined;
  }
}

/**
 * The argv of a local pane's foreground processes, as Herdr observes them, so
 * the flags a seat actually launched with can be read. Undefined when Herdr
 * cannot answer.
 */
export async function readPaneForegroundArgv(
  paneId: string,
  options: {
    readonly runCommand?: HerdrCensusRunner;
    readonly herdrSession?: string;
    readonly bridgeSocket?: string;
  } = {},
): Promise<readonly (readonly string[])[] | undefined> {
  try {
    const response =
      options.runCommand === undefined && options.bridgeSocket
        ? await nativeRequest(
            {
              runtime: "external",
              socketPath: options.bridgeSocket,
              session: options.herdrSession ?? "default",
            },
            "pane.process_info",
            { pane_id: paneId },
            { timeoutMs: 2_000 },
          )
        : JSON.parse(
            (await (options.runCommand ?? defaultRunner)("herdr", ["pane", "process-info", "--pane", paneId]))
              .stdout,
          );
    const info = (
      response as { result?: { process_info?: { pane_id?: unknown; foreground_processes?: unknown } } }
    )?.result?.process_info;
    if (info?.pane_id !== paneId || !Array.isArray(info.foreground_processes)) return undefined;
    return info.foreground_processes.flatMap((item: { argv?: unknown }) =>
      Array.isArray(item?.argv) && item.argv.every((arg) => typeof arg === "string")
        ? [item.argv as string[]]
        : [],
    );
  } catch {
    return undefined;
  }
}

/**
 * Whether a harness's own argv launched it under maximum trust mode
 * (VUH-2048). Undefined for a harness with no such mode.
 */
export function launchedWithMaximumTrust(
  harness: string,
  argvs: readonly (readonly string[])[],
): boolean | undefined {
  const any = (match: (argv: readonly string[], index: number) => boolean) =>
    argvs.some((argv) => argv.some((_arg, index) => match(argv, index)));
  const flag = (name: string) => any((argv, index) => argv[index] === name);
  const option = (name: string, value: string) =>
    any((argv, index) => argv[index] === name && argv[index + 1] === value) || flag(`${name}=${value}`);
  if (harness === "claude")
    return flag("--dangerously-skip-permissions") || option("--permission-mode", "bypassPermissions");
  if (harness === "codex")
    return (
      flag("--dangerously-bypass-approvals-and-sandbox") ||
      flag("--yolo") ||
      (option("-c", 'approval_policy="never"') && option("-c", 'sandbox_mode="danger-full-access"'))
    );
  if (harness === "grok") return flag("--always-approve") || option("--permission-mode", "bypassPermissions");
  return undefined;
}

/**
 * The pane the owner sits in as him (ADR 0152): a herdr agent named
 * `clankie`. It is never a fleet contact; its transcript is his own thread.
 */
export interface ObservedHeadSeat {
  readonly seatId: string;
  readonly paneId: string;
  readonly occupantId: string;
  readonly harness: string;
  readonly status: string;
  readonly workingDirectory?: string;
  readonly session?: NonNullable<HerdrCensusAgent["session"]>;
}

export interface ObservedFleet {
  readonly seats: readonly ObservedFleetSeat[];
  readonly head?: ObservedHeadSeat;
}

/**
 * The fleet as occupied, messageable seats (ADR 0147), and the head seat when
 * a pane holds his name. Fail-soft: a down herdr socket renders an empty roster —
 * seats offline, never a failed conversation surface.
 */
export async function readFleet(
  options: {
    readonly runCommand?: HerdrCensusRunner;
    readonly summaries?: Readonly<Record<string, HerdrAgentSummary>>;
    readonly fleets?: readonly HerdrCensusFleet[];
    readonly herdrSession?: string;
    readonly bridgeSocket?: string;
    /** Override only for isolated host-observation tests; production uses this service process. */
    readonly runtimePid?: number;
    readonly localAvailable?: boolean;
    readonly localCodexRecordsPath?: string;
  } = {},
): Promise<ObservedFleet> {
  // Herdr's snapshot contains the same complete AgentInfo rows as agent.list,
  // alongside placement. Read them together, once, without an authority cache.
  const [local, remote] = await Promise.all([
    options.localAvailable === false
      ? Promise.resolve<ObservedFleet>({ seats: [] })
      : readLocalFleet(options),
    Promise.all(
      (options.fleets ?? []).map(async (fleet) => {
        try {
          const stdout = await fleet.run(["api", "snapshot"]);
          const snapshot = JSON.parse(stdout).result?.snapshot;
          if (!Array.isArray(snapshot?.agents)) throw new Error("Complete Herdr snapshot unavailable");
          return {
            fleet,
            agents: parseHerdrAgentList(JSON.stringify({ result: { agents: snapshot.agents } })).map(
              (entry) => qualifyAgent(fleet.id, entry),
            ),
            placements: parseHerdrTerminalCatalog(stdout)
              .slice(0, MAX_AGENTS)
              .map(
                ({ terminalId, workspace, tab }) =>
                  [`${fleet.id}/${terminalId}`, { workspace, tab }] as const,
              ),
          };
        } catch {
          return { fleet, agents: [], placements: [] };
        }
      }),
    ),
  ]);
  const placements = new Map<string, OperatorHerdrPlacement>(remote.flatMap((entry) => entry.placements));
  const remoteSeats = remote.flatMap((entry) =>
    "error" in entry
      ? []
      : entry.agents.flatMap((agent) => {
          if (
            agent.agent === "shell" ||
            agent.agent === "clankie" ||
            agent.name === OPERATOR_HEAD_AGENT_NAME ||
            agent.terminalId === undefined ||
            agent.session === undefined
          )
            return [];
          const named =
            agent.name === undefined ? undefined : subjectForHerdrName(agent.name, entry.fleet.id);
          const paneSubject = subjectForHerdrPane(agent.paneId);
          return [
            {
              seatId: agent.terminalId,
              paneId: agent.paneId,
              ...(agent.parentPaneId === undefined ? {} : { parentPaneId: agent.parentPaneId }),
              subject: named ?? paneSubject,
              ...(named === undefined || agent.name === undefined
                ? {}
                : { renamed: { name: bounded(agent.name, 80), from: paneSubject } }),
              occupantId: occupantIdForHerdrSession(agent.session),
              session: agent.session,
              harness: agent.agent,
              status: agent.status,
              title: bounded(agent.title, 200),
              ...(agent.cwd === undefined
                ? {}
                : { workingDirectory: bounded(agent.cwd, SEAT_DIRECTORY_MAX) }),
              fleet: entry.fleet.id,
              machine: bounded(entry.fleet.host, 200),
              herdrSession: bounded(entry.fleet.session, 200),
              ...(placements.has(agent.terminalId) ? { placement: placements.get(agent.terminalId)! } : {}),
            } satisfies ObservedFleetSeat,
          ];
        }),
  );
  return remoteSeats.length === 0 ? local : { ...local, seats: [...local.seats, ...remoteSeats] };
}

// Roster polls reuse a short host observation; explicit doctor reads always probe anew.
// The cache is display evidence only, never admission or message routing authority.
let bridgeSample:
  | { key: string; at: number; report: ReturnType<typeof inspectLiveHarnessBridges> }
  | undefined;

async function readLocalFleet(
  options: {
    readonly runCommand?: HerdrCensusRunner;
    readonly herdrSession?: string;
    readonly bridgeSocket?: string;
    readonly runtimePid?: number;
    readonly summaries?: Readonly<Record<string, HerdrAgentSummary>>;
    readonly localCodexRecordsPath?: string;
  } = {},
): Promise<ObservedFleet> {
  const run: HerdrCensusRunner =
    options.runCommand ??
    ((command, args) => {
      if (command === "herdr" && options.bridgeSocket) {
        const read = nativeHerdrRead(
          {
            runtime: "external",
            socketPath: options.bridgeSocket,
            session: options.herdrSession ?? "default",
          },
          args,
          { timeoutMs: CENSUS_TIMEOUT_MS },
        );
        if (read !== undefined) return read.then((stdout) => ({ stdout, stderr: "" }));
      }
      return defaultRunner(command, args);
    });
  try {
    // The agent list names each seat's workspace and tab only by id; their
    // labels and order live in the snapshot. A seat without one is still a seat.
    const [{ stdout }, placements] = await Promise.all([
      run("herdr", ["agent", "list"]),
      readTerminalCatalog({ runCommand: run }).then(
        (sessions) =>
          new Map(sessions.map(({ terminalId, workspace, tab }) => [terminalId, { workspace, tab }])),
      ),
    ]);
    let bridgeReport: Awaited<ReturnType<typeof inspectLiveHarnessBridges>> | undefined;
    if (options.bridgeSocket) {
      const panes = parseHerdrAgentList(stdout).map((entry) => ({
        paneId: entry.paneId,
        harness: entry.agent,
      }));
      const runtimePid = options.runtimePid ?? process.pid;
      const key = JSON.stringify([options.bridgeSocket, runtimePid, panes]);
      if (options.runCommand || bridgeSample?.key !== key || Date.now() - bridgeSample.at >= 5_000) {
        bridgeSample = {
          key,
          at: Date.now(),
          report: inspectLiveHarnessBridges({
            socket: options.bridgeSocket,
            runtimePid,
            panes,
            run: async (command, args) => (await run(command, args)).stdout,
          }),
        };
      }
      bridgeReport = await bridgeSample.report;
    }
    const bridges = new Map(
      bridgeReport?.panes.map(({ paneId, harness: _harness, ...observation }) => [paneId, observation]),
    );
    const summaries = options.summaries ?? readHerdrSummariesFile().agents;
    const observed = await Promise.all(
      parseHerdrAgentList(stdout).map(async (entry) => {
        const session = await recoverLocalCodexSession(entry, { ...options, runCommand: run });
        const observed = session === undefined ? entry : { ...entry, session };
        const parentPaneId = await recoverLocalCodexParent(observed, { ...options, runCommand: run });
        return parentPaneId === undefined ? observed : { ...observed, parentPaneId };
      }),
    );
    const occupied = observed.filter(
      (
        entry,
      ): entry is HerdrCensusAgent & {
        readonly terminalId: string;
        readonly session: NonNullable<HerdrCensusAgent["session"]>;
      } =>
        entry.agent !== "shell" &&
        entry.agent !== "clankie" &&
        entry.terminalId !== undefined &&
        entry.session !== undefined,
    );
    // One head at a time: the first pane herdr lists under his name is him,
    // and herdr keeps live agent names unique, so there is at most one.
    const headEntry = occupied.find((entry) => entry.name === OPERATOR_HEAD_AGENT_NAME);
    const head: ObservedHeadSeat | undefined =
      headEntry === undefined
        ? undefined
        : {
            seatId: headEntry.terminalId,
            paneId: headEntry.paneId,
            occupantId: occupantIdForHerdrSession(headEntry.session),
            harness: headEntry.agent,
            status: headEntry.status,
            session: headEntry.session,
            ...(headEntry.cwd === undefined
              ? {}
              : { workingDirectory: bounded(headEntry.cwd, SEAT_DIRECTORY_MAX) }),
          };
    const seats = occupied
      .filter((entry) => entry !== headEntry)
      .slice(0, MAX_AGENTS)
      .map((entry) => {
        const written = summaries[entry.paneId];
        const paneSubject = subjectForHerdrPane(entry.paneId);
        const named = entry.name === undefined ? undefined : subjectForHerdrName(entry.name);
        const placement = placements.get(entry.terminalId);
        return {
          ...(bridges.has(entry.paneId) ? { harnessBridge: bridges.get(entry.paneId)! } : {}),
          seatId: entry.terminalId,
          paneId: entry.paneId,
          ...(entry.parentPaneId === undefined ? {} : { parentPaneId: entry.parentPaneId }),
          // The owner-selected session is the fleet boundary (ADR 0149).
          // Named agents rebind across panes; an ad-hoc one remains stable for
          // its pane and never borrows identity from a rotating harness session.
          subject: named ?? paneSubject,
          ...(named === undefined || entry.name === undefined
            ? {}
            : { renamed: { name: bounded(entry.name, 80), from: paneSubject } }),
          occupantId: occupantIdForHerdrSession(entry.session),
          harness: entry.agent,
          status: entry.status,
          title: bounded(entry.title, 200),
          ...(written === undefined ? {} : { summary: bounded(written.summary, SEAT_SUMMARY_MAX) }),
          ...(written?.next === undefined ? {} : { next: bounded(written.next, SEAT_SUMMARY_MAX) }),
          ...(entry.cwd === undefined ? {} : { workingDirectory: bounded(entry.cwd, SEAT_DIRECTORY_MAX) }),
          ...(placement === undefined ? {} : { placement }),
          machine: bounded(hostname(), 200),
          ...(options.herdrSession ? { herdrSession: bounded(options.herdrSession, 200) } : {}),
          session: entry.session,
        };
      });
    return head === undefined ? { seats } : { seats, head };
  } catch {
    return { seats: [] };
  }
}

/** Live agent census for a seated turn. Fail-soft: a down socket is not a failed turn. */
export async function readHerdrSessionCensus(
  herdrPaneId: string | undefined,
  options: {
    readonly runCommand?: HerdrCensusRunner;
    readonly summaries?: Readonly<Record<string, HerdrAgentSummary>>;
    readonly fleets?: readonly HerdrCensusFleet[];
    readonly localAvailable?: boolean;
  } = {},
): Promise<HerdrSessionCensus> {
  const run = options.runCommand ?? defaultRunner;
  if (options.localAvailable === false) {
    const remote = await readRemoteFleets(options.fleets ?? []);
    return remote.length === 0
      ? { outcome: "unavailable", error: "Default Herdr workspace is unavailable" }
      : { outcome: "ok", text: remote.map(formatRemoteFleet).join("\n") };
  }
  try {
    const [{ stdout }, remote] = await Promise.all([
      run("herdr", ["agent", "list"]),
      readRemoteFleets(options.fleets ?? []),
    ]);
    return {
      outcome: "ok",
      text: [
        formatHerdrSessionCensus(
          herdrPaneId,
          parseHerdrAgentList(stdout),
          options.summaries ?? readHerdrSummariesFile().agents,
        ),
        ...remote.map(formatRemoteFleet),
      ].join("\n"),
    };
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") {
      return { outcome: "unavailable", error: "herdr is not on PATH" };
    }
    return { outcome: "unavailable", error: caught instanceof Error ? caught.message : String(caught) };
  }
}
