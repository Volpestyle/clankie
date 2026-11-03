import { createHash, randomUUID } from "node:crypto";
import type {
  ConversationQuestion,
  ConversationQuestionAnswer,
  ConversationQuestionResult,
} from "@clankie/protocol";
import type { PromptAnswerResult, PromptAnswerStep } from "@clankie/protocol/connector";
import type { QuestionDraft } from "./conversation-questions.ts";
import type { HerdrBoundPane } from "./herdr-watch.ts";

/** One agent pane as the fleet census sees it. */
export interface PaneAgent {
  readonly terminalId: string;
  readonly paneId: string;
  readonly agent: string;
  readonly status: string;
  readonly name: string;
  readonly workingDirectory?: string;
  /** A Clankie hire or adoption leads it; its lead hears its questions. */
  readonly led: boolean;
}

/**
 * Questions from agents Clankie didn't hire reach the owner's feed (#149). A pane
 * Herdr marks `blocked` shows a menu: a permission prompt, a numbered choice. An
 * agent with a lead has its own path (hook questions to its lead, or an owner ask);
 * one the owner opened by hand has no lead and no hooks, so its menu is read from
 * the screen and asked as an ordinary choice in the owner's conversation. Answering
 * it presses keys under the checks a connected app's answer_prompt uses (ADR 0303).
 */
export const PANE_PROMPT_ORIGIN = "pane-prompt:";

const OPTION = /^\s*(?:[❯›>▶]\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/u;
const RULE = /^[\s─━═╌┄-]{8,}$/u;
const BORDER = /^[\s│┃╭╮╰╯]+|[\s│┃╭╮╰╯]+$/gu;
/** A "Type something" option takes the owner's words instead of a pick. */
const FREEFORM = /^type something\.?$/iu;
const LABEL_MAX = 200;
const QUESTION_MAX = 500;
/** The Watch answers a check itself only within these (clankie-app watchBridge). */
const WATCH_CONTEXT_MAX = 300;

export interface PanePromptOption {
  readonly label: string;
  /** The option's 1-based number as the agent shows it. */
  readonly number: number;
}

export interface PanePrompt {
  readonly question: string;
  /** Lines the prompt itself shows above its question, such as the command it would run. */
  readonly context: readonly string[];
  readonly options: readonly PanePromptOption[];
  /** The number of the option the menu has selected now. */
  readonly selected: number;
  /** The number of a "Type something" option, when the menu has one. */
  readonly freeform?: number;
}

const clean = (line: string) => line.replace(BORDER, "").trim();

/**
 * The numbered menu at the bottom of an agent's screen, or undefined when none is
 * there. Only the prompt's own rows are kept: its question, up to three rows above it
 * back to a rule or a blank gap, and its options. Nothing else on the screen leaves.
 */
export function readPanePrompt(screen: string): PanePrompt | undefined {
  const lines = screen.split("\n").map(clean);
  // The last option 1 on the screen starts the menu.
  const first = lines.findLastIndex((line) => OPTION.exec(line)?.[1] === "1");
  if (first < 0) return undefined;
  const options: PanePromptOption[] = [];
  let selected: number | undefined;
  let freeform: number | undefined;
  let next = 1;
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = OPTION.exec(line);
    if (match && Number(match[1]) === next) {
      next += 1;
      const number = Number(match[1]);
      const label = match[2]!.slice(0, LABEL_MAX);
      if (/^[❯›>▶]/u.test(line)) selected = number;
      if (FREEFORM.test(label)) freeform = number;
      else options.push({ label, number });
      continue;
    }
    // An option's own description sits indented below it; a blank row or a rule ends the menu.
    if (line === "" || RULE.test(line)) break;
  }
  if (options.length < 2 || options.length > 8 || selected === undefined) return undefined;
  // The prompt's rows above its menu, back to a rule or a double blank row.
  const region: string[] = [];
  for (let index = first - 1, blanks = 0; index >= 0 && region.length < 8; index -= 1) {
    const line = lines[index]!;
    if (RULE.test(line)) break;
    if (line === "") {
      if (++blanks >= 2 && region.length > 0) break;
      continue;
    }
    blanks = 0;
    region.unshift(line);
  }
  const asked = region.findLastIndex((line) => line.endsWith("?"));
  const at = asked >= 0 ? asked : region.length - 1;
  const question = region[at]?.slice(0, QUESTION_MAX);
  if (!question) return undefined;
  const context = region
    .filter((_, index) => index !== at)
    .slice(-3)
    .map((line) => line.slice(0, LABEL_MAX));
  return { question, context, options, selected, ...(freeform === undefined ? {} : { freeform }) };
}

/** Same menu, same choices: the identity an ask is kept under. */
function signature(paneId: string, prompt: PanePrompt): string {
  return createHash("sha256")
    .update(JSON.stringify([paneId, prompt.question, prompt.context, prompt.options]))
    .digest("hex");
}

/** Keys that move the menu's selection from where it is to the chosen option, then confirm. */
export function stepsTo(prompt: PanePrompt, number: number): PromptAnswerStep[] {
  const distance = number - prompt.selected;
  const key = distance > 0 ? "down" : "up";
  return [...Array.from({ length: Math.abs(distance) }, () => ({ key }) as const), { key: "enter" }];
}

interface Binding {
  readonly terminalId: string;
  readonly paneId: string;
  readonly label: string;
  readonly signature: string;
  readonly origin: string;
  readonly question: string;
  requestId?: string;
  answering?: boolean;
}

export interface PanePromptAskDeps {
  /** Every agent pane on this Mac and its linked machines, with fleet-qualified ids. */
  readonly agents: () => Promise<readonly PaneAgent[]>;
  readonly bindPane: (terminalId: string) => Promise<HerdrBoundPane | undefined>;
  readonly ask: (draft: QuestionDraft, origin: string) => Promise<ConversationQuestionResult>;
  readonly cancel: (requestId: string, reason: string) => void;
  /** Pane-prompt asks still pending in the store, so ones from before a restart are retired. */
  readonly pending: () => readonly ConversationQuestion[];
  /** answer_prompt's checks, as the owner: no app switch, no owner-ask refusal. */
  readonly answer: (input: {
    terminalId: string;
    expect: string;
    steps: readonly PromptAnswerStep[];
  }) => Promise<PromptAnswerResult>;
}

export function createPanePromptAsks(deps: PanePromptAskDeps) {
  const bindings = new Map<string, Binding>();
  let flight: Promise<void> | undefined;

  const retire = (binding: Binding, reason: string) => {
    bindings.delete(binding.terminalId);
    if (binding.requestId) deps.cancel(binding.requestId, reason);
  };

  async function observe(): Promise<void> {
    const seen = new Set<string>();
    for (const agent of await deps.agents()) {
      if (agent.agent === "" || agent.status !== "blocked" || agent.led) continue;
      const held = bindings.get(agent.terminalId);
      if (held?.answering) {
        seen.add(agent.terminalId);
        continue;
      }
      let prompt: PanePrompt | undefined;
      try {
        const pane = await deps.bindPane(agent.terminalId);
        if (pane === undefined || pane.pane.paneId !== agent.paneId) continue;
        prompt = readPanePrompt(await pane.readScreen());
      } catch {
        continue; // An unreadable pane is looked at again next round.
      }
      if (prompt === undefined) continue;
      const sig = signature(agent.paneId, prompt);
      seen.add(agent.terminalId);
      if (held?.signature === sig) continue;
      if (held) retire(held, "pane_prompt_changed");
      const label = agent.name;
      const binding: Binding = {
        terminalId: agent.terminalId,
        paneId: agent.paneId,
        label,
        signature: sig,
        origin: `${PANE_PROMPT_ORIGIN}${randomUUID()}`,
        question: prompt.question,
      };
      bindings.set(agent.terminalId, binding);
      const result = await deps.ask(draft(label, agent, prompt), binding.origin);
      if (result.status === "ready" && result.question?.status === "pending")
        binding.requestId = result.question.requestId;
      else bindings.delete(agent.terminalId);
    }
    for (const binding of [...bindings.values()])
      if (!seen.has(binding.terminalId) && !binding.answering) retire(binding, "pane_prompt_gone");
    const live = new Set([...bindings.values()].map((binding) => binding.requestId));
    for (const question of deps.pending())
      if (!live.has(question.requestId)) deps.cancel(question.requestId, "pane_prompt_gone");
  }

  return {
    /** One look at every pane; overlapping calls share it. */
    sync(): Promise<void> {
      flight ??= observe().finally(() => {
        flight = undefined;
      });
      return flight;
    },

    owns(question: ConversationQuestion): boolean {
      return question.originRunId.startsWith(PANE_PROMPT_ORIGIN);
    },

    /**
     * Press the keys for the owner's answer. The menu is read again first: it must
     * be the one asked about, and the keys start from where its selection is now.
     */
    async deliver(
      question: ConversationQuestion,
      answer: ConversationQuestionAnswer,
    ): Promise<PromptAnswerResult> {
      const binding = [...bindings.values()].find((entry) => entry.origin === question.originRunId);
      const refused = (message: string): PromptAnswerResult => ({ outcome: "refused", message });
      if (binding === undefined || binding.answering)
        return refused("That agent's question is no longer open here. Read its screen again.");
      binding.answering = true;
      try {
        const pane = await deps.bindPane(binding.terminalId);
        if (pane === undefined || pane.pane.paneId !== binding.paneId)
          return { outcome: "unavailable", message: "That agent's pane isn't there now." };
        const prompt = readPanePrompt(await pane.readScreen());
        if (prompt === undefined || signature(binding.paneId, prompt) !== binding.signature)
          return refused("The agent's question changed on its screen, so nothing was pressed.");
        let steps: PromptAnswerStep[];
        if (answer.kind === "choice") {
          const index = question.options.findIndex((option) => option.optionId === answer.optionId);
          const option = prompt.options[index];
          if (option === undefined || option.number === prompt.freeform)
            return refused("That isn't one of the agent's options.");
          steps = stepsTo(prompt, option.number);
        } else if (answer.kind === "text" && prompt.freeform !== undefined) {
          steps = [...stepsTo(prompt, prompt.freeform).slice(0, -1), { text: answer.text }, { key: "enter" }];
        } else return refused("That isn't one of the agent's options.");
        return await deps.answer({ terminalId: binding.terminalId, expect: binding.question, steps });
      } finally {
        binding.answering = false;
      }
    },
  };
}

/** The ask as the owner reads it, within what the Watch answers itself where it can. */
function draft(label: string, agent: PaneAgent, prompt: PanePrompt): QuestionDraft {
  const options = prompt.options.map((option) => option.label);
  const where = agent.workingDirectory ? ` in ${agent.workingDirectory.split("/").at(-1)}` : "";
  const waiting = `${label}${where} waits on this in its pane.`;
  const recommendation = "Pick what the agent should do.";
  let shown = prompt.context.join(" · ");
  const room = WATCH_CONTEXT_MAX - prompt.question.length - waiting.length - recommendation.length - 8;
  if (shown.length > Math.max(room, 0)) shown = room > 20 ? `${shown.slice(0, room - 1)}…` : "";
  return {
    purpose: "decision",
    kind: "choice",
    prompt: shown ? `${prompt.question} (${shown})` : prompt.question,
    waitingOn: waiting,
    recommendation,
    // An agent's own question: no lead may default it, as with escalated worker questions.
    gate: "everydayWork",
    options: options.slice(0, 8).map((label) => ({ label })),
    allowFreeform: prompt.freeform !== undefined,
  };
}
