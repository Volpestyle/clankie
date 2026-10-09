import { execFile } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { HerdrBinding } from "@clankie/protocol";
import { resourceNativeHelperPath } from "@clankie/fleet-resources";
import { LocalCodexStateSchema, type LocalCodexRecord } from "./local-codex-records.ts";
import { nativeProcessStart, observeCodexServer } from "./local-fleet-process.ts";
import { nativeHerdrRead } from "./herdr-native-read.ts";
import { PaneTidyStateSchema } from "./captain/pane-tidy.ts";
import { HireOwnersStateSchema } from "./captain/hire-owners.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import { CodexAppServerClient, openCodexSocket } from "./captain/codex-app-server.ts";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const ProcessSchema = z
  .object({
    pid: z.number().int().min(2),
    ppid: z.number().int().nonnegative(),
    uid: z.number().int().nonnegative(),
    pgid: z.number().int().positive(),
    startTime: z.string(),
    legacyStartTime: z.string().optional(),
    executable: z.string(),
    executableVerified: z.boolean(),
    kind: z.enum(["codex", "claude", "helper"]),
    cwd: z.string().nullable(),
    server: z.boolean(),
    endpoint: z.string().nullable(),
  })
  .strict();
const CensusSchema = z
  .object({ schemaVersion: z.literal(1), processes: z.array(ProcessSchema).max(1024) })
  .strict();
type NativeProcess = z.infer<typeof ProcessSchema>;

/** Arguments and environment never escape the native census or enter its journal. */
function native(
  mode: "harness-processes" | "terminate-harness",
  input?: unknown,
  beforeDispatch?: () => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.platform === "darwin" ? "/usr/bin/python3" : "python3",
      ["-I", resourceNativeHelperPath(), mode],
      { timeout: 12_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) return reject(new Error("Native harness observation unavailable"));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid native harness observation"));
        }
      },
    );
    try {
      beforeDispatch?.();
      child.stdin?.end(input === undefined ? "" : JSON.stringify(input));
    } catch (error) {
      child.stdin?.end();
      reject(error);
    }
  });
}

export interface HarnessProcessFinding {
  pid: number;
  parent: number;
  executable: string;
  harness: NativeProcess["kind"];
  cwd: string | null;
  started: string;
  startedAt: string | null;
  lastActivity: string | null;
  lastActivitySource: "native-thread-log-mtime-proxy" | "unknown";
  liveOwners: { paneId: string; seatId: string }[];
  recordedPane?: string;
  threadId?: string;
  eligibility: "live" | "report-only" | "verified-closed-hire";
  reason: string;
  proof?: {
    hireId: string;
    ownerConversationId: string;
    seatId: string;
    occupantId: string;
    closeId: string;
    closedAt: string;
    birth: string;
    endpoint: string;
    canonicalSocket: string;
    nativeThreads: { id: string; status: "idle" | "notLoaded" }[];
    observedAt: string;
  };
}
export interface HarnessProcessReport {
  schemaVersion: 1;
  observedAt: string;
  censusComplete: boolean;
  counts: {
    codex: number;
    claude: number;
    helper: number;
    live: number;
    verified: number;
    reportOnly: number;
  };
  gaps: string[];
  processes: HarnessProcessFinding[];
}

/** Local controller records + confirmed own closure + fresh host facts; absence alone grants nothing. */
export class FleetHarnessProcesses {
  private busy = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly uncertain = new Set<string>();
  private auditUnavailable = false;
  private readonly options: {
    stateRoot: string;
    binding: () => HerdrBinding | undefined;
    report?: (result: unknown) => void;
    retirementScope?: (finding: HarnessProcessFinding) => boolean;
  };
  constructor(options: {
    stateRoot: string;
    binding: () => HerdrBinding | undefined;
    report?: (result: unknown) => void;
    retirementScope?: (finding: HarnessProcessFinding) => boolean;
  }) {
    this.options = options;
    const path = join(options.stateRoot, "captain", "harness-retirement.jsonl");
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        if (raw.length > 4 * 1024 * 1024) throw new Error("Retirement journal too large");
        for (const line of raw.trim().split("\n").filter(Boolean)) {
          const row = z
            .object({ pid: z.number().int().min(2), birth: z.string(), outcome: z.string() })
            .passthrough()
            .parse(JSON.parse(line));
          const key = `${row.pid}:${row.birth}`;
          if (["term-intent", "exit_unconfirmed"].includes(row.outcome)) this.uncertain.add(key);
          else this.uncertain.delete(key);
        }
      } catch {
        this.auditUnavailable = true;
      }
    }
  }
  private records(): LocalCodexRecord[] {
    const result: LocalCodexRecord[] = [];
    for (const file of ["local-codex-seats.json", "local-codex-seats.json.released.json"]) {
      const path = join(this.options.stateRoot, file);
      if (existsSync(path))
        result.push(...LocalCodexStateSchema.parse(JSON.parse(readFileSync(path, "utf8"))).seats);
    }
    return result;
  }
  private provenance(record: LocalCodexRecord) {
    if (!record.threadId || !record.endpoint || !/^\d+\.\d{6}$/u.test(record.start))
      throw new Error("exact_launch_identity_unavailable");
    const binding = this.options.binding();
    if (!binding || !isDeepStrictEqual(binding, record.binding))
      throw new Error("original_herdr_binding_changed");
    const occupant = occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: record.threadId });
    if (occupant !== record.nativeOccupantId) throw new Error("original_native_occupant_changed");
    const directory = join(this.options.stateRoot, "captain");
    const tidy = PaneTidyStateSchema.parse(
      JSON.parse(readFileSync(join(directory, "pane-tidy.json"), "utf8")),
    );
    const closes = tidy.entries.filter(
      (entry) => entry.paneId === record.pane && entry.sessionId === record.threadId,
    );
    const closed = closes.at(-1);
    if (!closed || closed.state !== "closed" || closed.harness !== "codex")
      throw new Error("confirmed_original_close_unavailable");
    const hires = HireOwnersStateSchema.parse(
      JSON.parse(readFileSync(join(directory, "herdr-watches.json.owners.json"), "utf8")),
    );
    const hire = hires.hires.find(
      (entry) =>
        entry.paneId === record.pane &&
        entry.seatId === closed.seatId &&
        entry.occupantId === occupant &&
        entry.hired !== false &&
        entry.sessionKey === JSON.stringify(["local", "codex", record.threadId]) &&
        entry.owner.conversationId === closed.owner.conversationId &&
        closed.closedBy.conversationId === closed.owner.conversationId,
    );
    if (!hire) throw new Error("original_hire_ownership_unavailable");
    return { hire, closed };
  }
  private async panes() {
    const binding = this.options.binding();
    if (!binding) throw new Error("herdr_binding_unavailable");
    const read = async (args: string[]) => {
      const reply = nativeHerdrRead(binding, args, { timeoutMs: 2_000 });
      if (!reply) throw new Error("pane_census_unavailable");
      return object(object(JSON.parse(await reply)).result);
    };
    const raw = (await read(["pane", "list"])).panes;
    if (!Array.isArray(raw) || raw.length > 256) throw new Error("complete_pane_census_unavailable");
    const panes = raw.map((value) => {
      const pane = object(value);
      if (typeof pane.pane_id !== "string" || typeof pane.terminal_id !== "string")
        throw new Error("invalid_pane_census");
      return {
        paneId: pane.pane_id,
        seatId: pane.terminal_id,
        threadId: object(pane.agent_session).value,
        pids: [] as number[],
      };
    });
    // Bounded native reads, never N simultaneous child processes.
    for (let at = 0; at < panes.length; at += 4) {
      await Promise.all(
        panes.slice(at, at + 4).map(async (pane) => {
          const info = object((await read(["pane", "process-info", "--pane", pane.paneId])).process_info);
          if (typeof info.shell_pid !== "number" || !Array.isArray(info.foreground_processes))
            throw new Error("pane_process_census_unavailable");
          pane.pids = [
            info.shell_pid,
            ...info.foreground_processes.map((value) => {
              const pid = object(value).pid;
              if (typeof pid !== "number") throw new Error("invalid_pane_process_census");
              return pid;
            }),
          ];
        }),
      );
    }
    return panes;
  }
  private async activity(record: LocalCodexRecord | undefined): Promise<string | null> {
    if (!record?.threadId || !/^[0-9a-f-]{36}$/iu.test(record.threadId)) return null;
    const root = join(record.catalogConfig?.home ?? join(homedir(), ".codex"), "sessions");
    let budget = 2048;
    const visit = async (path: string, depth: number): Promise<string | null> => {
      if (--budget < 0) return null;
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (--budget < 0) return null;
        if (entry.isFile() && entry.name.endsWith(`-${record.threadId}.jsonl`))
          return (await stat(join(path, entry.name))).mtime.toISOString();
        if (entry.isDirectory() && depth < 3) {
          const result = await visit(join(path, entry.name), depth + 1);
          if (result) return result;
        }
      }
      return null;
    };
    return visit(root, 0);
  }
  /** Fresh read-only socket connection. Never resumes a thread or starts a turn. */
  private async idle(
    record: LocalCodexRecord,
    effect?: (
      proof: { canonicalSocket: string; threads: { id: string; status: "idle" | "notLoaded" }[] },
      assertIdle: () => void,
    ) => Promise<void>,
  ) {
    const endpoint = record.endpoint!;
    const canonicalSocket = await realpath(endpoint.slice(7));
    const birth = await observeCodexServer(record.pid, endpoint, canonicalSocket);
    if (!birth || nativeProcessStart(birth) !== record.start)
      throw new Error("original_server_socket_or_birth_changed");
    const socket = await openCodexSocket(`ws+unix://${endpoint.slice(7)}:/`);
    if (!socket) throw new Error("original_native_socket_unavailable");
    let changed = false;
    const client = new CodexAppServerClient(
      socket,
      (event) => {
        if (
          ["turn/started", "item/started", "thread/started"].includes(event.method) ||
          (event.method === "thread/status/changed" && object(event.params.status).type !== "idle")
        )
          changed = true;
      },
      2_000,
    );
    try {
      await client.initialize(true);
      const loaded = object(await client.request("thread/loaded/list", {}));
      if (
        !Array.isArray(loaded.data) ||
        (loaded.data.length > 0 && !loaded.data.includes(record.threadId)) ||
        loaded.data.length > 64 ||
        loaded.nextCursor != null ||
        !loaded.data.every((id) => typeof id === "string")
      )
        throw new Error("original_loaded_thread_inventory_unavailable");
      const threads: { id: string; status: "idle" | "notLoaded" }[] = [];
      const parents = new Map<string, string | null>();
      const ids = loaded.data.length ? (loaded.data as string[]) : [record.threadId!];
      for (const id of ids) {
        const thread = object(
          object(await client.request("thread/read", { threadId: id, includeTurns: false })).thread,
        );
        const status = object(thread.status).type;
        if (thread.id !== id || (loaded.data.length ? status !== "idle" : status !== "notLoaded"))
          throw new Error("native_thread_busy_or_unknown");
        parents.set(id, typeof thread.parentThreadId === "string" ? thread.parentThreadId : null);
        threads.push({ id, status: status as "idle" | "notLoaded" });
      }
      for (const thread of threads) {
        let id = thread.id;
        const seen = new Set<string>();
        while (id !== record.threadId) {
          if (seen.has(id) || !parents.get(id)) throw new Error("independent_or_unknown_native_thread");
          seen.add(id);
          id = parents.get(id)!;
        }
      }
      const loadedAfter = object(await client.request("thread/loaded/list", {}));
      if (!isDeepStrictEqual(loadedAfter, loaded)) throw new Error("native_loaded_inventory_changed");
      if (changed) throw new Error("native_thread_became_active");
      const after = await observeCodexServer(record.pid, endpoint, canonicalSocket);
      if (!after || nativeProcessStart(after) !== record.start)
        throw new Error("original_server_changed_during_read");
      if (effect) {
        await effect({ canonicalSocket, threads }, () => {
          if (changed) throw new Error("native_thread_became_active");
        });
        if (changed) throw new Error("native_thread_became_active");
      }
      return { canonicalSocket, threads };
    } finally {
      client.close();
      socket.terminate();
    }
  }
  async list(): Promise<HarnessProcessReport> {
    const observedAt = new Date().toISOString();
    const nativeRows = CensusSchema.parse(await native("harness-processes")).processes;
    const gaps: string[] = [];
    const panes = await this.panes().catch(() => {
      gaps.push("complete_pane_census_unavailable");
      return [];
    });
    const records = (() => {
      try {
        return this.records();
      } catch {
        gaps.push("launch_registry_unavailable");
        return [];
      }
    })();
    const processes: HarnessProcessFinding[] = [];
    for (const row of nativeRows) {
      const record = records.find(
        (record) =>
          record.pid === row.pid && (record.start === row.startTime || record.start === row.legacyStartTime),
      );
      const ancestors = new Set<number>([row.pid]);
      let parent = row.ppid;
      while (parent > 1 && !ancestors.has(parent) && ancestors.size < 64) {
        ancestors.add(parent);
        parent = nativeRows.find((value) => value.pid === parent)?.ppid ?? 0;
      }
      const inherited = records.filter((record) => ancestors.has(record.pid));
      const liveOwners = panes
        .filter(
          (pane) =>
            pane.pids.some((pid) => ancestors.has(pid)) ||
            inherited.some((record) => pane.paneId === record.pane || pane.threadId === record.threadId) ||
            (row.endpoint &&
              pane.pids.some((pid) =>
                nativeRows.some((other) => other.pid === pid && other.endpoint === row.endpoint),
              )),
        )
        .map(({ paneId, seatId }) => ({ paneId, seatId }));
      const lastActivity = await this.activity(record);
      const finding: HarnessProcessFinding = {
        pid: row.pid,
        parent: row.ppid,
        executable: row.executable,
        harness: row.kind,
        cwd: row.cwd,
        started: row.startTime,
        startedAt: /^\d+\.\d{6}$/u.test(row.startTime)
          ? new Date(Number(row.startTime) * 1_000).toISOString()
          : null,
        lastActivity,
        lastActivitySource: lastActivity ? "native-thread-log-mtime-proxy" : "unknown",
        liveOwners,
        ...(record
          ? { recordedPane: record.pane, ...(record.threadId ? { threadId: record.threadId } : {}) }
          : {}),
        eligibility: liveOwners.length ? "live" : "report-only",
        reason: liveOwners.length ? "live_pane_or_thread" : "original_launch_unattributed",
      };
      if (!liveOwners.length && record) {
        try {
          if (gaps.length) throw new Error(gaps[0]);
          if (!row.executableVerified) throw new Error("native_executable_unavailable");
          if (row.kind !== "codex" || !row.server || row.endpoint !== record.endpoint)
            throw new Error("original_server_arguments_changed");
          if (
            nativeRows.some(
              (other) => other.pid !== row.pid && other.endpoint && other.endpoint === row.endpoint,
            )
          )
            throw new Error("native_client_still_attached");
          const { hire, closed } = this.provenance(record);
          const idle = await this.idle(record);
          finding.proof = {
            hireId: hire.id,
            ownerConversationId: hire.owner.conversationId,
            seatId: closed.seatId,
            occupantId: record.nativeOccupantId,
            closeId: closed.id,
            closedAt: closed.closedAt,
            birth: record.start,
            endpoint: record.endpoint!,
            canonicalSocket: idle.canonicalSocket,
            nativeThreads: idle.threads,
            observedAt: new Date().toISOString(),
          };
          finding.eligibility = "verified-closed-hire";
          finding.reason = "original_closed_hire_idle";
        } catch (error) {
          finding.reason = error instanceof Error ? error.message : "proof_unavailable";
        }
      }
      processes.push(finding);
    }
    return {
      schemaVersion: 1,
      observedAt,
      censusComplete: !gaps.length,
      gaps,
      processes,
      counts: {
        codex: processes.filter((row) => row.harness === "codex").length,
        claude: processes.filter((row) => row.harness === "claude").length,
        helper: processes.filter((row) => row.harness === "helper").length,
        live: processes.filter((row) => row.eligibility === "live").length,
        verified: processes.filter((row) => row.eligibility === "verified-closed-hire").length,
        reportOnly: processes.filter((row) => row.eligibility === "report-only").length,
      },
    };
  }
  async retire(): Promise<{
    before: HarnessProcessReport;
    outcomes: { pid: number; outcome: string }[];
    after: HarnessProcessReport;
  }> {
    if (this.closed) throw new Error("Harness recovery stopped");
    if (this.auditUnavailable) throw new Error("Retirement journal unavailable; no signals sent");
    if (this.busy) throw new Error("Harness retirement already running");
    this.busy = true;
    try {
      const before = await this.list();
      const outcomes: { pid: number; outcome: string }[] = [];
      for (const candidate of before.processes.filter(
        (row) => row.eligibility === "verified-closed-hire" && (this.options.retirementScope?.(row) ?? true),
      )) {
        const key = `${candidate.pid}:${candidate.started}`;
        if (this.uncertain.has(key)) {
          outcomes.push({ pid: candidate.pid, outcome: "prior_exit_unconfirmed" });
          continue;
        }
        let outcome = "refused";
        try {
          const record = this.records().find(
            (record) => record.pid === candidate.pid && record.start === candidate.started,
          );
          if (!record || this.provenance(record).closed.id !== candidate.proof?.closeId)
            throw new Error("closure_or_process_changed");
          await this.idle(record, async (_proof, assertIdle) => {
            // Final complete pane census and provenance recheck while the idle
            // connection remains open. No old snapshot or timer confers authority.
            const panes = await this.panes();
            if (
              panes.some(
                (pane) =>
                  pane.paneId === record.pane ||
                  pane.threadId === record.threadId ||
                  pane.pids.includes(record.pid),
              )
            )
              throw new Error("pane_or_thread_reopened");
            this.provenance(record);
            if (!this.records().some((row) => isDeepStrictEqual(row, record)))
              throw new Error("launch_record_changed");
            if (this.closed) throw new Error("Harness recovery stopped");
            assertIdle();
            this.audit({
              pid: record.pid,
              birth: record.start,
              proof: candidate.proof,
              outcome: "term-intent",
            });
            this.uncertain.add(key);
            outcome = z
              .object({ outcome: z.enum(["retired", "exited", "refused", "exit_unconfirmed"]) })
              .strict()
              .parse(
                await native(
                  "terminate-harness",
                  {
                    pid: record.pid,
                    startTime: record.start,
                    endpoint: record.endpoint,
                    executable: candidate.executable,
                  },
                  () => {
                    if (this.closed) throw new Error("Harness recovery stopped");
                    assertIdle();
                  },
                ),
              ).outcome;
            if (outcome !== "exit_unconfirmed") this.uncertain.delete(key);
          });
        } catch (error) {
          outcome = this.uncertain.has(key)
            ? "exit_unconfirmed"
            : error instanceof Error
              ? error.message
              : "refused";
        }
        this.audit({ pid: candidate.pid, birth: candidate.started, outcome });
        outcomes.push({ pid: candidate.pid, outcome });
      }
      return { before, outcomes, after: await this.list() };
    } finally {
      this.busy = false;
    }
  }
  private audit(value: unknown): void {
    const directory = join(this.options.stateRoot, "captain");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = openSync(join(directory, "harness-retirement.jsonl"), "a", 0o600);
    try {
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...object(value) }) + "\n");
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
  }
  /** Bounded periodic recovery of confirmed closures after service replacement. */
  start(): void {
    this.timer ??= setInterval(() => {
      if (!this.busy)
        void this.retire()
          .then((result) => {
            if (result.outcomes.length) this.options.report?.(result.outcomes);
          })
          .catch(() => this.options.report?.({ outcome: "observation_unavailable" }));
    }, 5 * 60_000);
    this.timer.unref();
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
}
