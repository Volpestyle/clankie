/**
 * What a connected app may press on the screen an agent shows now (ADR 0303, ADR 0323,
 * amended). The service reads the pane before every step and key and refuses anything
 * that would widen what the agent may do on its own, or that belongs to the owner.
 *
 * Design. A refusal must not break ordinary answering, and an ordinary Claude Code or
 * Codex permission prompt offers a "don't ask again" option next to "Yes":
 *
 *     Do you want to proceed?
 *     ❯ 1. Yes
 *       2. Yes, and don't ask again for git push commands
 *       3. No, and tell Claude what to do differently (esc)
 *
 * So the screen is read in two parts:
 *
 * - The prompt itself (the question, the command or file it asks about, and the text
 *   around it). When it matches a {@link RISKY_SCREEN_RULES} rule (a permission-mode
 *   switch, a destructive command, a credential or payment prompt) the whole screen is
 *   refused: the owner answers it, whatever the app picks.
 * - The numbered options. An option matching {@link PERSISTENT_OPTION_PATTERN} widens
 *   approval beyond this one prompt. The app may still pick the other options, but only
 *   explicitly: a digit naming a safe option, or enter while the pointer (❯ or ›) is on a
 *   safe one. On such a menu arrows, tab, space and letters are refused, because a read
 *   taken right after an arrow can still show the old pointer and a letter can be a
 *   Codex shortcut for the persistent option.
 *
 * Outside a menu or a yes/no prompt, letters and digits would type into the agent's
 * input, so press_keys refuses them there; named keys (enter, esc, arrows, ctrl+c) keep
 * working. shift+tab and alt+m are refused everywhere: outside a prompt they cycle the
 * agent's permission mode, and inside Claude Code's edit prompt shift+tab picks "allow
 * all edits during this session".
 *
 * Only the bottom of the visible screen ({@link PROMPT_REGION_LINES} non-blank lines) is
 * the prompt; older conversation above it is not judged. The patterns err toward
 * refusing: a refusal costs the owner one answer, an approval can't be taken back.
 */

/** Non-blank lines at the bottom of the screen read as the open prompt. */
const PROMPT_REGION_LINES = 30;

interface RiskyScreenRule {
  readonly id: string;
  /** Names the reason in the refusal the app reads. */
  readonly reason: string;
  readonly pattern: RegExp;
  /** `prompt` reads only the question and its context; `all` reads options too. */
  readonly scope: "prompt" | "all";
}

/** The reviewable deny-list: a screen matching any of these is the owner's to answer. */
const RISKY_SCREEN_RULES: readonly RiskyScreenRule[] = [
  {
    id: "permission-mode",
    reason: "it changes the agent's permission mode",
    scope: "prompt",
    pattern:
      /\bbypass(?:ing)?\s+permissions?\b|dangerously[- ]skip[- ]permissions|\bauto[- ]?accept|\baccept\s+edits\b|\bpermission\s+mode\b|\bapproval\s+(?:mode|policy)\b|\bfull[- ]access\b|\byolo\b/iu,
  },
  {
    id: "persistent-approval",
    reason: "it would approve more than this one prompt",
    scope: "prompt",
    pattern:
      /\bdon'?t\s+ask\s+again\b|\bdo\s+not\s+ask\s+again\b|\balways\s+allow\b|\ballow\s+always\b|\ballow\s+(?:all\s+\w+\s+)?(?:for|during)\s+(?:this|the)\s+session\b|\byes,\s+and\s+don'?t\s+ask\b/iu,
  },
  {
    id: "recursive-delete",
    reason: "it deletes files recursively (rm -rf)",
    scope: "all",
    pattern:
      /\brm\s+(?:-{1,2}\S+\s+)*(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|(?:-r|--recursive)\s+(?:-f|--force)|(?:-f|--force)\s+(?:-r|--recursive))(?=\s|$)/iu,
  },
  {
    id: "force-push",
    reason: "it force-pushes (git push --force)",
    scope: "all",
    pattern:
      /\bgit\b[^\n]*\bpush\b[^\n]*(?:\s--force(?:-with-lease|-if-includes)?\b|\s-[a-z]*f[a-z]*(?=\s|$)|\s\+[^\s]+)/iu,
  },
  {
    id: "credentials",
    reason: "it touches a password, token, key or sign-in",
    scope: "all",
    pattern:
      /\bpass(?:word|phrase|code)s?\b|\b(?:api|secret|private|access|auth|bearer|refresh|session|oauth|github|npm)[ _-]?(?:key|token)s?\b|\bcredentials?\b|\bkeychain\b|\b(?:two[- ]factor|2fa|one[- ]time\s+(?:code|password)|verification\s+code)\b|\b(?:log|sign)[ -]?in\s+(?:to|with|required|again)\b|\bauthenticat(?:e|ion)\s+(?:required|needed|to)\b|\b(?:enter|paste|type)\s+(?:your|the|a)\s+(?:\w+\s+)?(?:token|key|code|secret)\b/iu,
  },
  {
    id: "payment",
    reason: "it spends money",
    scope: "all",
    pattern:
      /\b(?:payment|purchase|credit\s+card|card\s+number|billing|checkout|buy\s+now|subscribe|upgrade\s+(?:your\s+)?plan)\b/iu,
  },
];

/** A numbered option that would approve beyond this one prompt. */
const PERSISTENT_OPTION_PATTERN =
  /\bdon'?t\s+ask\b|\bdo\s+not\s+ask\b|\balways\b|\b(?:for|during)\s+(?:this|the)\s+session\b|\bfor\s+the\s+rest\b|\ballow\s+all\b|\byes\s+to\s+all\b|\bremember\b|\bauto[- ]?accept|\baccept\s+edits\b|\bbypass\b|\bfull[- ]access\b/iu;

/** Typed text that would run a command or change the agent's mode, not answer a question. */
const COMMAND_TEXT = /^\s*[/!]/u;

/** Footer lines that only report the agent's current mode, never a question. */
const STATUS_LINE = /shift\+tab\s+to\s+cycle/iu;
/** A dialog's side borders; its indentation inside them is kept. */
const BOX_SIDES = /^\s*[│┃]\s?|\s*[│┃]\s*$/gu;
const BOX_RULE = /^[\s╭╮╰╯─━┌┐└┘]*$/u;
const OPTION_LINE = /^(?:([❯›▶➤>→])\s*)?(?:\[[ x✔]\]\s*)?(\d{1,2})[.)]\s+(\S.*)$/u;
const YES_NO = /\((?:y\/n|yes\/no)\)|\[(?:y\/n|yes\/no)\]/iu;

interface PromptOption {
  readonly number: number;
  readonly text: string;
  readonly pointed: boolean;
  readonly persistent: boolean;
}

export interface PromptScreen {
  /** Numbered options at least 1 and 2, or a (y/n) question. */
  readonly menu: boolean;
  readonly yesNo: boolean;
  readonly options: readonly PromptOption[];
  /** The first risky rule the open prompt matches. */
  readonly risky?: RiskyScreenRule;
}

/** Read the open prompt at the bottom of a pane's visible text. */
export function readPromptScreen(screen: string): PromptScreen {
  const lines = screen
    .split(/\r?\n/u)
    .map((line) => line.replace(BOX_SIDES, "").trimEnd())
    .filter((line) => !BOX_RULE.test(line) && !STATUS_LINE.test(line))
    .slice(-PROMPT_REGION_LINES);
  const options: { number: number; text: string; pointed: boolean }[] = [];
  const prompt: string[] = [];
  let last: (typeof options)[number] | undefined;
  for (const line of lines) {
    const option = OPTION_LINE.exec(line.trim());
    if (option) {
      last = { number: Number(option[2]), text: option[3]!, pointed: option[1] !== undefined };
      options.push(last);
    } else if (last !== undefined && /^\s{3,}\S/u.test(line) && !/[?:]\s*$/u.test(line)) {
      // A wrapped option continues on an indented line below it.
      last.text = `${last.text} ${line.trim()}`;
    } else {
      last = undefined;
      prompt.push(line);
    }
  }
  const numbered = options.some((option) => option.number === 1) && options.some((o) => o.number === 2);
  const promptText = prompt.join("\n");
  const allText = [promptText, ...options.map((option) => option.text)].join("\n");
  const risky = RISKY_SCREEN_RULES.find((rule) =>
    rule.pattern.test(rule.scope === "prompt" ? promptText : allText),
  );
  const yesNo = YES_NO.test(promptText);
  return {
    menu: numbered || yesNo,
    yesNo,
    options: options.map((option) => ({
      ...option,
      persistent: PERSISTENT_OPTION_PATTERN.test(option.text),
    })),
    ...(risky === undefined ? {} : { risky }),
  };
}

const NAVIGATION = new Set([
  "up",
  "down",
  "tab",
  "space",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

/**
 * Why this one step may not go to a pane showing `screen` now, or undefined when it may.
 * A step is a named key (`enter`, `ctrl+c`, `down`, `a`, `7`) or text typed as it is.
 */
export function refuseStep(
  screen: string,
  step: { readonly key: string } | { readonly text: string },
): string | undefined {
  const read = readPromptScreen(screen);
  if (read.risky) return `the screen is the owner's to answer: ${read.risky.reason}`;
  const persistent = read.options.filter((option) => option.persistent);
  const persistentMenu = read.menu && persistent.length > 0;
  const picks = (raw: string) => {
    const number = Number(raw);
    return persistent.some((option) => option.number === number)
      ? "it would pick an option that approves more than this one prompt"
      : read.options.length > 0 && !read.options.some((option) => option.number === number)
        ? "no option on the screen has that number"
        : undefined;
  };
  if ("text" in step) {
    const text = step.text.trim();
    if (/^\d{1,2}$/u.test(text)) return read.menu ? picks(text) : undefined;
    if (persistentMenu && text.length <= 1)
      return "on a menu that offers to approve more than this prompt, pick an option by its number";
    if (COMMAND_TEXT.test(text)) return "typed text may not start a command (/ or !)";
    if (PERSISTENT_OPTION_PATTERN.test(text) || RISKY_SCREEN_RULES.some((rule) => rule.pattern.test(text)))
      return "the typed text asks for something the owner must answer";
    return undefined;
  }
  const key = step.key.toLowerCase();
  const modifiers = key.split("+").slice(0, -1);
  const base = key.split("+").at(-1)!;
  if (key === "shift+tab" || (modifiers.includes("shift") && base === "tab"))
    return "shift+tab changes the agent's permission mode or approves edits for the session";
  if (modifiers.includes("alt") && /^[a-z]$/u.test(base))
    return "alt with a letter can change the agent's mode";
  if (modifiers.length === 0 || (modifiers.length === 1 && modifiers[0] === "shift")) {
    if (/^\d$/u.test(base)) {
      if (!read.menu) return "a digit is only pressed to pick a menu option; it would type into the agent";
      return picks(base);
    }
    if (/^[a-z]$/u.test(base)) {
      if (!read.menu)
        return "a letter is only pressed at a menu or yes/no prompt; it would type into the agent";
      if (persistentMenu) return "on a menu that offers to approve more than this prompt, pick by number";
      if (read.yesNo && !read.options.length && base !== "y" && base !== "n")
        return "a yes/no prompt takes only y or n";
      return undefined;
    }
  }
  if (persistentMenu && NAVIGATION.has(key))
    return "on a menu that offers to approve more than this prompt, pick an option by its number";
  if (persistentMenu && key === "enter") {
    const pointed = read.options.find((option) => option.pointed);
    if (pointed === undefined || pointed.persistent)
      return "enter would pick an option that approves more than this one prompt";
  }
  return undefined;
}
