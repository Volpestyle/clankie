import { parseArgs } from "node:util";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  ROUTINES_PATH,
  RoutineCommandSchema,
  RoutinesStatusSchema,
  type Routine,
  type RoutineCommand,
  type RoutineRun,
  type RoutinesStatus,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";

const ROUTINES_USAGE = [
  "Usage: clankie routines [list] [--json]",
  "       clankie routines add NAME --when WHEN [--tz ZONE] [--missed catch_up|skip] [--paused] [--conversation ID]",
  "            (--turn PROMPT | --hire JSON --brief TEXT | --check --cwd DIR [--timeout SECONDS] [--report always|failure] -- COMMAND...)",
  "       clankie routines edit ID [--name NAME] [--when WHEN] [--tz ZONE] [--missed catch_up|skip]",
  "       clankie routines pause|resume|run-now|remove ID",
  "       clankie routines history [ID] [--limit N]",
  'WHEN is plain language ("every weekday at 9:00", "every friday at 17:30", "every 2 hours") or five cron fields.',
].join("\n");

/** Splits a typed `/routines …` line into words, honouring single and double quotes. */
export function splitRoutineWords(line: string): string[] {
  const words: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/gu;
  for (const match of line.matchAll(pattern))
    words.push(match[1]?.replace(/\\(.)/gu, "$1") ?? match[2] ?? match[3]!);
  return words;
}

/** Turns CLI words into one RoutineCommand. */
function parseRoutinesArgs(args: readonly string[]): { command: RoutineCommand; json: boolean } {
  const separator = args.indexOf("--");
  const argv = separator < 0 ? [...args] : args.slice(0, separator);
  const checkCommand = separator < 0 ? [] : args.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      when: { type: "string" },
      tz: { type: "string" },
      missed: { type: "string" },
      paused: { type: "boolean" },
      conversation: { type: "string" },
      turn: { type: "string" },
      hire: { type: "string" },
      brief: { type: "string" },
      check: { type: "boolean" },
      cwd: { type: "string" },
      timeout: { type: "string" },
      report: { type: "string" },
      name: { type: "string" },
      limit: { type: "string" },
    },
  });
  const [verb = "list", ...rest] = positionals;
  const schedule =
    values.when === undefined
      ? undefined
      : { when: values.when, ...(values.tz ? { timeZone: values.tz } : {}) };
  let input: unknown;
  switch (verb) {
    case "list":
      input = { action: "list" };
      break;
    case "add": {
      if (rest.length !== 1) throw new Error(ROUTINES_USAGE);
      const kinds = [values.turn !== undefined, values.hire !== undefined, values.check === true].filter(
        Boolean,
      );
      if (kinds.length !== 1)
        throw new Error(`Choose one target: --turn, --hire or --check\n${ROUTINES_USAGE}`);
      const conversation = values.conversation === undefined ? {} : { conversationId: values.conversation };
      let hire: unknown;
      if (values.hire !== undefined) {
        try {
          hire = JSON.parse(values.hire);
        } catch {
          throw new Error(
            '--hire takes JSON with hire_agent\'s fields, e.g. {"title":"Ada","role":"engineer","workingDirectory":"/path"}',
          );
        }
      }
      const target =
        values.turn !== undefined
          ? { kind: "turn", prompt: values.turn, ...conversation }
          : values.hire !== undefined
            ? { kind: "hire", hire, brief: values.brief, ...conversation }
            : {
                kind: "check",
                command: checkCommand,
                workingDirectory: values.cwd,
                ...(values.timeout === undefined ? {} : { timeoutSeconds: Number(values.timeout) }),
                ...(values.report === undefined ? {} : { report: values.report }),
                ...conversation,
              };
      input = {
        action: "add",
        name: rest[0],
        schedule,
        target,
        ...(values.missed === undefined ? {} : { missed: values.missed }),
        ...(values.paused ? { enabled: false } : {}),
      };
      break;
    }
    case "edit":
      input = {
        action: "edit",
        id: rest[0],
        ...(values.name === undefined ? {} : { name: values.name }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(values.missed === undefined ? {} : { missed: values.missed }),
      };
      break;
    case "pause":
    case "resume":
    case "remove":
    case "run-now":
      input = { action: verb === "run-now" ? "run_now" : verb, id: rest[0] };
      break;
    case "history":
      input = {
        action: "history",
        ...(rest[0] === undefined ? {} : { id: rest[0] }),
        ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      };
      break;
    default:
      throw new Error(ROUTINES_USAGE);
  }
  const parsed = RoutineCommandSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${issue ? `${issue.path.join(".") || "routine"}: ${issue.message}\n` : ""}${ROUTINES_USAGE}`,
    );
  }
  return { command: parsed.data, json: values.json === true };
}

/** `clankie routines`: the same API every UI uses (ADR 0265). */
export async function runRoutinesCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  } = {},
): Promise<{ ok: true; status: RoutinesStatus; json: boolean } | { ok: false; error: string }> {
  let parsed: ReturnType<typeof parseRoutinesArgs>;
  try {
    parsed = parseRoutinesArgs(args);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined)
    return { ok: false, error: "Routines need the local operator credential. Run clankie doctor." };
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${commandHost({ ...options, env })}${ROUTINES_PATH}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
        body: JSON.stringify(parsed.command),
        signal: AbortSignal.timeout(60_000),
      },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        body !== null && typeof body === "object" && "message" in body
          ? String(body.message)
          : response.statusText;
      return { ok: false, error: `Routines: ${String(response.status)} ${message}` };
    }
    return { ok: true, status: RoutinesStatusSchema.parse(body), json: parsed.json };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function formatRoutine(routine: Routine): string {
  const when = routine.schedule.text ?? routine.schedule.cron;
  const state = routine.enabled ? `next ${routine.nextRunAt ?? "unknown"}` : "paused";
  const last = routine.lastRun === undefined ? "never run" : `last ${formatRun(routine.lastRun)}`;
  return `${routine.id} · ${routine.name} · ${routine.target.kind} · ${when} (${routine.schedule.timeZone}) · ${state} · ${last}`;
}

function formatRun(run: RoutineRun): string {
  const took = run.durationMs === undefined ? "" : ` in ${(run.durationMs / 1000).toFixed(1)}s`;
  const missed = run.missed === undefined ? "" : ` · ${String(run.missed)} missed`;
  return `${run.status} ${run.startedAt} (${run.trigger}${took}${missed})`;
}

export function formatRuns(runs: readonly RoutineRun[]): string {
  if (!runs.length) return "No runs yet.";
  return runs
    .map(
      (run) =>
        `${run.routineId} · ${formatRun(run)}${run.detail ? ` · ${run.detail.split("\n")[0]!.slice(0, 160)}` : ""}`,
    )
    .join("\n");
}

export function formatRoutinesStatus(status: RoutinesStatus): string {
  const routines = [
    ...(status.error === undefined
      ? []
      : ["Attention: the routines file is unreadable; nothing runs until it is fixed."]),
    status.routines.length ? status.routines.map(formatRoutine).join("\n") : "No routines.",
  ].join("\n");
  return status.runs === undefined ? routines : `${routines}\n\n${formatRuns(status.runs)}`;
}
