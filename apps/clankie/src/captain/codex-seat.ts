/**
 * A Codex fleet seat's session: use Herdr's exact session report when available,
 * otherwise the uuid lives in the rollout file the process keeps open
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`). `codex
 * queue --thread` takes that uuid. An exact Herdr session report is also usable;
 * delivery never falls back to terminal input.
 */

export interface HerdrForegroundProcess {
  readonly pid: number;
  readonly name: string;
  readonly argv0?: string;
  readonly argv?: readonly string[];
}

const ROLLOUT_SESSION =
  /rollout-[^/\s]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/giu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexProcess(process: HerdrForegroundProcess): boolean {
  return (
    /(?:^|[\\/])codex(?:\.exe)?$/iu.test(process.name) ||
    /(?:^|[\\/])codex(?:\.exe)?$/iu.test(process.argv0 ?? "")
  );
}

export function parseHerdrForegroundProcesses(stdout: string): readonly HerdrForegroundProcess[] {
  const parsed: unknown = JSON.parse(stdout);
  const result = isRecord(parsed) ? parsed.result : undefined;
  const processInfo = isRecord(result) ? result.process_info : undefined;
  const processes =
    isRecord(processInfo) && Array.isArray(processInfo.foreground_processes)
      ? processInfo.foreground_processes
      : [];
  return processes.flatMap((value) => {
    if (!isRecord(value) || typeof value.pid !== "number" || typeof value.name !== "string") return [];
    const argv0 = value.argv0;
    const argv = value.argv;
    return [
      {
        pid: value.pid,
        name: value.name,
        ...(typeof argv0 === "string" ? { argv0 } : {}),
        ...(Array.isArray(argv) && argv.every((item) => typeof item === "string")
          ? { argv: argv as string[] }
          : {}),
      },
    ];
  });
}

/** The foreground process whose `name` or `argv0` is `codex`. */
export function codexProcess(
  processes: readonly HerdrForegroundProcess[],
): HerdrForegroundProcess | undefined {
  return processes.find(isCodexProcess);
}

/**
 * A TUI can also keep its native subagents' rollouts open. Prefer Herdr's exact
 * session when it is among them; otherwise resolve the first rollout so callers
 * can detect a replacement, or discover a session without a Herdr report.
 */
export function resolveCodexSessionId(
  processes: readonly HerdrForegroundProcess[],
  openFiles: string,
  reportedSessionId?: string,
): string | undefined {
  if (codexProcess(processes) === undefined) return undefined;
  const sessions = [...openFiles.matchAll(ROLLOUT_SESSION)].map((match) => match[1]);
  return reportedSessionId !== undefined && sessions.includes(reportedSessionId)
    ? reportedSessionId
    : sessions[0];
}

/** The rollout's actual home also owns Codex's queue and session database. */
export function resolveCodexHome(openFiles: string, sessionId: string): string | undefined {
  const path = openFiles
    .split("\n")
    .find((line) => line.startsWith("n/") && line.endsWith(`-${sessionId}.jsonl`))
    ?.slice(1);
  const boundary = path?.lastIndexOf("/sessions/") ?? -1;
  return path && boundary > 0 ? path.slice(0, boundary) : undefined;
}

/** Null means no selected reachable endpoint; undefined selects this account's daemon. */
export function codexControlEndpoint(process: HerdrForegroundProcess | undefined): string | undefined | null {
  const argv = process?.argv;
  if (argv === undefined || argv.length === 0) return null;
  const index = argv.indexOf("--remote");
  const endpoint =
    index >= 0
      ? (argv[index + 1] ?? "")
      : argv.find((arg) => arg.startsWith("--remote="))?.slice("--remote=".length);
  if (endpoint !== undefined) return endpoint.startsWith("unix://") && endpoint.length > 7 ? endpoint : null;
  return argv.includes("--no-daemon") ? null : undefined;
}
