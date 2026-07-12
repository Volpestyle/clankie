import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

export type HerdrCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface HerdrReportOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: HerdrCommandRunner;
  readonly source?: string;
  readonly agent?: string;
}

function defaultRunner(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, [...args], { maxBuffer: 1024 * 1024 }).then(({ stdout, stderr }) => ({
    stdout: String(stdout),
    stderr: String(stderr),
  }));
}

/**
 * Self-report agent presence over the Herdr socket CLI when running inside a
 * Herdr pane. Outside `HERDR_ENV=1` this is an inert no-op.
 */
export async function reportHerdrAgent(
  state: HerdrAgentState,
  options: HerdrReportOptions & { readonly message?: string } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") return false;
  const paneId = env.HERDR_PANE_ID?.trim();
  if (paneId === undefined || paneId.length === 0) return false;

  const source = options.source ?? "clankie-trace";
  const agent = options.agent ?? "clankie-trace";
  const args = ["pane", "report-agent", paneId, "--source", source, "--agent", agent, "--state", state];
  if (options.message !== undefined && options.message.length > 0) {
    args.push("--message", options.message);
  }
  const run = options.runCommand ?? defaultRunner;
  await run("herdr", args);
  return true;
}

/**
 * Publish display metadata (title / custom status) via `herdr pane report-metadata`.
 * Inert outside Herdr.
 */
export async function reportHerdrMetadata(
  options: HerdrReportOptions & {
    readonly title?: string;
    readonly customStatus?: string;
  } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") return false;
  const paneId = env.HERDR_PANE_ID?.trim();
  if (paneId === undefined || paneId.length === 0) return false;

  const source = options.source ?? "clankie-trace";
  const args = ["pane", "report-metadata", paneId, "--source", source];
  if (options.agent !== undefined) args.push("--agent", options.agent);
  if (options.title !== undefined) args.push("--title", options.title);
  if (options.customStatus !== undefined) args.push("--custom-status", options.customStatus);
  const run = options.runCommand ?? defaultRunner;
  await run("herdr", args);
  return true;
}
