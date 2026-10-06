import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveHerdrSeatTranscriptPathAsync, sessionIdFromPath } from "@clankie/agent-transcript";
import {
  CaptainTurnSettledMetricsSchema,
  IssueMetricsReportSchema,
  IssueMetricsQuerySchema,
  type IssueMetricsQuery,
  type IssueMetricsReport,
} from "@clankie/protocol";
import { z } from "zod";
import { SeatLedgerRowSchema } from "./seat-ledger.ts";
import { ReceiptSchema } from "./delivery-fence.ts";
import { HireOwnersStateSchema } from "./hire-owners.ts";
import { PaneTidyStateSchema } from "./pane-tidy.ts";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const SESSION_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const identifiers = (text: string) => [...new Set(text.match(/\b[A-Z][A-Z0-9]*-\d+\b/gu) ?? [])];
type Worker = IssueMetricsReport["issues"][number]["workers"][number];
type Episode = Worker & { issueId: string; lastAt: string; source: string };
type NativeRecord = { at: string; id: string; prompt?: string; tokens?: number; commands?: string[] };
const MetaSchema = z.object({
  title: z.string(),
  scope: z.object({ kind: z.string(), seatId: z.string().optional() }).optional(),
  nativeSource: z
    .object({
      terminalId: z.string(),
      paneId: z.string(),
      agent: z.enum(["codex", "claude"]),
      session: z.object({ source: z.string(), kind: z.enum(["id", "path"]), value: z.string() }),
    })
    .optional(),
  inboundAcceptances: z
    .record(z.string(), z.object({ text: z.string(), runId: z.string(), paneId: z.string() }))
    .optional(),
});
type NativeSource = NonNullable<z.infer<typeof MetaSchema>["nativeSource"]>;
type MetricsBinding = {
  native: NativeSource;
  label: string;
  aliases: Set<string>;
  owner?: string;
  priority: number;
};
const HistoricalSessionKeySchema = z.tuple([
  z.string().min(1),
  z.enum(["codex", "claude"]),
  z.string().regex(/^[a-z0-9_-]{1,128}$/iu),
]);

function commands(value: unknown, name: unknown): string[] {
  const tool = typeof name === "string" ? name.split(".").at(-1) : undefined;
  if (!["exec", "exec_command", "shell", "shell_command", "bash"].includes(tool ?? "")) return [];
  if (typeof value !== "string") return [];
  try {
    const args = obj(JSON.parse(value));
    if (typeof args.cmd === "string") return [args.cmd];
    if (typeof args.command === "string") return [args.command];
    if (typeof args.code === "string") value = args.code;
  } catch {
    /* Native custom tools carry plain source, not JSON. Never execute it. */
  }
  const result: string[] = [];
  for (const match of (value as string).matchAll(
    /\btools\.exec_command\s*\(\s*\{[^}]*?\b(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu,
  )) {
    try {
      result.push(
        match[1]!.startsWith('"')
          ? JSON.parse(match[1]!)
          : match[1]!.slice(1, -1).replaceAll("\\'", "'").replaceAll("\\\\", "\\"),
      );
    } catch {
      /* An interpolated/unsupported command is not evidence of a launch. */
    }
  }
  return result;
}

function fullChecks(command: string): number {
  // Count invocations, never report prose, grep/tail commands or command strings
  // written to logs. Recognize the shell and literal Python launch forms kept
  // in today's native records; unknown wrappers remain outside this count.
  const clauses: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  let from = 0;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (";&|\n".includes(char)) {
      clauses.push(command.slice(from, index));
      from = index + 1;
    }
  }
  clauses.push(command.slice(from));
  const shell = clauses.filter((clause) =>
    /^\s*(?:CI=\S+\s+)?pnpm\s+(?:run\s+)?check(?=\s|$)/u.test(clause),
  ).length;
  const python = [
    ...command.matchAll(
      /(?:^|\n)\s*(?:\w+\s*=\s*)?subprocess\.(?:run|Popen|call|check_call)\s*\(\s*\[\s*(['"])pnpm\1\s*,\s*(['"])check\2\s*(?:,|\])/gu,
    ),
  ].length;
  return shell + python;
}

/** Fold only native rows; no tool source, shell command or model output executes here. */
function nativeRecords(raw: string, harness: "codex" | "claude", sessionId?: string): NativeRecord[] {
  const records: NativeRecord[] = [];
  const used = new Set<string>();
  const claudeUsage = new Map<string, NativeRecord>();
  let lineId = 0;
  for (const line of raw.split("\n")) {
    lineId++;
    let entry: Record<string, unknown>;
    try {
      entry = obj(JSON.parse(line));
    } catch {
      continue;
    }
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) continue;
    const at = new Date(timestamp).toISOString();
    if (
      harness === "claude" &&
      (entry.isSidechain === true ||
        (sessionId !== undefined && typeof entry.sessionId === "string" && entry.sessionId !== sessionId))
    )
      continue;
    const payload = obj(harness === "codex" ? entry.payload : entry.message);
    const id = String(entry.uuid ?? payload.call_id ?? payload.response_id ?? entry.ordinal ?? lineId);
    if (harness === "codex" && entry.type === "token_usage_record") {
      if (sessionId !== undefined && typeof payload.thread_id === "string" && payload.thread_id !== sessionId)
        continue;
      const usage = obj(payload.usage);
      if (
        typeof payload.response_id === "string" &&
        typeof usage.total_tokens === "number" &&
        Number.isSafeInteger(usage.total_tokens) &&
        usage.total_tokens >= 0 &&
        !used.has(`usage:${id}`)
      ) {
        used.add(`usage:${id}`);
        records.push({ at, id, tokens: Math.trunc(usage.total_tokens) });
      }
      continue;
    }
    if (harness === "codex" && entry.type !== "response_item") continue;
    if (payload.role === "user" && (harness === "claude" || payload.type === "message")) {
      const content = payload.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((part) => obj(part).text)
                .filter((v) => typeof v === "string")
                .join("\n")
            : "";
      if (!used.has(`prompt:${at}:${text}`)) {
        used.add(`prompt:${at}:${text}`);
        records.push({ at, id, prompt: text });
      }
    }
    if (harness === "claude" && payload.role === "assistant") {
      const usage = obj(payload.usage);
      const names = [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
      ];
      if (
        typeof payload.id === "string" &&
        typeof usage.input_tokens === "number" &&
        typeof usage.output_tokens === "number"
      ) {
        claudeUsage.set(payload.id, {
          at,
          id: payload.id,
          tokens: names.reduce(
            (sum, name) =>
              sum + (typeof usage[name] === "number" ? Math.max(0, Math.trunc(usage[name] as number)) : 0),
            0,
          ),
        });
      }
      if (Array.isArray(payload.content))
        for (const part of payload.content) {
          const tool = obj(part);
          if (tool.type === "tool_use" && typeof tool.id === "string" && !used.has(`call:${tool.id}`)) {
            used.add(`call:${tool.id}`);
            const input = obj(tool.input);
            if (tool.name === "Bash" && typeof input.command === "string")
              records.push({ at, id: String(tool.id), commands: [input.command] });
          }
        }
    }
    if (
      harness === "codex" &&
      (payload.type === "function_call" || payload.type === "custom_tool_call") &&
      !used.has(`call:${id}`)
    ) {
      used.add(`call:${id}`);
      records.push({ at, id, commands: commands(payload.arguments ?? payload.input, payload.name) });
    }
  }
  records.push(...claudeUsage.values());
  return records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function assignedIssue(text: string): string | undefined {
  return (
    text.match(/^(?:You own Linear|You own|Implement|Fix)\s+([A-Z][A-Z0-9]*-\d+)\b/u)?.[1] ??
    text.match(/\bNext for you:\s*([A-Z][A-Z0-9]*-\d+)\b/u)?.[1]
  );
}

/** Scan only an already bound source, retaining one line at a time. An issue
 * mention in model/tool output cannot select a source. The full read budgets
 * apply after selection, so unrelated histories cannot starve an issue query. */
async function containsAssignment(
  path: string,
  harness: "codex" | "claude",
  sessionId: string | undefined,
  issue: string,
): Promise<boolean> {
  const stream = createReadStream(path, { encoding: "utf8", end: MAX_SOURCE_BYTES - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let scanned = 0;
  try {
    for await (const line of lines) {
      scanned += Buffer.byteLength(line) + 1;
      if (scanned > MAX_SOURCE_BYTES) throw new Error("Source grew beyond scan budget");
      let entry;
      try {
        entry = obj(JSON.parse(line));
      } catch {
        continue;
      }
      if (obj(harness === "codex" ? entry.payload : entry.message).role !== "user") continue;
      if (
        nativeRecords(line, harness, sessionId).some(
          (row) => row.prompt !== undefined && assignedIssue(row.prompt) === issue,
        )
      )
        return true;
    }
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function episodes(
  records: NativeRecord[],
  workerId: string,
  label: string,
  sessionId: string,
  source: string,
): Episode[] {
  const result: Episode[] = [];
  let active: Episode | undefined;
  for (const record of records) {
    if (record.prompt !== undefined) {
      const text = record.prompt;
      const firstSentence = text.split(/[.!?\n]/u)[0] ?? "";
      if (active && active.acceptedAt === null && text.slice(0, 240).includes(active.issueId)) {
        if (
          /\b(?:approved|accepted for landing)\b/iu.test(firstSentence) &&
          firstSentence.includes(active.issueId) &&
          !/\b(?:not|isn't|haven't|hasn't|unapproved|pending|awaiting|plan|approach|proposal)\b/iu.test(
            firstSentence,
          ) &&
          !/\b(?:need .{0,30}fix|changes requested|before landing|rework)\b/iu.test(text.slice(0, 240))
        ) {
          active.acceptedAt = record.at;
          active.wallTimeMs = Math.max(0, Date.parse(record.at) - Date.parse(active.startedAt));
          active.reviewRounds = (active.reviewRounds ?? 0) + 1;
        } else if (
          /\b(?:review of|reviewed|review:)\b/iu.test(text.slice(0, 240)) &&
          /\b(?:need .{0,30}fix|changes requested|before landing|rework)\b/iu.test(text.slice(0, 1000))
        ) {
          active.reviewRounds = (active.reviewRounds ?? 0) + 1;
          active.reworkRounds = (active.reworkRounds ?? 0) + 1;
        }
      }
      const assigned = assignedIssue(text);
      if (assigned && (!active || active.issueId !== assigned || active.acceptedAt !== null)) {
        active = {
          issueId: assigned,
          workerId,
          label,
          nativeSessionId: sessionId,
          source,
          startedAt: record.at,
          acceptedAt: null,
          lastAt: record.at,
          wallTimeMs: null,
          reportedTokens: null,
          usageReports: 0,
          fullCheckRuns: null,
          reviewRounds: null,
          reworkRounds: null,
          seatSettlements: { passed: 0, failed: 0, prompt: 0, ship: 0 },
          unresolvedHireReceipt: false,
        };
        result.push(active);
      }
    }
    if (!active || active.acceptedAt !== null || record.at < active.startedAt) continue;
    active.lastAt = record.at;
    if (record.tokens !== undefined) {
      active.reportedTokens = (active.reportedTokens ?? 0) + record.tokens;
      active.usageReports++;
    }
    if (record.commands !== undefined) {
      active.fullCheckRuns =
        (active.fullCheckRuns ?? 0) + record.commands.reduce((sum, command) => sum + fullChecks(command), 0);
    }
  }
  for (const row of result) if (row.acceptedAt !== null) row.reworkRounds ??= 0;
  return result;
}

const sumKnown = (values: (number | null)[]) =>
  values.some((v) => v !== null) ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null;

/** Operator-only read projection of existing records. Writes no new ledger. */
export async function readIssueMetrics(
  stateDir: string,
  input: IssueMetricsQuery = {},
): Promise<IssueMetricsReport> {
  const query = IssueMetricsQuerySchema.parse(input);
  const until = new Date(query.until ?? Date.now()).toISOString();
  const since = new Date(query.since ?? Date.parse(until) - 86_400_000).toISOString();
  if (Date.parse(since) >= Date.parse(until) || Date.parse(until) - Date.parse(since) > 366 * 86_400_000)
    throw new RangeError("Metrics window must be positive and at most 366 days");
  const warnings: string[] = [];
  let bytesRead = 0;
  const read = async (path: string): Promise<string | undefined> => {
    try {
      const info = await stat(path);
      if (info.size > MAX_SOURCE_BYTES) {
        warnings.push(`Source exceeds 64 MiB: ${path.split("/").at(-1)}`);
        return undefined;
      }
      if (bytesRead + info.size > MAX_REQUEST_BYTES) {
        warnings.push("256 MiB request read budget exhausted; remaining sources unavailable");
        return undefined;
      }
      bytesRead += info.size;
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`Unreadable source: ${path.split("/").at(-1)}`);
      return undefined;
    }
  };
  const metas = [];
  for (const entry of await readdir(join(stateDir, "conversations"), { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!entry.isDirectory()) continue;
    const raw = await read(join(stateDir, "conversations", entry.name, "meta.json"));
    try {
      const parsed = MetaSchema.safeParse(JSON.parse(raw ?? "null"));
      if (parsed.success) metas.push(parsed.data);
      else if (raw) warnings.push(`Unsupported conversation metadata: ${entry.name}`);
    } catch {
      warnings.push(`Invalid conversation metadata: ${entry.name}`);
    }
  }
  const all: Episode[] = [];
  const bindings: MetricsBinding[] = [];
  const seatLabels = new Map<string, string>();
  for (const meta of metas)
    if (meta.scope?.kind === "seat" && meta.scope.seatId) seatLabels.set(meta.scope.seatId, meta.title);
  const bind = (native: NativeSource, label: string, priority: number, owner?: string) => {
    bindings.push({
      native,
      label,
      priority,
      ...(owner === undefined ? {} : { owner }),
      aliases: new Set([native.terminalId, label, native.session.value]),
    });
  };
  for (const meta of metas) {
    const native = meta.nativeSource;
    if (!native) continue;
    bind(native, meta.title, 3);
  }
  // These are historical provenance, not current delivery/driver authority.
  // Fold exact saved bindings; never search unrelated transcript directories
  // for issue mentions, or modify the owner's live conversation attachment.
  const ownersRaw = await read(join(stateDir, "herdr-watches.json.owners.json"));
  if (ownersRaw !== undefined) {
    try {
      const owners = HireOwnersStateSchema.parse(JSON.parse(ownersRaw));
      for (const hire of owners.hires) {
        if (!hire.seatId) continue; // A bare startup intent has no native history yet.
        let session;
        try {
          session = HistoricalSessionKeySchema.parse(JSON.parse(hire.sessionKey ?? "null"));
        } catch {
          warnings.push(`Native history binding unavailable: ${hire.seatId}`);
          continue;
        }
        const [fleet, agent, value] = session;
        if (fleet !== "local") {
          warnings.push(`Remote native history unavailable: ${hire.seatId}`);
          continue;
        }
        if (!hire.paneId) {
          warnings.push(`Native history binding unavailable: ${hire.seatId}`);
          continue;
        }
        bind(
          {
            terminalId: hire.seatId,
            paneId: hire.paneId,
            agent,
            session: { source: `herdr:${agent}`, kind: "id", value },
          },
          seatLabels.get(hire.seatId) ?? hire.seatId,
          1,
          hire.owner.conversationId,
        );
      }
    } catch {
      warnings.push("Invalid historical hire bindings");
    }
  }
  const tidyRaw = await read(join(stateDir, "pane-tidy.json"));
  if (tidyRaw !== undefined) {
    try {
      const tidy = PaneTidyStateSchema.parse(JSON.parse(tidyRaw));
      // Prefer the latest retained name when a worker resumes the same thread.
      for (const entry of [...tidy.entries].reverse()) {
        bind(
          {
            terminalId: entry.seatId,
            paneId: entry.paneId,
            agent: entry.harness,
            session: {
              source: `herdr:${entry.harness}`,
              kind: entry.sessionId.startsWith("/") ? "path" : "id",
              value: entry.sessionId,
            },
          },
          entry.title || seatLabels.get(entry.seatId) || entry.seatId,
          2,
          entry.owner.conversationId,
        );
      }
    } catch {
      warnings.push("Invalid closed worker history");
    }
  }
  const groups = new Map<
    string,
    { path: string; size: number; mtimeMs: number; bindings: MetricsBinding[] }
  >();
  for (const binding of bindings) {
    const native = binding.native;
    if (native.paneId.includes("/")) {
      warnings.push(`Remote native history unavailable: ${native.terminalId}`);
      continue;
    }
    const path = await resolveHerdrSeatTranscriptPathAsync(native.agent, native.session);
    if (!path) {
      warnings.push(`Native history unavailable: ${native.terminalId}`);
      continue;
    }
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) {
      warnings.push(`Native history unreadable: ${native.terminalId}`);
      continue;
    }
    // ID/path aliases and hard links must not count a native response twice.
    const key = `${native.agent}:${info.dev}:${info.ino}`;
    const group = groups.get(key) ?? { path, size: info.size, mtimeMs: info.mtimeMs, bindings: [] };
    group.bindings.push(binding);
    groups.set(key, group);
  }
  // Separate files claiming the same native UUID are ambiguous histories,
  // even if the caller selects only one of their worker aliases. Do not double
  // totals or guess which archived copy is complete/current.
  const logicalSources = new Map<string, Set<string>>();
  for (const [key, group] of groups) {
    const native = group.bindings[0]!.native;
    const namedSession = sessionIdFromPath({
      harness: native.agent,
      path: group.path,
      size: group.size,
      mtimeMs: group.mtimeMs,
    });
    const ids = new Set([
      namedSession,
      ...group.bindings
        .filter((binding) => binding.native.session.kind === "id")
        .map((binding) => binding.native.session.value),
    ]);
    for (const id of ids) {
      if (!SESSION_UUID.test(id)) continue;
      const ref = `${native.agent}:${id.toLowerCase()}`;
      const held = logicalSources.get(ref) ?? new Set<string>();
      held.add(key);
      logicalSources.set(ref, held);
    }
  }
  const ambiguousFiles = new Set<string>();
  for (const [ref, files] of logicalSources) {
    if (files.size < 2) continue;
    warnings.push(`Ambiguous native history files: ${ref}`);
    for (const key of files) ambiguousFiles.add(key);
  }
  const sourceSessions = new Map<string, Set<string>>();
  for (const [key, group] of groups) {
    if (ambiguousFiles.has(key)) continue;
    const found = group.bindings.sort((a, b) => b.priority - a.priority);
    const primary = found[0]!;
    const aliases = new Set(found.flatMap((binding) => [...binding.aliases]));
    if (query.worker !== undefined && !aliases.has(query.worker)) continue;
    const owners = new Set(found.flatMap((binding) => (binding.owner === undefined ? [] : [binding.owner])));
    if (owners.size > 1) {
      warnings.push(`Conflicting native history owners: ${primary.native.terminalId}`);
      continue;
    }
    const native = primary.native;
    const path = group.path;
    const namedSession = sessionIdFromPath({
      harness: native.agent,
      path,
      size: group.size,
      mtimeMs: group.mtimeMs,
    });
    const sessionId =
      found.find((binding) => binding.native.session.kind === "id")?.native.session.value ??
      (SESSION_UUID.test(namedSession) ? namedSession : undefined);
    if (query.issue !== undefined) {
      if (group.size > MAX_SOURCE_BYTES) {
        warnings.push(`Source exceeds 64 MiB: ${path.split("/").at(-1)}`);
        continue;
      }
      try {
        if (!(await containsAssignment(path, native.agent, sessionId, query.issue))) continue;
      } catch {
        warnings.push(`Native history scan unavailable: ${native.terminalId}`);
        continue;
      }
    }
    const raw = await read(path);
    if (raw === undefined) {
      warnings.push(`Native history unreadable: ${native.terminalId}`);
      continue;
    }
    sourceSessions.set(
      key,
      new Set([
        ...found.map((binding) => binding.native.session.value),
        ...(sessionId === undefined ? [] : [sessionId]),
      ]),
    );
    all.push(
      ...episodes(
        nativeRecords(raw, native.agent, sessionId),
        native.terminalId,
        primary.label,
        native.session.value,
        key,
      ),
    );
  }
  const rows = all.filter(
    (row) =>
      (row.acceptedAt ?? row.lastAt) >= since &&
      (row.acceptedAt ?? row.lastAt) < until &&
      (query.issue === undefined || row.issueId === query.issue),
  );
  const ledger = ((await read(join(stateDir, "seat-ledger.jsonl"))) ?? "").split("\n");
  for (const line of ledger) {
    try {
      const parsed = SeatLedgerRowSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const value = parsed.data;
      for (const row of rows)
        if (
          value.seatId === row.workerId &&
          typeof value.at === "string" &&
          value.at >= row.startedAt &&
          value.at <= (row.acceptedAt ?? until) &&
          Object.hasOwn(row.seatSettlements, String(value.kind))
        )
          row.seatSettlements[value.kind as keyof Worker["seatSettlements"]]++;
    } catch {
      /* A torn ledger tail is not a settled run. */
    }
  }
  let receipts: Record<string, unknown> = {};
  try {
    receipts = z
      .record(z.string(), ReceiptSchema)
      .parse(JSON.parse((await read(join(stateDir, "herdr-watches.json.hire-receipts.json"))) ?? "{}"));
  } catch {
    warnings.push("Unreadable hire receipt snapshot");
  }
  for (const row of rows)
    row.unresolvedHireReceipt = Object.values(receipts).some((value) => {
      const sessionId = obj(value).sessionId;
      return typeof sessionId === "string" && sourceSessions.get(row.source)?.has(sessionId);
    });
  const lead = new Map<string, { tokens: number; reports: number }>();
  const assignments = new Map<string, Set<string>>();
  for (const meta of metas)
    for (const acceptance of Object.values(meta.inboundAcceptances ?? {})) {
      const ids = identifiers(acceptance.text);
      const held = assignments.get(acceptance.runId) ?? new Set<string>();
      for (const id of ids) held.add(id);
      if (ids.length === 0) held.add("unknown");
      assignments.set(acceptance.runId, held);
    }
  const counted = new Set<string>();
  for (const line of ((await read(join(stateDir, "turn-settled.jsonl"))) ?? "").split("\n")) {
    try {
      const parsed = CaptainTurnSettledMetricsSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const metric = parsed.data;
      const runId = metric.runId;
      const linked = assignments.get(runId);
      const issue = linked?.size === 1 ? [...linked][0] : undefined;
      const usage = metric.usage;
      if (
        issue &&
        rows.some(
          (row) =>
            row.issueId === issue &&
            typeof metric.acceptedAt === "string" &&
            metric.acceptedAt >= row.startedAt &&
            metric.acceptedAt <= (row.acceptedAt ?? until),
        ) &&
        !counted.has(runId) &&
        usage != null &&
        typeof usage.totalTokens === "number" &&
        typeof usage.reports === "number"
      ) {
        counted.add(runId);
        const held = lead.get(issue) ?? { tokens: 0, reports: 0 };
        held.tokens += usage.totalTokens;
        held.reports += usage.reports;
        lead.set(issue, held);
      }
    } catch {
      /* Incomplete rows are unavailable. */
    }
  }
  const issues = [...new Set(rows.map((row) => row.issueId))].sort().map((issueId) => {
    const found = rows.filter((row) => row.issueId === issueId);
    const startedAt = found.map((row) => row.startedAt).sort()[0]!;
    const acceptedAt = found.every((row) => row.acceptedAt !== null)
      ? found
          .map((row) => row.acceptedAt!)
          .sort()
          .at(-1)!
      : null;
    return {
      issueId,
      status: acceptedAt === null ? ("in_progress" as const) : ("accepted" as const),
      startedAt,
      acceptedAt,
      wallTimeMs: acceptedAt === null ? null : Math.max(0, Date.parse(acceptedAt) - Date.parse(startedAt)),
      reportedTokens: sumKnown(found.map((r) => r.reportedTokens)),
      usageReports: found.reduce((n, r) => n + r.usageReports, 0),
      fullCheckRuns: sumKnown(found.map((r) => r.fullCheckRuns)),
      reviewRounds: sumKnown(found.map((r) => r.reviewRounds)),
      reworkRounds: sumKnown(found.map((r) => r.reworkRounds)),
      leadReportedTokens: lead.get(issueId)?.tokens ?? null,
      leadUsageReports: lead.get(issueId)?.reports ?? 0,
      workers: found.map(({ issueId: _issue, lastAt: _last, source: _source, ...worker }) => worker),
    };
  });
  const workers = [...new Set(rows.map((row) => row.workerId))].sort().map((workerId) => {
    const found = rows.filter((r) => r.workerId === workerId);
    return {
      workerId,
      label: found[0]!.label,
      issueIds: [...new Set(found.map((r) => r.issueId))].sort(),
      wallTimeMs: sumKnown(found.map((r) => r.wallTimeMs)),
      reportedTokens: sumKnown(found.map((r) => r.reportedTokens)),
      usageReports: found.reduce((n, r) => n + r.usageReports, 0),
      fullCheckRuns: sumKnown(found.map((r) => r.fullCheckRuns)),
      reviewRounds: sumKnown(found.map((r) => r.reviewRounds)),
      reworkRounds: sumKnown(found.map((r) => r.reworkRounds)),
    };
  });
  return IssueMetricsReportSchema.parse({
    schemaVersion: 1,
    window: { since, until },
    issues,
    workers,
    coverage: {
      tokens:
        "Provider-reported native worker responses (including cached input); Codex response IDs and Claude message IDs deduplicated. Native subagents, missing/legacy usage are not allocated. Report-handling lead turns with mixed/ambiguous retained inbound issue references are excluded; other work in their context is unknown. leadReportedTokens counts only uniquely linked settled report-handling turns, separately.",
      wallTime:
        "Assignment to explicit approval in the worker's native user messages; elapsed time includes waits. Window selects approval time, or latest observation for unfinished work. Worker sums can overlap; issue wall time is the envelope.",
      fullChecks:
        "Observed worker command launches of full pnpm check (shell/literal Python subprocess forms). Partial counts exclude unrecognized wrappers, native children and lead batch checks; no log/prose mentions counted.",
      reviews:
        "Explicit native review requests and approvals; rework counts explicit requests for fixes. Seat ledger passed/ship events are observations, never issue acceptance. Hire receipts retain unresolved attempts only; absence is not historical proof of delivery.",
      warnings: [...new Set(warnings)],
    },
  });
}
