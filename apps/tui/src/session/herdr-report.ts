/**
 * The console's own herdr wiring: it reports its pane's agent state and
 * display metadata upward, and jumps the session to the panes Clankie names.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

type HerdrCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface HerdrReportOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: HerdrCommandRunner;
  readonly source?: string;
  readonly agent?: string;
}

/** Pane id of this console when it is sitting in herdr; undefined otherwise. */
export function herdrPaneIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HERDR_ENV !== "1") return undefined;
  const paneId = env.HERDR_PANE_ID?.trim();
  return paneId === undefined || paneId.length === 0 ? undefined : paneId;
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
 * Publish display metadata (title / token) via `herdr pane report-metadata`.
 * Inert outside Herdr.
 */
export async function reportHerdrMetadata(
  options: HerdrReportOptions & {
    readonly title?: string;
    readonly token?: string;
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
  if (options.token !== undefined) args.push("--token", options.token);
  const run = options.runCommand ?? defaultRunner;
  await run("herdr", args);
  return true;
}

export type HerdrJumpResult =
  | { readonly outcome: "ok"; readonly target: string }
  | { readonly outcome: "skipped"; readonly reason: "not_in_herdr" }
  | { readonly outcome: "unavailable"; readonly error: string };

/** Pane ids the way Clankie writes them in the transcript: `w18:p1J`, `w19:p1`. */
const HERDR_PANE_REF = /\bw[0-9]+:p[0-9A-Za-z]+\b/gu;

/**
 * The pane id under a visible column of a rendered transcript line, if the
 * click landed on one. Works on any block — his prose, a tool result, the
 * roster — because the ids are the same text everywhere.
 */
export function herdrPaneRefAtColumn(line: string, column: number): string | undefined {
  const plain = stripTerminalSequences(line);
  for (const match of plain.matchAll(HERDR_PANE_REF)) {
    const start = visibleWidth(plain.slice(0, match.index));
    if (column >= start && column < start + visibleWidth(match[0])) return match[0];
  }
  return undefined;
}

/**
 * Jump the herdr session to another agent. `herdr agent focus` takes a pane id
 * or an agent name — exactly how Clankie names the fleet — so clicking the id
 * he wrote lands the operator in that pane. Inert outside Herdr.
 */
export async function jumpToHerdrAgent(
  target: string,
  options: HerdrReportOptions = {},
): Promise<HerdrJumpResult> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") return { outcome: "skipped", reason: "not_in_herdr" };
  const run = options.runCommand ?? defaultRunner;
  try {
    await run("herdr", ["agent", "focus", target]);
    return { outcome: "ok", target };
  } catch (caught) {
    return { outcome: "unavailable", error: herdrJumpError(caught) };
  }
}

/** herdr refuses with a JSON envelope on stderr; surface its message, not the spawn noise. */
function herdrJumpError(caught: unknown): string {
  if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return "herdr is not on PATH";
  const failure = caught as {
    readonly stderr?: unknown;
    readonly stdout?: unknown;
    readonly message?: unknown;
  };
  for (const stream of [failure.stderr, failure.stdout, failure.message]) {
    const envelope = /\{"error":.*\}/u.exec(typeof stream === "string" ? stream : "");
    if (envelope === null) continue;
    try {
      const message = (JSON.parse(envelope[0]) as { error?: { message?: unknown } }).error?.message;
      if (typeof message === "string" && message.length > 0) return message;
    } catch {
      // Not an API envelope after all; keep looking.
    }
  }
  return caught instanceof Error ? caught.message : String(caught);
}

export function formatHerdrJumpResult(result: HerdrJumpResult): {
  readonly text: string;
  readonly tone: "success" | "error";
} {
  if (result.outcome === "skipped") {
    return { text: "Jumping needs a herdr session; this console is not in a pane.", tone: "error" };
  }
  if (result.outcome === "unavailable") return { text: `Cannot jump (${result.error}).`, tone: "error" };
  return { text: `Focused ${result.target}.`, tone: "success" };
}
