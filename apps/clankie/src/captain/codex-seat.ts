/**
 * A Codex fleet seat's session: Herdr does not report one, so the uuid lives in
 * the rollout file the process keeps open
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`). `codex
 * queue --thread` takes that uuid. The pty remains the fallback.
 */

export interface HerdrForegroundProcess {
  readonly pid: number;
  readonly name: string;
  readonly argv0?: string;
  readonly argv?: readonly string[];
}

const ROLLOUT_SESSION =
  /rollout-[^/\s]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function basename(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash < 0 ? value : value.slice(slash + 1);
}

function isCodexProcess(process: HerdrForegroundProcess): boolean {
  return basename(process.name) === "codex" || basename(process.argv0 ?? "") === "codex";
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
 * ponytail: lsof of the open rollout file is the session id; herdr
 * `report-agent-session` for Codex would replace it.
 */
export function resolveCodexSessionId(
  processes: readonly HerdrForegroundProcess[],
  openFiles: string,
): string | undefined {
  if (codexProcess(processes) === undefined) return undefined;
  return ROLLOUT_SESSION.exec(openFiles)?.[1];
}
