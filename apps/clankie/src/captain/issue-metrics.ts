import {
  InboundReportReferenceSchema,
  decodeInboundReportShard,
} from "./conversations/inbound-report-store.ts";
import { isDeepStrictEqual } from "node:util";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
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
const identifiers = (text: string) => [...new Set(text.match(/\b(?:LOCAL-)?[A-Z][A-Z0-9]*-\d+\b/gu) ?? [])];
type WorkerBase = IssueMetricsReport["issues"][number]["workers"][number];
type Worker = WorkerBase &
  Required<
    Pick<
      WorkerBase,
      "landedAt" | "wallTimeToLandedMs" | "workerWaitMs" | "waitCount" | "exchanges" | "reviewChangeRequests"
    >
  >;
type Episode = Worker & { issueId: string; lastAt: string; source: string };
type NativeRecord = {
  at: string;
  id: string;
  prompt?: string;
  tokens?: number;
  commands?: string[];
  report?: boolean;
  landed?: boolean;
  pushResultFor?: string;
  busy?: [string, string];
  activity?: "assistant" | "user" | "channel";
  verdict?: "approve" | "changes";
  inbound?: string[];
  brief?: boolean;
};
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
  projectId?: string;
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

function commandClauses(command: string): string[] {
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
  return clauses;
}

function fullChecks(command: string): number {
  const shell = commandClauses(command).filter((clause) =>
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
    const id = String(
      entry.uuid ?? payload.call_id ?? payload.response_id ?? entry.ordinal ?? `${at}:${lineId}`,
    );
    if (
      harness === "claude" &&
      entry.type === "system" &&
      entry.subtype === "turn_duration" &&
      typeof entry.durationMs === "number" &&
      entry.durationMs >= 0
    )
      records.push({ at, id, busy: [new Date(Date.parse(at) - entry.durationMs).toISOString(), at] });
    if (
      (harness === "claude" && ["user", "assistant"].includes(String(entry.type))) ||
      (harness === "codex" &&
        entry.type === "response_item" &&
        payload.type === "message" &&
        ["user", "assistant"].includes(String(payload.role)))
    ) {
      const text =
        typeof payload.content === "string"
          ? payload.content
          : Array.isArray(payload.content)
            ? payload.content
                .map((p) => obj(p).text)
                .filter((v) => typeof v === "string")
                .join("\n")
            : "";
      const channel =
        /<channel source="(?:plugin:clankie-worker|clankie)/u.test(text) || text.startsWith("[Lead message #");
      records.push({
        at,
        id: `activity:${id}`,
        activity: payload.role === "assistant" ? "assistant" : channel ? "channel" : "user",
      });
    }
    // Lead inbox events may arrive between model calls in queued attachments.
    const inboundText =
      harness === "claude" && entry.type === "attachment"
        ? obj(entry.attachment).prompt
        : payload.role === "user"
          ? payload.content
          : undefined;
    if (typeof inboundText === "string") {
      const inbound = [...inboundText.matchAll(/<channel\s+[^>]*event_id="([^"]+)"[^>]*>/gu)].map(
        (m) => m[1]!,
      );
      if (inbound.length) records.push({ at, id: `inbound:${id}`, inbound });
    }
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
    const outputs: { callId: string; text: unknown }[] =
      harness === "codex" &&
      ["function_call_output", "custom_tool_call_output"].includes(String(payload.type))
        ? [{ callId: String(payload.call_id), text: payload.output }]
        : harness === "claude" && Array.isArray(payload.content)
          ? payload.content
              .filter((p) => obj(p).type === "tool_result" && obj(p).is_error !== true)
              .map((p) => ({ callId: String(obj(p).tool_use_id), text: obj(p).content }))
          : [];
    for (const output of outputs) {
      let text = output.text;
      if (typeof text !== "string") continue;
      try {
        const parsed = obj(JSON.parse(text));
        if (typeof parsed.output === "string") text = parsed.output;
      } catch {
        /* Plain native output. */
      }
      if (/^\s+[a-f0-9]{7,40}\.\.[a-f0-9]{7,40}\s+\S+\s+->\s+main\s*$/mu.test(String(text)))
        records.push({ at, id: `landed:${id}:${output.callId}`, landed: true, pushResultFor: output.callId });
    }
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
      if (text.trim() && !used.has(`prompt:${at}:${text}`)) {
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
            if (String(tool.name).endsWith("review_verdict")) {
              const decision = String(input.verdict ?? input.decision ?? input.outcome ?? "");
              if (/^(approve|approved|pass|ship|accept)/iu.test(decision))
                records.push({ at, id: String(tool.id), verdict: "approve" });
              else if (/^(changes|request|reject|fix|rework|block)/iu.test(decision))
                records.push({ at, id: String(tool.id), verdict: "changes" });
            }
            if (String(tool.name).endsWith("message_clankie"))
              records.push({ at, id: String(tool.id), report: true });
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
      if (String(payload.name).endsWith("review_verdict")) {
        try {
          const input = obj(JSON.parse(String(payload.arguments)));
          const decision = String(input.verdict ?? input.decision ?? input.outcome ?? "");
          if (/^(approve|approved|pass|ship|accept)/iu.test(decision))
            records.push({ at, id: `verdict:${id}`, verdict: "approve" });
          else if (/^(changes|request|reject|fix|rework|block)/iu.test(decision))
            records.push({ at, id: `verdict:${id}`, verdict: "changes" });
        } catch {
          /* Invalid native arguments are not a verdict. */
        }
      }
      records.push({
        at,
        id,
        commands: commands(payload.arguments ?? payload.input, payload.name),
        ...(String(payload.name).endsWith("message_clankie") ? { report: true } : {}),
      });
    }
  }
  records.push(...claudeUsage.values());
  return records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function assignedIssue(text: string): string | undefined {
  return (
    text.match(/^Review request [\s\S]*?\bIssue:\s*((?:LOCAL-)?[A-Z][A-Z0-9]*-\d+)\b/u)?.[1] ??
    text.match(/^(?:You own Linear|You own|Implement|Fix)\s+([A-Z][A-Z0-9]*-\d+)\b/u)?.[1] ??
    text.match(/\bNext for you:\s*([A-Z][A-Z0-9]*-\d+)\b/u)?.[1] ??
    (/^(?:You're|You are|Your (?:task|assignment)|(?:Implement|Fix|Investigate|Take|Own)\b)/u.test(text) &&
    !/standing reviewer/iu.test(text.slice(0, 500))
      ? identifiers(text.slice(0, 1000))[0]
      : undefined)
  );
}

/** Stream exact retained bindings, retaining measurements rather than multi-megabyte
 * tool outputs. Budgets bound the projection; old histories cannot consume it. */
async function projectNative(
  path: string,
  harness: "codex" | "claude",
  sessionId: string | undefined,
  stateDir: string,
  warnings: string[],
): Promise<NativeRecord[]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = nativeLines(stream);
  const pushes = new Set<string>();
  const records = new Map<string, NativeRecord>();
  let scanned = 0;
  let retained = 0;
  try {
    for await (const line of lines) {
      scanned += Buffer.byteLength(line) + 1;
      if (scanned > 2 * 1024 ** 3) throw new Error("Native scan exceeds 2 GiB");
      for (const row of nativeRecords(line, harness, sessionId)) {
        if (
          row.commands?.some((c) =>
            commandClauses(c).some((clause) =>
              /^\s*git\s+push\s+(?:origin\s+)?(?:HEAD(?::main)?|main)(?:\s|$)/u.test(clause),
            ),
          )
        )
          pushes.add(row.id);
        if (row.landed && !pushes.has(row.pushResultFor ?? "")) continue;
        if (row.prompt) {
          // Only the service-owned brief named by a native user assignment can
          // supply a brief. Never follow arbitrary paths or tool-result mentions.
          const ref = row.prompt.match(
            /^Execute the assignment in the clankieBrief JSON field of @([^\n]+)$/u,
          )?.[1];
          if (ref) {
            row.brief = true;
            const name = basename(ref);
            const directory = await realpath(join(stateDir, "claude-briefs")).catch(() =>
              join(stateDir, "claude-briefs"),
            );
            if (ref === join(directory, name) && /^clankie-brief-[a-f0-9-]+\.json$/u.test(name)) {
              try {
                if ((await stat(ref)).size > 1024 * 1024) throw new Error("Brief exceeds 1 MiB");
                const brief = obj(JSON.parse(await readFile(ref, "utf8")));
                if (typeof brief.clankieBrief === "string") row.prompt = brief.clankieBrief;
              } catch {
                warnings.push(`Saved assignment brief unavailable: ${name}`);
              }
            } else warnings.push(`Saved assignment brief outside retained directory: ${name}`);
          }
        }
        const key =
          row.tokens !== undefined
            ? `usage:${row.id}`
            : row.prompt !== undefined
              ? `prompt:${row.at}:${row.prompt}`
              : `${row.id}:${row.landed ?? false}:${row.verdict ?? ""}`;
        retained += Buffer.byteLength(JSON.stringify(row));
        if (retained > MAX_SOURCE_BYTES) throw new Error("Native projection exceeds 64 MiB");
        records.set(key, row);
      }
    }
    return [...records.values()].sort((a, b) => a.at.localeCompare(b.at));
  } finally {
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
  let previousActivity: NativeRecord | undefined;
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
          active.reviewChangeRequests++;
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
          landedAt: null,
          wallTimeToLandedMs: null,
          workerWaitMs: 0,
          waitCount: 0,
          exchanges: 0,
          reviewChangeRequests: 0,
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
    if (record.activity) {
      if (active && record.activity === "channel") {
        active.exchanges++;
        if (previousActivity?.activity === "assistant") {
          active.workerWaitMs += Math.max(0, Date.parse(record.at) - Date.parse(previousActivity.at));
          active.waitCount++;
        }
      }
      previousActivity = record;
    }
    if (!active || record.at < active.startedAt) continue;
    if (record.report) active.exchanges++;
    if (record.verdict) {
      active.reviewRounds = (active.reviewRounds ?? 0) + 1;
      if (record.verdict === "changes") {
        active.reviewChangeRequests++;
        active.reworkRounds = (active.reworkRounds ?? 0) + 1;
      }
    }
    if (record.landed && active.landedAt === null) {
      active.landedAt = record.at;
      active.wallTimeToLandedMs = Math.max(0, Date.parse(record.at) - Date.parse(active.startedAt));
    }
    if (active.acceptedAt !== null) continue;
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
  current?: NonNullable<IssueMetricsReport["summary"]>["current"],
): Promise<IssueMetricsReport> {
  const query = IssueMetricsQuerySchema.parse(input);
  const until = new Date(query.until ?? Date.now()).toISOString();
  const since = new Date(query.since ?? Date.parse(until) - 86_400_000).toISOString();
  if (Date.parse(since) >= Date.parse(until) || Date.parse(until) - Date.parse(since) > 366 * 86_400_000)
    throw new RangeError("Metrics window must be positive and at most 366 days");
  const warnings: string[] = [];
  const missingHistories: NonNullable<IssueMetricsReport["coverage"]["missingHistories"]> = [];
  let bytesRead = 0;
  let scanBytes = 0;
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
      const metadata = JSON.parse(raw ?? "null");
      if (metadata?.inboundReportStore !== undefined) {
        const reference = InboundReportReferenceSchema.parse(metadata.inboundReportStore);
        const entries = { ...metadata.inboundAcceptances };
        for (const [prefix, file] of Object.entries(reference.shards)) {
          const body = await read(join(stateDir, "conversations", entry.name, "inbound-reports", file));
          if (body === undefined) throw new Error("Retained report shard unavailable");
          for (const [id, receipt] of Object.entries(decodeInboundReportShard(prefix, file, body))) {
            if (entries[id] !== undefined && !isDeepStrictEqual(entries[id], receipt))
              throw new Error("Conflicting retained report identity");
            entries[id] = receipt;
          }
        }
        metadata.inboundAcceptances = entries;
      }
      const parsed = MetaSchema.safeParse(metadata);
      if (parsed.success) metas.push(parsed.data);
      else if (raw) warnings.push(`Unsupported conversation metadata: ${entry.name}`);
    } catch {
      warnings.push(`Invalid conversation metadata: ${entry.name}`);
    }
  }
  const all: Episode[] = [];
  const sessions: NonNullable<IssueMetricsReport["sessions"]> = [];
  const leadBusy: [number, number][] = [];
  const settledBusy: [number, number][] = [];
  const inbox = new Map<string, string>();
  const leadSessionIds = new Set<string>();
  const leadRefs = new Set(
    metas
      .filter((m) => m.nativeSource && ["global", "project"].includes(m.scope?.kind ?? ""))
      .map((m) => m.nativeSource!.session.value),
  );
  const bindings: MetricsBinding[] = [];
  const seatLabels = new Map<string, string>();
  for (const meta of metas)
    if (meta.scope?.kind === "seat" && meta.scope.seatId) seatLabels.set(meta.scope.seatId, meta.title);
  const bind = (
    native: NativeSource,
    label: string,
    priority: number,
    owner?: string,
    projectId?: string,
  ) => {
    bindings.push({
      native,
      label,
      priority,
      ...(projectId ? { projectId } : {}),
      ...(owner === undefined ? {} : { owner }),
      aliases: new Set([native.terminalId, label, native.session.value]),
    });
  };
  const relaunch = await read(join(stateDir, "lead-seat-relaunches.json"));
  if (relaunch) {
    try {
      const journal = obj(JSON.parse(relaunch));
      if (Array.isArray(journal.receipts))
        for (const value of journal.receipts) {
          const receipt = obj(value);
          for (const [field, launch] of [
            ["previousSessionId", "from"],
            ["sessionId", "to"],
          ] as const) {
            const id = receipt[field];
            const harness = obj(receipt[launch]).harness;
            if (
              typeof id !== "string" ||
              !SESSION_UUID.test(id) ||
              !["claude", "codex"].includes(String(harness)) ||
              typeof receipt.paneId !== "string" ||
              typeof receipt.seatId !== "string"
            )
              continue;
            leadRefs.add(id);
            bind(
              {
                terminalId: receipt.seatId,
                paneId: receipt.paneId,
                agent: harness as "claude" | "codex",
                session: { source: `herdr:${harness}`, kind: "id", value: id },
              },
              "Lead",
              0,
            );
          }
        }
    } catch {
      warnings.push("Invalid retained lead relaunch history");
    }
  }
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
        if (query.project !== undefined && hire.hireProjectId !== query.project) continue;
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
          missingHistories.push({
            machine: fleet,
            workerId: hire.seatId,
            harness: agent,
            nativeSessionId: value,
            reason: "remote_not_collected",
          });
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
          hire.hireProjectId,
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
      missingHistories.push({
        machine: native.paneId.split("/")[0]!,
        workerId: native.terminalId,
        harness: native.agent,
        nativeSessionId: native.session.value,
        reason: "remote_not_collected",
      });
      warnings.push(`Remote native history unavailable: ${native.terminalId}`);
      continue;
    }
    const path = await resolveHerdrSeatTranscriptPathAsync(native.agent, native.session);
    if (!path) {
      missingHistories.push({
        machine: "local",
        workerId: native.terminalId,
        harness: native.agent,
        nativeSessionId: native.session.value,
        reason: "not_found_or_ambiguous",
      });
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
  for (const [key, group] of [...groups].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)) {
    if (ambiguousFiles.has(key) || group.mtimeMs < Date.parse(since)) continue;
    const found = group.bindings.sort((a, b) => b.priority - a.priority);
    const primary = found[0]!;
    const isLeadSource = found.some((b) => leadRefs.has(b.native.session.value));
    if (query.project !== undefined && !isLeadSource && !found.some((b) => b.projectId === query.project))
      continue;
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
    let records: NativeRecord[];
    try {
      if (group.size > 2 * 1024 ** 3) throw new Error("Native scan exceeds 2 GiB");
      if (scanBytes + group.size > 16 * 1024 ** 3) throw new Error("Request scan exceeds 16 GiB");
      scanBytes += group.size;
      records = await projectNative(path, native.agent, sessionId, stateDir, warnings);
    } catch (error) {
      warnings.push(
        `Native history scan unavailable: ${native.terminalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (
      query.issue !== undefined &&
      !records.some((r) => r.prompt && assignedIssue(r.prompt) === query.issue)
    )
      continue;
    const projectedBytes = Buffer.byteLength(JSON.stringify(records));
    if (bytesRead + projectedBytes > MAX_REQUEST_BYTES) {
      warnings.push(`256 MiB request projection budget exhausted: ${native.terminalId}`);
      continue;
    }
    bytesRead += projectedBytes;
    const activities = records.filter((r) => r.activity);
    const first = activities[0];
    const last = activities.at(-1);
    const isLead = found.some((b) => leadRefs.has(b.native.session.value));
    if (isLead) {
      leadSessionIds.add(sessionId ?? native.session.value);
      for (const row of records) {
        if (row.busy) leadBusy.push([Date.parse(row.busy[0]), Date.parse(row.busy[1])]);
        if (row.at >= since && row.at < until)
          for (const id of row.inbound ?? []) if (!inbox.has(id)) inbox.set(id, row.at.slice(0, 10));
      }
    } else if (first && last && last.at >= since && first.at < until) {
      const wait = activities.flatMap((r, i) =>
        r.activity === "channel" && activities[i - 1]?.activity === "assistant"
          ? [Math.max(0, Date.parse(r.at) - Date.parse(activities[i - 1]!.at))]
          : [],
      );
      sessions.push({
        workerId: native.terminalId,
        nativeSessionId: sessionId ?? native.session.value,
        harness: native.agent,
        hired:
          native.agent === "claude"
            ? records.find((r) => r.prompt !== undefined)?.brief === true
            : found.some((b) => b.owner !== undefined),
        startedAt: first.at,
        lastAt: last.at,
        observedWallTimeMs: Math.max(0, Date.parse(last.at) - Date.parse(first.at)),
        workerWaitMs: wait.reduce((n, v) => n + v, 0),
        waitCount: wait.length,
        exchanges:
          activities.filter((r) => r.activity === "channel").length + records.filter((r) => r.report).length,
        reviewVerdicts: records.filter((r) => r.verdict).length,
        reviewChangeRequests: records.filter((r) => r.verdict === "changes").length,
      });
    }
    sourceSessions.set(
      key,
      new Set([
        ...found.map((binding) => binding.native.session.value),
        ...(sessionId === undefined ? [] : [sessionId]),
      ]),
    );
    if (!isLead) all.push(...episodes(records, native.terminalId, primary.label, native.session.value, key));
  }
  const rows = all.filter(
    (row) =>
      (row.landedAt ?? row.acceptedAt ?? row.lastAt) >= since &&
      (row.landedAt ?? row.acceptedAt ?? row.lastAt) < until &&
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
      const end = metric.completedAt ?? metric.failedAt;
      if (metric.lane === "operator" && end)
        settledBusy.push([Date.parse(metric.acceptedAt), Date.parse(end)]);
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
      landedAt:
        found
          .flatMap((r) => (r.landedAt ? [r.landedAt] : []))
          .sort()
          .at(-1) ?? null,
      wallTimeToLandedMs: found.some((r) => r.landedAt !== null)
        ? Math.max(
            0,
            Math.max(...found.flatMap((r) => (r.landedAt ? [Date.parse(r.landedAt)] : []))) -
              Date.parse(startedAt),
          )
        : null,
      workerWaitMs: found.reduce((n, r) => n + r.workerWaitMs, 0),
      waitCount: found.reduce((n, r) => n + r.waitCount, 0),
      exchanges: found.reduce((n, r) => n + r.exchanges, 0),
      reviewChangeRequests: found.reduce((n, r) => n + r.reviewChangeRequests, 0),
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
  const selectedSessions =
    query.issue === undefined
      ? sessions
      : sessions.filter((s) => rows.some((r) => r.nativeSessionId === s.nativeSessionId));
  const hired = selectedSessions.filter((s) => s.hired);
  const total = (
    key:
      | "observedWallTimeMs"
      | "workerWaitMs"
      | "waitCount"
      | "exchanges"
      | "reviewVerdicts"
      | "reviewChangeRequests",
  ) => hired.reduce((n, s) => n + s[key], 0);
  const nativeBusyMs = unionDuration(leadBusy, Date.parse(since), Date.parse(until));
  const settledBusyMs = unionDuration(settledBusy, Date.parse(since), Date.parse(until));
  const busyMs = nativeBusyMs;
  const busyKnown = leadBusy.length > 0;
  const perDay = new Map<string, number>();
  for (let day = Date.parse(since.slice(0, 10)); day < Date.parse(until); day += 86_400_000)
    perDay.set(new Date(day).toISOString().slice(0, 10), 0);
  for (const day of inbox.values()) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  return IssueMetricsReportSchema.parse({
    schemaVersion: 1,
    window: { since, until },
    issues,
    workers,
    sessions: selectedSessions,
    summary: {
      workerSessions: hired.length,
      observedWorkerWallTimeMs: total("observedWallTimeMs"),
      workerWaitMs: total("workerWaitMs"),
      workerWaitShare: total("observedWallTimeMs")
        ? total("workerWaitMs") / total("observedWallTimeMs")
        : null,
      waitCount: total("waitCount"),
      waitsPerSession: hired.length ? total("waitCount") / hired.length : null,
      exchanges: total("exchanges"),
      exchangesPerTask: rows.length ? rows.reduce((n, r) => n + r.exchanges, 0) / rows.length : null,
      reviewVerdicts: total("reviewVerdicts"),
      reviewChangeRequests: total("reviewChangeRequests"),
      reviewChangeRate: total("reviewVerdicts")
        ? total("reviewChangeRequests") / total("reviewVerdicts")
        : null,
      leadNativeBusyMs: leadBusy.length ? nativeBusyMs : null,
      leadSettledElapsedMs: settledBusy.length ? settledBusyMs : null,
      leadBusyMs: busyKnown ? busyMs : null,
      leadBusyFraction: busyKnown ? busyMs / (Date.parse(until) - Date.parse(since)) : null,
      leadNativeSessions: leadSessionIds.size,
      leadInboxVolumePerDay: [...perDay].map(([day, count]) => ({ day, count })),
      current: current ?? {
        observedAt: new Date().toISOString(),
        inProgressCount: null,
        liveSeats: null,
        warnings: ["Live tracker and fleet observation unavailable"],
      },
    },
    coverage: {
      missingHistories: [...new Map(missingHistories.map((r) => [JSON.stringify(r), r])).values()],
      tokens:
        "Provider-reported native worker responses (including cached input); Codex response IDs and Claude message IDs deduplicated. Native subagents, missing/legacy usage are not allocated. Report-handling lead turns with mixed/ambiguous retained inbound issue references are excluded; other work in their context is unknown. leadReportedTokens counts only uniquely linked settled report-handling turns, separately.",
      wallTime:
        "Assignment to explicit approval in the worker's native user messages; elapsed time includes waits. Window selects observed landing, otherwise approval time, or latest observation for unfinished work. Worker sums can overlap; issue wall time is the envelope.",
      fullChecks:
        "Observed worker command launches of full pnpm check (shell/literal Python subprocess forms). Partial counts exclude unrecognized wrappers, native children and lead batch checks; no log/prose mentions counted.",
      reviews:
        "Explicit native review requests and approvals; rework counts explicit requests for fixes. Seat ledger passed/ship events are observations, never issue acceptance. Hire receipts retain unresolved attempts only; absence is not historical proof of delivery.",
      efficiency:
        "Waits use the review baseline: a native assistant event immediately followed by a Clankie channel user message; all intervening user/tool-result events break the wait. Includes legitimate end-of-task pauses. Session totals cover whole retained sessions overlapping the window; issue totals cover assigned episodes. Exchanges count channel messages plus observed message_clankie calls, not delivery receipts. Review change rate uses structured review_verdict decisions, including standing reviewer sessions without a task assignment. Landed means an observed successful native git push fast-forward to main, not approval or tracker Done. Lead busy is the union of retained native turn_duration intervals clipped to the query window, following the review baseline. Settled operator elapsed time is reported separately, since it includes blocked and failed turns and does not establish native activity; retained relaunch bindings may omit older lead sessions. Inbox counts unique native channel event IDs per UTC day. Missing PC histories and unbound sessions are excluded; this is measured coverage, not a complete census.",
      warnings: [...new Set(warnings)],
    },
  });
}

function unionDuration(intervals: [number, number][], since: number, until: number): number {
  let end = since;
  let total = 0;
  for (const [a, b] of intervals.sort((a, b) => a[0] - b[0])) {
    const start = Math.max(since, a, end);
    const stop = Math.min(until, b);
    if (stop > start) {
      total += stop - start;
      end = stop;
    }
  }
  return total;
}

/** Bound a malformed or image-heavy single JSONL row before readline could
 * accumulate the entire file in memory. */
async function* nativeLines(stream: ReturnType<typeof createReadStream>): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of stream) {
    pending += String(chunk);
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      if (end > 16 * 1024 * 1024) throw new Error("Native row exceeds 16 MiB");
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
    if (pending.length > 16 * 1024 * 1024) throw new Error("Native row exceeds 16 MiB");
  }
  if (pending) yield pending;
}
