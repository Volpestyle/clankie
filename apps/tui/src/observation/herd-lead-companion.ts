import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type HerdLeadCompanionRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string }>;

const HERD_LEAD_BOARD_LABEL = "Herd Lead";

export type HerdLeadCompanionResult =
  | { readonly outcome: "skipped"; readonly reason: "not_in_herdr" }
  | { readonly outcome: "ok"; readonly paneId: string; readonly alreadyOpen: boolean }
  | { readonly outcome: "closed"; readonly paneId: string }
  | { readonly outcome: "absent" }
  | { readonly outcome: "unavailable"; readonly error: string };

export interface HerdLeadCompanionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: HerdLeadCompanionRunner;
}

function defaultRunner(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, [...args], { env, maxBuffer: 1024 * 1024 }).then(({ stdout, stderr }) => ({
    stdout: String(stdout),
    stderr: String(stderr),
  }));
}

function companionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const paneId = env.HERDR_PANE_ID?.trim();
  return paneId === undefined || paneId.length === 0 ? env : { ...env, HERD_LEAD_TARGET: paneId };
}

function parseOk(stdout: string, stderr: string): Extract<HerdLeadCompanionResult, { outcome: "ok" }> {
  const paneId =
    stdout
      .trim()
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "opened";
  return {
    outcome: "ok",
    paneId,
    alreadyOpen: /already open/iu.test(stderr),
  };
}

function unavailable(caught: unknown): Extract<HerdLeadCompanionResult, { outcome: "unavailable" }> {
  if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") {
    return { outcome: "unavailable", error: "herdr-lead is not on PATH" };
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  return { outcome: "unavailable", error: message };
}

/**
 * Open the herdr-lead board beside this console, or inherit the one already
 * up. Inert outside Herdr: the board is a herdr pane. Sets HERD_LEAD_TARGET
 * so the board's jump-back peer is this Clankie pane.
 */
export async function ensureHerdLeadCompanion(
  options: HerdLeadCompanionOptions = {},
): Promise<HerdLeadCompanionResult> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") return { outcome: "skipped", reason: "not_in_herdr" };
  const run = options.runCommand ?? defaultRunner;
  try {
    const { stdout, stderr } = await run("herdr-lead", ["split"], companionEnv(env));
    return parseOk(stdout, stderr);
  } catch (caught) {
    return unavailable(caught);
  }
}

function boardPaneIdFromList(stdout: string, exclude?: string): string | undefined {
  const parsed = JSON.parse(stdout) as { result?: { panes?: unknown } };
  const panes = Array.isArray(parsed.result?.panes) ? parsed.result.panes : [];
  for (const value of panes) {
    if (value === null || typeof value !== "object") continue;
    const pane = value as Record<string, unknown>;
    if (pane.label !== HERD_LEAD_BOARD_LABEL || typeof pane.pane_id !== "string") continue;
    if (exclude !== undefined && pane.pane_id === exclude) continue;
    return pane.pane_id;
  }
  return undefined;
}

/** Close the companion board pane. No-op if it is not open. */
export async function closeHerdLeadCompanion(
  options: HerdLeadCompanionOptions = {},
): Promise<HerdLeadCompanionResult> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") return { outcome: "skipped", reason: "not_in_herdr" };
  const run = options.runCommand ?? defaultRunner;
  const self = env.HERDR_PANE_ID?.trim();
  try {
    const listed = await run("herdr", ["pane", "list"], env);
    const paneId = boardPaneIdFromList(listed.stdout, self);
    if (paneId === undefined) return { outcome: "absent" };
    await run("herdr", ["pane", "close", paneId], env);
    return { outcome: "closed", paneId };
  } catch (caught) {
    return unavailable(caught);
  }
}

/** Jump to the board, or back to this pane. Opens it if it is not up. */
export async function focusHerdLeadCompanion(
  options: HerdLeadCompanionOptions = {},
): Promise<HerdLeadCompanionResult> {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") return { outcome: "skipped", reason: "not_in_herdr" };
  const run = options.runCommand ?? defaultRunner;
  try {
    const { stdout, stderr } = await run("herdr-lead", ["focus"], companionEnv(env));
    return parseOk(stdout, stderr);
  } catch (caught) {
    return unavailable(caught);
  }
}

export function formatHerdLeadCompanionResult(
  result: HerdLeadCompanionResult,
  verb: "open" | "focus" | "close",
): { readonly text: string; readonly tone: "success" | "error" } {
  if (result.outcome === "skipped") {
    return {
      text: "The herdr-lead board lives in a herdr pane. Open the console from herdr, or ask Clankie to run `herdr-lead split`.",
      tone: "error",
    };
  }
  if (result.outcome === "unavailable") {
    return { text: `herdr-lead board unavailable (${result.error}).`, tone: "error" };
  }
  if (result.outcome === "absent") {
    return { text: "herdr-lead board is not open. `/board` opens it.", tone: "success" };
  }
  if (result.outcome === "closed") {
    return {
      text: `herdr-lead board closed (${result.paneId}). \`/board\` opens it again.`,
      tone: "success",
    };
  }
  const where = result.alreadyOpen ? "already open" : verb === "focus" ? "focused" : "opened";
  return {
    text: `herdr-lead board ${where} in ${result.paneId}. \`/board focus\` or prefix+shift+l jumps to it and back.`,
    tone: "success",
  };
}
