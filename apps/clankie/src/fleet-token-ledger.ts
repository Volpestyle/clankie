import { constants } from "node:fs";
import { finished } from "node:stream/promises";
import { glob, lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { claudeProfileHomes } from "@clankie/agent-hosts";
import {
  FleetUsageQuerySchema,
  FleetUsageReportSchema,
  type FleetUsageQuery,
  type FleetUsageReport,
} from "@clankie/protocol/worker-accounts";
import { readFleet, type ObservedFleet } from "./captain/herdr-census.ts";

type Harness = "claude" | "codex";
type Seat = FleetUsageReport["seats"][number];
type Binding = Pick<Seat, "role" | "roleSource"> & { seatId?: string };
type Call = { seatKey: string; at: string; context: number };
type Event = { seatKey: string; at: string; kind: "compactions" | "foregroundSleepCalls" };
const obj = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const str = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
const DAY = 86_400_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export interface FleetTokenLedgerOptions {
  /** Explicit native roots and state for isolated proofs; production uses the body's own homes. */
  profiles?: readonly { harness: Harness; home: string }[];
  stateDir?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  census?: () => Promise<ObservedFleet>;
}

/** Split executable shell clauses without turning quoted text, comments or heredocs into waits. */
function shellSleep(source: string): boolean {
  let clause = "";
  let quote = "";
  let heredoc: string | undefined;
  const check = (background = false) => {
    const command = clause.trim();
    clause = "";
    if (background) return false;
    return /^(?:(?:do|then|else|if|while|until)\s+)?(?:command\s+)?sleep\s+(?!-)[^;|&]+/u.test(command);
  };
  for (const line of source.split("\n")) {
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const delimiter = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/u.exec(line);
    for (let index = 0; index < line.length; index++) {
      const char = line[index]!;
      if (char === "\\" && quote !== "'") {
        clause += char + (line[++index] ?? "");
        continue;
      }
      if (quote) {
        clause += char;
        if (char === quote) quote = "";
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        clause += char;
        continue;
      }
      if (char === "#" && (index === 0 || /\s/u.test(line[index - 1]!))) break;
      if (char === ";" || char === "|" || char === "&") {
        const doubled = line[index + 1] === char;
        if (check(char === "&" && !doubled)) return true;
        if (doubled) index++;
      } else clause += char;
    }
    if (!quote) {
      if (check()) return true;
      if (delimiter) heredoc = delimiter[1] ?? delimiter[2] ?? delimiter[3];
    } else clause += "\n";
  }
  return check();
}

/** A recorded code-mode call site must be outside JavaScript strings and comments. */
function executableAt(source: string, end: number): boolean {
  let quote = "";
  let comment = "";
  for (let index = 0; index < end; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    if (comment === "line") {
      if (char === "\n") comment = "";
      continue;
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        comment = "";
        index++;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      comment = "line";
      index++;
    } else if (char === "/" && next === "*") {
      comment = "block";
      index++;
    } else if (char === "'" || char === '"' || char === "`") quote = char;
  }
  return !quote && !comment;
}

/** Literal native shell/tool invocations only. Source and model text are never evaluated. */
function foregroundSleep(name: unknown, input: unknown): boolean {
  const tool = String(name).replace(/^(?:functions|tools)\./u, "");
  if (["sleep", "clock.sleep"].includes(tool)) return true;
  const args = obj(input);
  if (args.run_in_background === true || args.background === true) return false;
  const command =
    typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : undefined;
  if (["Bash", "bash", "shell", "shell_command", "exec_command"].includes(tool))
    return command !== undefined && shellSleep(command);
  if (tool !== "exec" || typeof input !== "string") return false;
  // Code mode's recorded exec_command JSON/string literal; no interpolated command is a count.
  for (const match of input.matchAll(
    /\btools\.exec_command\s*\(\s*\{[^}]*?(?:\b(?:cmd|command)|"(?:cmd|command)")\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu,
  )) {
    if (!executableAt(input, match.index!)) continue;
    try {
      const literal = match[1]!;
      const value: unknown = literal.startsWith('"')
        ? JSON.parse(literal)
        : literal.slice(1, -1).replaceAll("\\'", "'").replaceAll("\\\\", "\\");
      const suffix = input.slice(match.index!, input.indexOf("}", match.index!) + 1);
      if (
        typeof value === "string" &&
        !/(?:\brun_in_background|"run_in_background")\s*:\s*true\b/u.test(suffix) &&
        shellSleep(value)
      )
        return true;
    } catch {
      /* Unsupported literal stays uncounted. */
    }
  }
  return false;
}

async function profiles(
  options: FleetTokenLedgerOptions,
): Promise<readonly { harness: Harness; home: string }[]> {
  if (options.profiles) return options.profiles;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const names = await readdir(home, { withFileTypes: true });
  return [
    ...claudeProfileHomes(env, home).map((home) => ({ harness: "claude" as const, home })),
    ...new Set([
      env.CODEX_HOME?.trim() || join(home, ".codex"),
      join(home, ".codex"),
      ...names
        .filter(
          (entry) => entry.name.startsWith(".codex-") && (entry.isDirectory() || entry.isSymbolicLink()),
        )
        .map((entry) => join(home, entry.name)),
    ]),
  ].map((value) => (typeof value === "string" ? { harness: "codex" as const, home: value } : value));
}

async function bindings(options: FleetTokenLedgerOptions, warnings: string[]): Promise<Map<string, Binding>> {
  const result = new Map<string, Binding>();
  const state =
    options.stateDir ??
    join(
      resolve(
        (options.env ?? process.env).CLANKIE_STATE?.trim() || join(options.home ?? homedir(), ".clankie"),
      ),
      "captain",
    );
  const journal = async (name: string) => {
    try {
      return obj(JSON.parse(await readFile(join(state, name), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`Unreadable attribution journal: ${name}`);
      return {};
    }
  };
  const hires = await journal("herdr-watches.json.owners.json");
  for (const raw of Array.isArray(hires.hires) ? hires.hires : []) {
    const hire = obj(raw);
    try {
      const [fleet, harness, session]: unknown[] = JSON.parse(String(hire.sessionKey));
      if (
        fleet === "local" &&
        ["claude", "codex"].includes(String(harness)) &&
        typeof session === "string" &&
        UUID.test(session)
      )
        result.set(`${harness}:${session}`, {
          role: "worker",
          roleSource: "hire-journal",
          ...(str(hire.seatId) ? { seatId: str(hire.seatId)! } : {}),
        });
    } catch {
      /* A startup intent without native identity cannot attribute spend. */
    }
  }
  const leads = await journal("lead-seat-relaunches.json");
  for (const raw of Array.isArray(leads.receipts) ? leads.receipts : []) {
    const receipt = obj(raw);
    for (const [session, harness] of [
      [receipt.previousSessionId, obj(receipt.from).harness],
      [receipt.sessionId, obj(receipt.to).harness],
    ])
      if (typeof session === "string" && UUID.test(session) && ["claude", "codex"].includes(String(harness)))
        result.set(`${harness}:${session}`, { role: "lead", roleSource: "lead-relaunch-journal" });
  }
  try {
    const fleet = await (options.census ?? readFleet)();
    for (const seat of [...fleet.seats, ...(fleet.head ? [fleet.head] : [])]) {
      if (!seat.session || seat.session.kind !== "id") continue;
      const key = `${seat.harness}:${seat.session.value}`;
      const lead = fleet.head?.occupantId === seat.occupantId;
      const previous = result.get(key);
      result.set(key, {
        role: lead ? "lead" : (previous?.role ?? "unknown"),
        roleSource: lead ? "native-census" : (previous?.roleSource ?? "unattributed"),
        seatId: seat.seatId,
      });
    }
    if (fleet.unavailable) warnings.push("Native census unavailable; retained attribution only");
  } catch {
    warnings.push("Native census unavailable; retained attribution only");
  }
  return result;
}

/** One on-demand streamed native read, including child transcripts, deduped by native message/response ID. */
export async function readFleetTokenLedger(
  input: FleetUsageQuery = {},
  options: FleetTokenLedgerOptions = {},
): Promise<FleetUsageReport> {
  const query = FleetUsageQuerySchema.parse(input);
  const now = (options.now ?? Date.now)();
  const until = new Date(query.until ?? now).toISOString();
  const since = new Date(query.since ?? Date.parse(until) - (query.days ?? 7) * DAY).toISOString();
  if (since >= until || Date.parse(until) - Date.parse(since) > 366 * DAY)
    throw new RangeError("Fleet usage window must be positive and at most 366 days");
  const warnings: string[] = [];
  const attributed = await bindings(options, warnings);
  const seats = new Map<string, Omit<Seat, "days" | "totals">>();
  const calls = new Map<string, Call>();
  const snapshotResponses = new Map<string, Set<string>>();
  // Latest valid native usage wins. Equal-time streaming fragments retain the
  // largest context; a stable seat key resolves otherwise identical retained copies.
  const recordCall = (id: string, call: Call) => {
    const previous = calls.get(id);
    if (
      !previous ||
      call.at > previous.at ||
      (call.at === previous.at &&
        (call.context > previous.context ||
          (call.context === previous.context && call.seatKey < previous.seatKey)))
    )
      calls.set(id, call);
  };
  const events = new Map<string, Event>();
  const visitedRoots = new Set<string>();
  const visitedFiles = new Set<string>();
  let filesRead = 0;
  let bytesRead = 0;
  for (const profile of await profiles(options)) {
    const directory = join(profile.home, profile.harness === "claude" ? "projects" : "sessions");
    let root: string;
    try {
      root = await realpath(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`Unreadable native ${profile.harness} profile: ${basename(profile.home)}`);
      continue;
    }
    if (visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    for await (const relative of glob("**/*.jsonl", { cwd: root })) {
      const path = join(root, relative);
      const meta = await lstat(path).catch(() => {
        warnings.push(`Unreadable native transcript metadata: ${basename(path)}`);
        return undefined;
      });
      if (!meta?.isFile() || meta.mtimeMs < Date.parse(since)) continue;
      const inode = `${meta.dev}:${meta.ino}`;
      if (visitedFiles.has(inode)) continue;
      visitedFiles.add(inode);
      let handle;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        warnings.push(`Unreadable native transcript: ${basename(path)}`);
        continue;
      }
      filesRead++;
      bytesRead += meta.size;
      let sessionId = "";
      let subagentId: string | undefined;
      let lastResponseId: string | undefined;
      let malformed = 0;
      const localEvents: [string, Event][] = [];
      const stream = handle.createReadStream({
        start: 0,
        end: Math.max(0, meta.size - 1),
      });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let entry: Record<string, unknown>;
          try {
            entry = obj(JSON.parse(line));
          } catch {
            malformed++;
            continue;
          }
          const payload = obj(entry.payload);
          if (profile.harness === "claude") {
            sessionId ||= str(entry.sessionId) ?? "";
            if (relative.split(/[\\/]/u).includes("subagents"))
              subagentId ||= str(entry.agentId) ?? basename(path, ".jsonl");
          } else if (entry.type === "session_meta") {
            sessionId ||= str(payload.id) ?? "";
            if (obj(obj(payload.source).subagent).thread_spawn !== undefined) subagentId = sessionId;
          }
          if (!sessionId) continue;
          if (profile.harness === "codex" && str(payload.thread_id) && payload.thread_id !== sessionId)
            continue;
          if (
            profile.harness === "claude" &&
            ((entry.sessionId !== undefined && entry.sessionId !== sessionId) ||
              (entry.isSidechain === true && subagentId === undefined))
          )
            continue;
          const seatKey = `${profile.harness}:${sessionId}${profile.harness === "claude" && subagentId ? `:agent:${subagentId}` : ""}`;
          const binding: Binding = subagentId
            ? { role: "subagent", roleSource: "native-subagent" }
            : (attributed.get(`${profile.harness}:${sessionId}`) ?? {
                role: "unknown",
                roleSource: "unattributed",
              });
          if (!seats.has(seatKey))
            seats.set(seatKey, {
              seatKey,
              sessionId,
              harness: profile.harness,
              ...binding,
              ...(subagentId ? { subagentId } : {}),
              budgetTokens: binding.role === "lead" ? 250_000 : 300_000,
            });
          // Response identity comes from the native record; context itself always comes from token_count.
          if (profile.harness === "codex" && entry.type === "token_usage_record")
            lastResponseId = str(payload.response_id);
          const at =
            typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))
              ? new Date(entry.timestamp).toISOString()
              : undefined;
          if (!at) continue;
          let messageId: string | undefined;
          let context: number | undefined;
          if (profile.harness === "claude" && entry.type === "assistant") {
            const message = obj(entry.message);
            const usage = obj(message.usage);
            const input = count(usage.input_tokens);
            const read =
              usage.cache_read_input_tokens === undefined ? 0 : count(usage.cache_read_input_tokens);
            const write =
              usage.cache_creation_input_tokens === undefined ? 0 : count(usage.cache_creation_input_tokens);
            messageId = str(message.id);
            if (input !== undefined && read !== undefined && write !== undefined)
              context = input + read + write;
          } else if (
            profile.harness === "codex" &&
            entry.type === "event_msg" &&
            payload.type === "token_count"
          ) {
            const info = obj(payload.info);
            context = count(obj(info.last_token_usage).input_tokens);
            // Older rollouts have no response record; repeated cumulative snapshots are the same native response.
            const total = obj(info.total_token_usage);
            const signature = Object.keys(total).length
              ? JSON.stringify(Object.entries(total).sort(([a], [b]) => a.localeCompare(b)))
              : undefined;
            const response = str(payload.response_id) ?? lastResponseId;
            const snapshot = signature === undefined ? undefined : `${sessionId}:snapshot:${signature}`;
            messageId = response ? `${sessionId}:response:${response}` : snapshot;
            if (snapshot && response) {
              const key = `codex:${snapshot}`;
              const responses = snapshotResponses.get(key) ?? new Set<string>();
              responses.add(`codex:${sessionId}:response:${response}`);
              snapshotResponses.set(key, responses);
            }
            lastResponseId = undefined;
          }
          if (messageId && context !== undefined && Number.isSafeInteger(context))
            recordCall(`${profile.harness}:${messageId}`, { seatKey, at, context });
          // Events belong to their own native timestamps; calls are windowed only
          // after all retained fragments and response/snapshot aliases are canonical.
          if (at < since || at >= until) continue;
          const compact =
            profile.harness === "claude"
              ? entry.type === "system" && entry.subtype === "compact_boundary"
              : entry.type === "compacted" ||
                (entry.type === "event_msg" &&
                  ["context_compacted", "compaction"].includes(String(payload.type)));
          if (compact)
            localEvents.push([
              `compact:${seatKey}:${str(entry.uuid) ?? at}`,
              { seatKey, at, kind: "compactions" },
            ]);
          const tools =
            profile.harness === "claude" &&
            entry.type === "assistant" &&
            Array.isArray(obj(entry.message).content)
              ? (obj(entry.message).content as unknown[])
              : profile.harness === "codex" &&
                  entry.type === "response_item" &&
                  ["function_call", "custom_tool_call"].includes(String(payload.type))
                ? [payload]
                : [];
          for (const raw of tools) {
            const tool = obj(raw);
            if (profile.harness === "claude" && tool.type !== "tool_use") continue;
            const id = str(tool.call_id) ?? str(tool.id);
            let args: unknown = tool.input;
            if (typeof tool.arguments === "string") {
              try {
                args = JSON.parse(tool.arguments);
              } catch {
                continue;
              }
            }
            if (id && foregroundSleep(tool.name, args))
              localEvents.push([
                `sleep:${profile.harness}:${id}`,
                { seatKey, at, kind: "foregroundSleepCalls" },
              ]);
          }
        }
        for (const [id, event] of localEvents) events.set(id, event);
        if (malformed > 0)
          warnings.push(`${basename(path)}: ${malformed} malformed or incomplete native lines skipped`);
      } catch {
        warnings.push(`Incomplete native transcript read: ${basename(path)}`);
      } finally {
        lines.close();
        stream.destroy();
        // FileHandle.createReadStream owns its descriptor, including error/early-close paths.
        // allow-swallowed-rejection -- read errors are reported above; explicit teardown can also reject with premature close.
        await finished(stream).catch(() => undefined);
      }
    }
  }
  // A retained older rollout may lack response_id for a snapshot that a newer
  // copy identifies. Merge it before interval assignment, independent of scan order.
  for (const [snapshot, responses] of snapshotResponses) {
    const call = calls.get(snapshot);
    if (!call) continue;
    if (responses.size === 1) recordCall(responses.values().next().value!, call);
    else warnings.push("Ambiguous Codex snapshot identity; explicit native response IDs retained");
    calls.delete(snapshot);
  }
  type Bucket = { contexts: number[]; above: number; compactions: number; foregroundSleepCalls: number };
  const buckets = new Map<string, Map<string, Bucket>>();
  const bucket = (key: string, day: string): Bucket => {
    let days = buckets.get(key);
    if (!days) {
      days = new Map();
      buckets.set(key, days);
    }
    let value = days.get(day);
    if (!value) {
      value = { contexts: [], above: 0, compactions: 0, foregroundSleepCalls: 0 };
      days.set(day, value);
    }
    return value;
  };
  for (const call of calls.values()) {
    if (call.at < since || call.at >= until) continue;
    const value = bucket(call.seatKey, call.at.slice(0, 10));
    value.contexts.push(call.context);
    if (call.context > seats.get(call.seatKey)!.budgetTokens) value.above += call.context;
  }
  for (const event of events.values()) bucket(event.seatKey, event.at.slice(0, 10))[event.kind]++;
  const metrics = (values: readonly Bucket[]) => {
    const contexts = values.flatMap((value) => value.contexts).sort((a, b) => a - b);
    const tokens = contexts.reduce((sum, value) => sum + value, 0);
    const above = values.reduce((sum, value) => sum + value.above, 0);
    const middle = Math.floor(contexts.length / 2);
    return {
      modelCalls: contexts.length,
      contextTokens: tokens,
      medianContextTokens:
        contexts.length === 0
          ? 0
          : contexts.length % 2
            ? contexts[middle]!
            : (contexts[middle - 1]! + contexts[middle]!) / 2,
      aboveBudgetContextTokens: above,
      above400KContextTokens: contexts
        .filter((context) => context > 400_000)
        .reduce((sum, context) => sum + context, 0),
      aboveBudgetTokenShare: tokens === 0 ? 0 : above / tokens,
      compactions: values.reduce((sum, value) => sum + value.compactions, 0),
      foregroundSleepCalls: values.reduce((sum, value) => sum + value.foregroundSleepCalls, 0),
    };
  };
  const all = [...buckets.values()].flatMap((days) => [...days.values()]);
  const rows = [...buckets]
    .map(([key, days]) => ({
      ...seats.get(key)!,
      totals: metrics([...days.values()]),
      days: [...days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, value]) => ({ day, ...metrics([value]) })),
    }))
    .sort((a, b) => b.totals.contextTokens - a.totals.contextTokens || a.seatKey.localeCompare(b.seatKey));
  if (rows.some((row) => row.role === "unknown"))
    warnings.push(
      "Unattributed historical sessions use the 300K worker review budget; their role is unknown",
    );
  return FleetUsageReportSchema.parse({
    schemaVersion: 1,
    source: "local-native-transcripts",
    observedAt: new Date(now).toISOString(),
    since,
    until,
    dayBoundary: "UTC",
    budgets: { lead: 250000, worker: 300000 },
    totals: metrics(all),
    seats: rows,
    sources: { filesRead, bytesRead },
    warnings:
      warnings.length <= 1000
        ? warnings
        : [...warnings.slice(0, 999), `${warnings.length - 999} additional warnings omitted`],
  });
}

/** Identical reads share one scan; ordinary account meters never trigger transcript work. */
export function createFleetTokenLedger(
  options: FleetTokenLedgerOptions = {},
): (query: FleetUsageQuery, refresh?: boolean) => Promise<FleetUsageReport> {
  const cache = new Map<string, { at: number; pending: Promise<FleetUsageReport> }>();
  return (query, refresh = false) => {
    const now = (options.now ?? Date.now)();
    const key = createHash("sha256").update(JSON.stringify(query)).digest("hex");
    const previous = cache.get(key);
    if (!refresh && previous && now - previous.at < 60_000) return previous.pending;
    const pending = readFleetTokenLedger(query, options);
    cache.set(key, { at: now, pending });
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    pending.catch(() => {
      if (cache.get(key)?.pending === pending) cache.delete(key);
    });
    return pending;
  };
}
