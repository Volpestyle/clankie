import { WATCH_REFUSAL } from "../watch.ts";
import { createHash } from "node:crypto";
import type { PromptAnswerResult, PromptAnswerStep } from "@clankie/protocol/connector";
import type { HerdrBoundPane, HerdrWatchRunner } from "./herdr-watch.ts";

/** Screens already answered, so one prompt is never answered twice (ADR 0303). */
const ANSWERED_MAX = 512;

export interface PromptAnswerDeps {
  /** The address the fleet-routed runner reads a terminal by, as terminal_read uses. */
  readonly paneAddress: (terminalId: string) => Promise<string | undefined>;
  readonly runner: Pick<HerdrWatchRunner, "bindPane">;
  /** A worker's native question from this seat waits on the owner in the ask store. */
  readonly ownerAskPending: (seatId: string) => boolean;
  /** The note board line that records the answer; never blocks it. */
  readonly record: (app: string, text: string) => unknown;
  /** Watch (ADR 0308): no key reaches a pane while Clankie only watches. */
  readonly watching?: () => Promise<boolean>;
}

export interface PromptAnswerInput {
  readonly app: string;
  readonly current: () => boolean;
  readonly terminalId: string;
  readonly expect: string;
  readonly steps: readonly PromptAnswerStep[];
}

const squash = (text: string) => text.replace(/\s+/gu, " ").trim();

function describe(steps: readonly PromptAnswerStep[]): string {
  return steps.map((step) => ("key" in step ? step.key : `typed "${step.text.slice(0, 200)}"`)).join(", ");
}

type Check =
  | { readonly ok: true; readonly screen: string }
  | {
      readonly ok: false;
      readonly outcome: "refused" | "unavailable";
      readonly why: string;
      readonly message: string;
    };

/**
 * A connected app answers the prompt open in an agent's pane: a menu, a
 * permission prompt, a question (ADR 0303). The pane and its machine connection
 * are bound once. Before every step, not only the first, the agent must still
 * wait on input in that same pane, the text the app expects must still be on the
 * screen, no owner ask may hold the question and the owner must not have turned
 * answering off; a screen is answered only once.
 */
export function createPromptAnswerer(deps: PromptAnswerDeps) {
  const answered: string[] = [];
  return async function answerPrompt(input: PromptAnswerInput): Promise<PromptAnswerResult> {
    const unavailable = (message: string): PromptAnswerResult => ({ outcome: "unavailable", message });
    if (!deps.runner.bindPane) return unavailable("This Clankie can't press keys in agent panes.");
    const address = await deps.paneAddress(input.terminalId);
    if (address === undefined) return unavailable("No agent has that id now. List the agents again.");
    let bound: HerdrBoundPane | undefined;
    try {
      bound = await deps.runner.bindPane(address);
    } catch {
      return unavailable("Clankie can't reach that agent's pane now. List the agents again.");
    }
    if (bound === undefined || bound.pane.agent === "")
      return unavailable("That agent's pane isn't there now. List the agents again.");
    const pane = bound;
    const label = pane.pane.name ?? pane.pane.terminalId;
    const check = async (): Promise<Check> => {
      const now = await pane.resolve();
      if (now === undefined || now.agent === "" || now.paneId !== pane.pane.paneId)
        return {
          ok: false,
          outcome: "unavailable",
          why: "the agent's pane went away",
          message: "That agent's pane isn't there now. List the agents again.",
        };
      if (now.status !== "blocked")
        return {
          ok: false,
          outcome: "refused",
          why: "the agent stopped waiting on the prompt",
          message: `That agent isn't waiting on a prompt (it is ${now.status || "in an unknown state"}). Read its screen again.`,
        };
      if (deps.ownerAskPending(now.terminalId))
        return {
          ok: false,
          outcome: "refused",
          why: "the question went to the owner",
          message: "Clankie sent this agent's question to the owner, so it's the owner's to answer.",
        };
      const screen = await pane.readScreen();
      if (!squash(screen).includes(squash(input.expect)))
        return {
          ok: false,
          outcome: "refused",
          why: "the text you expected left the screen",
          message:
            "What you expected isn't on that agent's screen now, so the prompt changed. Read its screen again.",
        };
      if (!input.current())
        return {
          ok: false,
          outcome: "refused",
          why: "answering was turned off for this app",
          message: "Answering prompts was turned off for this app, or it was disconnected.",
        };
      if ((await deps.watching?.()) === true)
        return { ok: false, outcome: "refused", why: "Clankie is only watching", message: WATCH_REFUSAL };
      return { ok: true, screen };
    };
    let sent = 0;
    const note = (text: string) =>
      Promise.resolve()
        .then(() => deps.record(input.app, text))
        // allow-swallowed-rejection -- the record is a courtesy; the keys were already pressed.
        .catch(() => undefined);
    const bounded = (text: string) => (text.length > 900 ? `${text.slice(0, 899)}…` : text);
    const stopped = async (why: string): Promise<PromptAnswerResult> => {
      const part = describe(input.steps.slice(0, sent));
      await note(`Answered part of a prompt in ${label}: ${part}; stopped because ${why}.`);
      return {
        outcome: "uncertain",
        message: `${bounded(`Stopped after ${sent} of ${input.steps.length} steps sent to ${label} (${part})`)}: ${why}. Read its screen before doing anything else.`,
      };
    };
    const first = await check();
    if (!first.ok) return { outcome: first.outcome, message: first.message };
    const key = createHash("sha256").update(pane.pane.paneId).update("\0").update(first.screen).digest("hex");
    if (answered.includes(key))
      return {
        outcome: "refused",
        message: "That prompt was already answered. Read the agent's screen to see what it shows now.",
      };
    answered.push(key);
    if (answered.length > ANSWERED_MAX) answered.shift();
    try {
      for (const step of input.steps) {
        if (sent > 0) {
          const again = await check();
          if (!again.ok) return stopped(again.why);
        }
        // Nothing awaits between this and the send, so a revocation can't slip in.
        if (!input.current())
          return sent === 0
            ? {
                outcome: "refused",
                message: "Answering prompts was turned off for this app, or it was disconnected.",
              }
            : stopped("answering was turned off for this app");
        if ("key" in step) await pane.sendKeys([step.key]);
        else await pane.sendText(step.text);
        sent += 1;
      }
    } catch {
      if (sent === 0)
        // A send can fail after it reached the pane (an ssh link dropping on a linked
        // PC), so a failed send never proves nothing arrived.
        return {
          outcome: "uncertain",
          message:
            "The answer may or may not have reached the agent. Read its screen before doing anything else.",
        };
      await note(
        `Answered part of a prompt in ${label}: ${describe(input.steps.slice(0, sent))}; stopped because Clankie lost the pane or its machine.`,
      );
      return {
        outcome: "uncertain",
        message:
          "Only part of the answer may have reached the agent. Read its screen before doing anything else.",
      };
    }
    await note(`Answered a prompt in ${label}: ${describe(input.steps)}.`);
    return {
      outcome: "answered",
      message: `${bounded(`Sent to ${label}: ${describe(input.steps)}`)}. Read its screen to see what it does next.`,
    };
  };
}
