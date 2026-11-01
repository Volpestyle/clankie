import type { PaneInputLine } from "./pane-draft.ts";

// Herdr direct prompting (ADR 0334): the fallback for an agent with no native
// channel. It types into the agent's own terminal through Herdr's paste-aware
// prompt (herdr `agent prompt`, herdr-core `terminal.send`), which pastes the
// whole message and presses Enter, and refuses a program held at a prompt. It
// runs only while the agent waits for input and its input line reads empty, so
// an owner's half-typed draft is never joined to it or sent.

/** The longest message typed into a terminal; a start_agent brief has the same cap. */
export const DIRECT_PROMPT_MAX = 8_000;

/** Statuses in which the agent waits for input: Herdr's `idle`, and `done` before it's seen. */
const WAITING = new Set(["idle", "done"]);

export interface DirectPromptPort {
  /** The agent's harness, as its input line is read (`claude`, `codex`). */
  readonly harness: string;
  /** The agent's status now, read fresh. */
  status(): Promise<string | undefined>;
  /** The agent's input line now, read fresh. */
  input(): Promise<PaneInputLine>;
  /** Pastes the whole message and presses Enter, refused by Herdr when the program is blocked. */
  prompt(text: string): Promise<void>;
}

/** Why a message can't be typed into this agent now; undefined when it can. */
function directPromptRefusal(
  harness: string,
  status: string | undefined,
  input: PaneInputLine,
  text: string,
): string | undefined {
  if (text.trim().length === 0) return "The message is empty; nothing was sent.";
  if (text.length > DIRECT_PROMPT_MAX)
    return `This agent has no native channel, and a message typed into its terminal is limited to ${DIRECT_PROMPT_MAX} characters. Nothing was sent.`;
  // A leading `/`, `!` or `#` makes the harness run a command or shell line, not read a message.
  if (/^[/!#]/u.test(text.trimStart()))
    return "This agent has no native channel, and a typed message starting with /, ! or # would run as a command in its terminal. Nothing was sent; reword it to start with a word.";
  if (status === "blocked")
    return "This agent is waiting on a question or permission prompt, so nothing was typed. Answer it first.";
  if (status === undefined || !WAITING.has(status))
    return `This agent has no native channel and is ${status ?? "in an unknown state"}, so nothing was typed. Messages are typed into its terminal only while it waits for input; send it again once it's idle.`;
  if (input.state === "draft")
    return "Someone has a half-typed message in this agent's input line, so nothing was typed. Send it again once the input line is clear.";
  if (input.state !== "empty")
    return ["claude", "codex"].includes(harness)
      ? "This agent's input line shows text that may be someone's draft, so nothing was typed. Send it again once the input line is clear."
      : `This agent has no native channel, and Clankie can't yet read a ${harness} input line to keep a draft safe, so nothing was typed.`;
  return undefined;
}

/**
 * Types one message into an agent with no native channel, once its status and input line
 * allow it. `sent: false` means nothing was typed; an error from `prompt` leaves it
 * unknown whether the paste landed, and is the caller's to report as uncertain.
 */
export async function promptWhenClear(
  port: DirectPromptPort,
  text: string,
  before?: () => Promise<boolean> | boolean,
): Promise<{ readonly sent: true } | { readonly sent: false; readonly detail: string }> {
  const [status, input] = [await port.status(), await port.input()];
  const refusal = directPromptRefusal(port.harness, status, input, text);
  if (refusal !== undefined) return { sent: false, detail: refusal };
  if (before !== undefined && !(await before()))
    return { sent: false, detail: "Authority changed before typing; nothing was sent." };
  await port.prompt(text);
  return { sent: true };
}
