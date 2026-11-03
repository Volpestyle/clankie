import { WATCH_REFUSAL } from "../watch.ts";
import { createHash } from "node:crypto";
import type { KeyPressResult, PromptAnswerResult, PromptAnswerStep } from "@clankie/protocol/connector";
import type { HerdrAgentSnapshot, HerdrBoundPane, HerdrWatchRunner } from "./herdr-watch.ts";
import { refuseStep } from "./prompt-answer-guard.ts";

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
  /**
   * Whether this exact native occupant (pane, seat and session) is a hire the app with
   * this device id asked for. An app answers only its own hires unless the owner granted
   * it the pane; anything that can't be matched exactly is refused.
   */
  readonly appHire?: (agent: HerdrAgentSnapshot, deviceId: string) => boolean;
}

/**
 * Who the call is for: a connected app, as the route named it from the relay's stamp,
 * or the owner answering from their own feed (#149). The owner's answer is theirs to
 * give, so it skips the own-hire scope and the risky-screen guard.
 */
type AppCaller = {
  readonly app: string;
  readonly current: () => boolean;
  readonly terminalId: string;
} & (
  | { readonly owner: true }
  | {
      readonly owner?: undefined;
      /** The calling app's connector device. */
      readonly deviceId: string;
      /** The owner's grant for this app on one exact agent id, beyond its own hires. */
      readonly paneGranted: (terminalId: string) => boolean;
    }
);

const NOT_YOURS =
  "That agent isn't one this app hired, so its prompts are the owner's to answer. The owner can let this app answer that one agent at the Mac with: clankie connector prompts pane APP AGENT on";
const RISKY = (why: string) => `Refused because ${why}. The owner must answer this one at the Mac.`;

/**
 * Whether the app may act on this pane now: its own hire, or a pane the owner granted
 * it. Matched on the pane as Herdr reports it now, before every step.
 */
function scopeOf(
  deps: Pick<PromptAnswerDeps, "appHire">,
  input: AppCaller,
  now: HerdrAgentSnapshot,
): "owner" | "hire" | "grant" | undefined {
  if (input.owner) return "owner";
  if (deps.appHire?.(now, input.deviceId) === true) return "hire";
  return input.paneGranted(now.terminalId) || input.paneGranted(input.terminalId) ? "grant" : undefined;
}

export type PromptAnswerInput = AppCaller & {
  readonly expect: string;
  readonly steps: readonly PromptAnswerStep[];
};

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
 *
 * Amended: the pane must be a hire this app asked for, or one the owner granted it, and
 * the step must pass the screen guard (prompt-answer-guard.ts), checked on the screen
 * read just before that step.
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
    let granted = false;
    const check = async (step: PromptAnswerStep): Promise<Check> => {
      const now = await pane.resolve();
      if (now === undefined || now.agent === "" || now.paneId !== pane.pane.paneId)
        return {
          ok: false,
          outcome: "unavailable",
          why: "the agent's pane went away",
          message: "That agent's pane isn't there now. List the agents again.",
        };
      const scope = scopeOf(deps, input, now);
      if (scope === undefined)
        return { ok: false, outcome: "refused", why: "the agent isn't this app's hire", message: NOT_YOURS };
      if (scope === "grant") granted = true;
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
      const risky = input.owner ? undefined : refuseStep(screen, step);
      if (risky !== undefined) return { ok: false, outcome: "refused", why: risky, message: RISKY(risky) };
      return { ok: true, screen };
    };
    const grantNote = () => (granted ? " (on the owner's grant for this agent)" : "");
    let sent = 0;
    const note = (text: string) =>
      Promise.resolve()
        .then(() => deps.record(input.app, text))
        // allow-swallowed-rejection -- the record is a courtesy; the keys were already pressed.
        .catch(() => undefined);
    const bounded = (text: string) => (text.length > 900 ? `${text.slice(0, 899)}…` : text);
    const stopped = async (why: string): Promise<PromptAnswerResult> => {
      const part = describe(input.steps.slice(0, sent));
      await note(`Answered part of a prompt in ${label}${grantNote()}: ${part}; stopped because ${why}.`);
      return {
        outcome: "uncertain",
        message: `${bounded(`Stopped after ${sent} of ${input.steps.length} steps sent to ${label} (${part})`)}: ${why}. Read its screen before doing anything else.`,
      };
    };
    if (pane.sendText === undefined && input.steps.some((step) => "text" in step))
      return unavailable(
        "Text can't be typed into that agent's terminal from here; only named keys can be pressed.",
      );
    const first = await check(input.steps[0]!);
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
          const again = await check(step);
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
        else await pane.sendText!(step.text);
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
        `Answered part of a prompt in ${label}${grantNote()}: ${describe(input.steps.slice(0, sent))}; stopped because Clankie lost the pane or its machine.`,
      );
      return {
        outcome: "uncertain",
        message:
          "Only part of the answer may have reached the agent. Read its screen before doing anything else.",
      };
    }
    await note(`Answered a prompt in ${label}${grantNote()}: ${describe(input.steps)}.`);
    return {
      outcome: "answered",
      message: `${bounded(`Sent to ${label}: ${describe(input.steps)}`)}. Read its screen to see what it does next.`,
    };
  };
}

export type KeyPressInput = AppCaller & {
  readonly keys: readonly string[];
};

/**
 * A connected app presses keys in an agent's terminal, whatever it is doing (ADR 0323):
 * arrows, esc, ctrl+c, tab, enter, to drive its interface the way the owner would. The
 * pane and its machine connection are bound once. Before every key the agent must still
 * be in that same pane, no owner ask may hold its question, Clankie must not be only
 * watching and the owner must not have turned prompts and keys off for the app.
 *
 * Amended: the terminal must be a hire this app asked for, or one the owner granted it,
 * and each key must pass the screen guard (prompt-answer-guard.ts) on the screen read
 * just before it: no shift+tab, no letters or digits outside a menu, nothing on a
 * risky screen.
 */
export function createKeyPresser(deps: PromptAnswerDeps) {
  return async function pressKeys(input: KeyPressInput): Promise<KeyPressResult> {
    const unavailable = (message: string): KeyPressResult => ({ outcome: "unavailable", message });
    if (!deps.runner.bindPane) return unavailable("This Clankie can't press keys in agent panes.");
    const address = await deps.paneAddress(input.terminalId);
    if (address === undefined) return unavailable("No agent has that id now. List the agents again.");
    let bound: HerdrBoundPane | undefined;
    try {
      bound = await deps.runner.bindPane(address);
    } catch {
      return unavailable("Clankie can't reach that agent's terminal now. List the agents again.");
    }
    if (bound === undefined || bound.pane.agent === "")
      return unavailable("That agent's terminal isn't there now. List the agents again.");
    const pane = bound;
    const label = pane.pane.name ?? pane.pane.terminalId;
    let granted = false;
    const refusal = async (
      key: string,
    ): Promise<{ why: string; message: string; gone?: true } | undefined> => {
      const now = await pane.resolve();
      if (now === undefined || now.agent === "" || now.paneId !== pane.pane.paneId)
        return {
          why: "the agent's terminal went away",
          message: "That agent's terminal isn't there now. List the agents again.",
          gone: true,
        };
      const scope = scopeOf(deps, input, now);
      if (scope === undefined) return { why: "the agent isn't this app's hire", message: NOT_YOURS };
      if (scope === "grant") granted = true;
      if (deps.ownerAskPending(now.terminalId))
        return {
          why: "its question went to the owner",
          message: "Clankie sent this agent's question to the owner, so its screen is the owner's to answer.",
        };
      if ((await deps.watching?.()) === true)
        return { why: "Clankie is only watching", message: WATCH_REFUSAL };
      const risky = input.owner ? undefined : refuseStep(await pane.readScreen(), { key });
      return risky === undefined ? undefined : { why: risky, message: RISKY(risky) };
    };
    const grantNote = () => (granted ? " (on the owner's grant for this agent)" : "");
    const note = (text: string) =>
      Promise.resolve()
        .then(() => deps.record(input.app, text))
        // allow-swallowed-rejection -- the record is a courtesy; the keys were already pressed.
        .catch(() => undefined);
    const off = "prompts and keys were turned off for this app";
    let sent = 0;
    const stopped = async (why: string): Promise<KeyPressResult> => {
      const part = input.keys.slice(0, sent).join(", ");
      await note(
        `Pressed part of ${input.keys.length} keys in ${label}${grantNote()}: ${part}; stopped because ${why}.`,
      );
      return {
        outcome: "uncertain",
        message:
          `Stopped after ${sent} of ${input.keys.length} keys sent to ${label} (${part}): ${why}. Read its screen before doing anything else.`.slice(
            0,
            1_000,
          ),
      };
    };
    try {
      for (const key of input.keys) {
        const refused = await refusal(key);
        if (refused !== undefined) {
          if (sent > 0) return stopped(refused.why);
          return refused.gone
            ? unavailable(refused.message)
            : { outcome: "refused", message: refused.message };
        }
        // Nothing awaits between this and the send, so a revocation can't slip in.
        if (!input.current())
          return sent === 0
            ? {
                outcome: "refused",
                message: "Prompts and keys were turned off for this app, or it was disconnected.",
              }
            : stopped(off);
        await pane.sendKeys([key]);
        sent += 1;
      }
    } catch {
      if (sent > 0)
        await note(
          `Pressed part of ${input.keys.length} keys in ${label}${grantNote()}: ${input.keys.slice(0, sent).join(", ")}; stopped because Clankie lost the terminal or its machine.`,
        );
      // A send can fail after it reached the terminal, so a failed send never proves nothing arrived.
      return {
        outcome: "uncertain",
        message:
          "The keys may or may not have reached the agent. Read its screen before doing anything else.",
      };
    }
    await note(`Pressed keys in ${label}${grantNote()}: ${input.keys.join(", ")}.`);
    return {
      outcome: "pressed",
      message:
        `Pressed in ${label}: ${input.keys.join(", ")}. Read its screen to see what it does next.`.slice(
          0,
          1_000,
        ),
    };
  };
}
