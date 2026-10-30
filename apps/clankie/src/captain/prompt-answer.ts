import { createHash } from "node:crypto";
import type { PromptAnswerResult, PromptAnswerStep } from "@clankie/protocol/connector";
import type { HerdrWatchRunner } from "./herdr-watch.ts";

/** Screens already answered, so one prompt is never answered twice (ADR 0302). */
const ANSWERED_MAX = 512;

export interface PromptAnswerDeps {
  /** The address the fleet-routed runner reads a terminal by, as terminal_read uses. */
  readonly paneAddress: (terminalId: string) => Promise<string | undefined>;
  readonly runner: Pick<HerdrWatchRunner, "resolveTerminal" | "readPane" | "sendKeys" | "sendText">;
  /** A worker's native question from this seat waits on the owner in the ask store. */
  readonly ownerAskPending: (seatId: string) => boolean;
  /** The note board line that records the answer; never blocks it. */
  readonly record: (app: string, text: string) => unknown;
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

/**
 * A connected app answers the prompt open in an agent's pane: a menu, a
 * permission prompt, a question (ADR 0302). Keys go in only while the agent
 * waits on input, the text the app expects is still on the screen, no owner ask
 * holds the same question, and that screen was not answered before.
 */
export function createPromptAnswerer(deps: PromptAnswerDeps) {
  const answered: string[] = [];
  return async function answerPrompt(input: PromptAnswerInput): Promise<PromptAnswerResult> {
    const refused = (message: string): PromptAnswerResult => ({ outcome: "refused", message });
    const unavailable = (message: string): PromptAnswerResult => ({ outcome: "unavailable", message });
    if (!deps.runner.readPane || !deps.runner.sendKeys || !deps.runner.sendText)
      return unavailable("This Clankie can't press keys in agent panes.");
    const address = await deps.paneAddress(input.terminalId);
    if (address === undefined) return unavailable("No agent has that id now. List the agents again.");
    const pane = await deps.runner.resolveTerminal(address);
    if (pane === undefined || pane.agent === "")
      return unavailable("That agent's pane isn't there now. List the agents again.");
    if (pane.status !== "blocked")
      return refused(
        `That agent isn't waiting on a prompt (it is ${pane.status || "in an unknown state"}). Read its screen again.`,
      );
    if (deps.ownerAskPending(pane.terminalId))
      return refused("Clankie sent this agent's question to the owner, so it's the owner's to answer.");
    const screen = await deps.runner.readPane(pane.paneId, "visible", "text");
    if (!squash(screen).includes(squash(input.expect)))
      return refused(
        "What you expected isn't on that agent's screen now, so the prompt changed. Read its screen again.",
      );
    const key = createHash("sha256").update(pane.paneId).update("\0").update(screen).digest("hex");
    if (answered.includes(key))
      return refused("That prompt was already answered. Read the agent's screen to see what it shows now.");
    if (!input.current())
      return refused("Answering prompts was turned off for this app, or it was disconnected.");
    answered.push(key);
    if (answered.length > ANSWERED_MAX) answered.shift();
    let sent = 0;
    try {
      for (const step of input.steps) {
        if ("key" in step) await deps.runner.sendKeys(pane.paneId, [step.key]);
        else await deps.runner.sendText(pane.paneId, step.text);
        sent += 1;
      }
    } catch {
      // A send can fail after it reached the pane (an ssh link dropping on a linked
      // PC), so a failed send never proves nothing arrived.
      return {
        outcome: "uncertain",
        message:
          sent === 0
            ? "The answer may or may not have reached the agent. Read its screen before doing anything else."
            : "Only part of the answer may have reached the agent. Read its screen before doing anything else.",
      };
    }
    const label = pane.name ?? pane.terminalId;
    // allow-swallowed-rejection -- the record is a courtesy; the keys were already pressed.
    await Promise.resolve()
      .then(() => deps.record(input.app, `Answered a prompt in ${label}: ${describe(input.steps)}.`))
      .catch(() => undefined);
    const sentTo = `Sent to ${label}: ${describe(input.steps)}`;
    return {
      outcome: "answered",
      message: `${sentTo.length > 900 ? `${sentTo.slice(0, 899)}…` : sentTo}. Read its screen to see what it does next.`,
    };
  };
}
