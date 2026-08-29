import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

type Awaitable<T> = T | Promise<T>;

export type ClankieAutocompleteCommand = {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly argumentHint?: string;
  readonly takesArgument: boolean;
};

export type ClankieAutocompleteOptions = {
  readonly listSkills?: () => Awaitable<readonly ClankieAutocompleteSkill[]>;
};

export type ClankieAutocompleteSkill = {
  readonly name: string;
  readonly description: string;
};

type ArgumentContext = {
  readonly args: readonly string[];
  readonly prefix: string;
};

type StaticArgumentSpec = {
  readonly values: readonly AutocompleteItem[];
  readonly examples: readonly string[];
};

export type ClankieCommandSearchItem = {
  readonly command: ClankieAutocompleteCommand;
  readonly category: string;
  readonly invocation: string;
  readonly aliasesText: string;
};

export type ClankieCommandDetail = {
  readonly invocation: string;
  readonly category: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly validArgs: readonly AutocompleteItem[];
  readonly examples: readonly string[];
  readonly warning?: string | undefined;
};

const ARGUMENT_SUGGESTION_LIMIT = 18;

export function createClankieAutocompleteProvider(
  commands: readonly ClankieAutocompleteCommand[],
  basePath: string,
  options: ClankieAutocompleteOptions = {},
): AutocompleteProvider {
  return new ClankieAutocompleteProvider(commands, basePath, options);
}

export function searchClankieCommands(
  commands: readonly ClankieAutocompleteCommand[],
  query: string,
): ClankieCommandSearchItem[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return listClankieCommands(commands);
  return fuzzyFilter([...commands], trimmed, commandSearchText).map(commandSearchItem);
}

export function listClankieCommands(
  commands: readonly ClankieAutocompleteCommand[],
): ClankieCommandSearchItem[] {
  return commands.map(commandSearchItem);
}

export function describeClankieCommand(
  command: ClankieAutocompleteCommand,
  argumentText = "",
): ClankieCommandDetail {
  const context = argumentContext(argumentText);
  const staticSpec = staticArgumentSpec(command.name, context);
  return {
    invocation: commandInvocation(command),
    category: commandCategory(command.name),
    aliases: command.aliases,
    description: command.description,
    validArgs: staticSpec.values,
    examples: staticSpec.examples,
    warning: argumentWarning(command, staticSpec, argumentText),
  };
}

export function clankieCommandCompletion(command: ClankieAutocompleteCommand): string {
  return `/${command.name}${command.takesArgument ? " " : ""}`;
}

class ClankieAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters: string[] = ["$"];
  private readonly commands: readonly ClankieAutocompleteCommand[];
  private readonly delegate: CombinedAutocompleteProvider;
  private readonly options: ClankieAutocompleteOptions;

  constructor(
    commands: readonly ClankieAutocompleteCommand[],
    basePath: string,
    options: ClankieAutocompleteOptions,
  ) {
    this.commands = commands;
    this.delegate = new CombinedAutocompleteProvider([], basePath);
    this.options = options;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const skillPrefix = skillMentionPrefix(textBeforeCursor);
    if (skillPrefix !== undefined) {
      const skills = await this.options.listSkills?.();
      const items = fuzzyFilter(
        [...(skills ?? [])],
        skillPrefix.slice(1),
        (skill) => `${skill.name} ${skill.description}`,
      ).map((skill) => ({
        value: skill.name,
        label: `$${skill.name}`,
        description: skill.description,
      }));
      return items.length === 0 ? null : { items, prefix: skillPrefix };
    }
    if (!textBeforeCursor.trimStart().startsWith("/")) {
      return await this.delegate.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    const parsed = parseSlashInput(textBeforeCursor.trimStart());
    if (parsed.commandToken.length === 0 || !parsed.hasArgumentText) return null;

    const match = findCommand(this.commands, parsed.commandToken);
    if (match === undefined || !match.command.takesArgument) return null;

    const context = argumentContext(parsed.argumentText);
    const items = await this.argumentSuggestions(match.command.name, context);
    if (items.length === 0) return null;
    return { items: items.slice(0, ARGUMENT_SUGGESTION_LIMIT), prefix: context.prefix };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    if (prefix.startsWith("$")) {
      const beforePrefix = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
      const completed = `${beforePrefix}$${item.value} `;
      const nextLines = [...lines];
      nextLines[cursorLine] = completed + currentLine.slice(cursorCol).replace(/^\s+/u, "");
      return { lines: nextLines, cursorLine, cursorCol: completed.length };
    }
    if (!textBeforeCursor.trimStart().startsWith("/")) {
      return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    const beforePrefix = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
    const afterCursor = currentLine.slice(cursorCol);
    const isCommandCompletion = prefix.startsWith("/");
    const completed = isCommandCompletion
      ? `${beforePrefix}/${item.value} `
      : `${beforePrefix}${item.value} `;
    const nextLines = [...lines];
    nextLines[cursorLine] = completed + afterCursor.replace(/^\s+/u, "");
    return { lines: nextLines, cursorLine, cursorCol: completed.length };
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const currentLine = lines[cursorLine] ?? "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    if (skillMentionPrefix(textBeforeCursor) !== undefined) return true;
    if (textBeforeCursor.trimStart().startsWith("/")) return true;
    return this.delegate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
  }

  private async argumentSuggestions(
    commandName: string,
    context: ArgumentContext,
  ): Promise<AutocompleteItem[]> {
    const items = staticArgumentSpec(commandName, context).values;
    return fuzzyFilter(
      [...items],
      context.prefix,
      (item) => `${item.value} ${item.label} ${item.description ?? ""}`,
    );
  }
}

function skillMentionPrefix(textBeforeCursor: string): string | undefined {
  return /(?:^|\s)(\$[a-z0-9-]*)$/iu.exec(textBeforeCursor)?.[1];
}

function parseSlashInput(text: string): {
  commandToken: string;
  argumentText: string;
  hasArgumentText: boolean;
} {
  const withoutSlash = text.startsWith("/") ? text.slice(1) : text;
  const match = /^(\S*)(\s+([\s\S]*))?$/u.exec(withoutSlash);
  return {
    commandToken: match?.[1]?.toLowerCase() ?? "",
    argumentText: match?.[3] ?? "",
    hasArgumentText: match?.[2] !== undefined,
  };
}

function argumentContext(argumentText: string): ArgumentContext {
  const trimmedLeft = argumentText.replace(/^\s+/u, "");
  const endsWithSpace = /\s$/u.test(argumentText);
  const args = splitArgumentTokens(trimmedLeft);
  const prefix = endsWithSpace ? "" : (args.at(-1) ?? "");
  return { args, prefix };
}

function splitArgumentTokens(text: string): string[] {
  return text.trim().length === 0 ? [] : text.trim().split(/\s+/u);
}

/**
 * Resolve a slash token to a command. A real command name always wins over an
 * earlier command's leftover alias — otherwise `/connect` would open `/auth`.
 */
export function resolveClankieCommand<T extends ClankieAutocompleteCommand>(
  commands: readonly T[],
  token: string,
): { readonly command: T; readonly canonical: boolean } | undefined {
  return findCommand(commands, token);
}

function findCommand<T extends ClankieAutocompleteCommand>(
  commands: readonly T[],
  token: string,
): { readonly command: T; readonly canonical: boolean } | undefined {
  const normalized = token.toLowerCase();
  const command = commands.find((entry) => entry.name === normalized);
  if (command !== undefined) return { command, canonical: true };
  const alias = commands.find((entry) => entry.aliases.some((value) => value === normalized));
  return alias === undefined ? undefined : { command: alias, canonical: false };
}

function commandSearchItem(command: ClankieAutocompleteCommand): ClankieCommandSearchItem {
  return {
    command,
    category: commandCategory(command.name),
    invocation: commandInvocation(command),
    aliasesText: command.aliases.map((alias) => `/${alias}`).join(", "),
  };
}

function commandInvocation(command: ClankieAutocompleteCommand): string {
  return `/${command.name}${command.argumentHint === undefined ? "" : ` ${command.argumentHint}`}`;
}

function commandSearchText(command: ClankieAutocompleteCommand): string {
  return [
    command.name,
    ...command.aliases,
    command.description,
    command.argumentHint ?? "",
    commandCategory(command.name),
  ].join(" ");
}

function commandCategory(commandName: string): string {
  if (["model", "provider", "auth", "effort", "image-model", "video-model"].includes(commandName))
    return "model/auth";
  if (["trace", "layout", "status", "board", "clear", "exit"].includes(commandName)) return "runtime";
  if (commandName === "connect") return "tools";
  if (["voice", "discord", "vt"].includes(commandName)) return "discord";
  return "command";
}

function staticArgumentSpec(commandName: string, context: ArgumentContext): StaticArgumentSpec {
  switch (commandName) {
    case "board":
      return values(["focus", "close"], ["/board", "/board focus", "/board close"]);
    case "discord":
      return values(["status", "invite"], ["/discord status", "/discord invite"]);
    case "model":
      return modelArguments("model");
    case "provider":
      return modelArguments("provider");
    case "auth":
      return authArguments(context);
    case "trace":
      return values(
        ["status", "all", "off", "discord_presence", "discord_voice", "gameplay"],
        ["/trace discord_presence", "/trace all", "/trace off"],
      );
    case "vt":
      return values(["off"], ["/vt", "/vt off"]);
    case "layout":
      return layoutArguments(context);
    case "connect":
      return connectArguments(context);
    case "voice":
      return voiceArguments(context);
    case "image-model":
      return imageModelArguments(context);
    case "video-model":
      return videoModelArguments(context);
    default:
      return { values: [], examples: [] };
  }
}

function modelArguments(command: "model" | "provider"): StaticArgumentSpec {
  return values(["status"], [`/${command}`, `/${command} status`]);
}

function authArguments(context: ArgumentContext): StaticArgumentSpec {
  const action = context.args[0]?.toLowerCase();
  if (action === "status") return { values: [], examples: ["/auth status"] };
  if (action === "mcp") return { values: [], examples: ["/auth mcp linear", "/auth mcp figma"] };
  return values(["status", "mcp"], ["/auth status", "/auth mcp linear"]);
}

function layoutArguments(context: ArgumentContext): StaticArgumentSpec {
  const setting = context.args[0]?.toLowerCase();
  if (setting === "input") {
    return values(["top", "bottom"], ["/layout input top", "/layout input bottom"]);
  }
  if (setting === "status") {
    return values(
      ["above", "below", "above-input", "below-input"],
      ["/layout status above", "/layout status below"],
    );
  }
  if (setting === "header") {
    return values(["on", "off", "toggle", "status"], ["/layout header off", "/layout header on"]);
  }
  return values(
    ["status", "input", "header"],
    ["/layout input top", "/layout status below", "/layout header off"],
  );
}

/**
 * Only providers this repository has an adapter for, named by their catalog id
 * (`google`, not `gemini`) — the id is what `/image-model` writes into the
 * config ref, so a friendlier alias here would complete to a setting the
 * service cannot resolve.
 */
function imageModelArguments(context: ArgumentContext): StaticArgumentSpec {
  const provider = context.args[0]?.toLowerCase();
  if (provider === "openai") return values(["gpt-image-2"], ["/image-model openai gpt-image-2"]);
  if (provider === "xai")
    return values(["grok-imagine-image-quality"], ["/image-model xai grok-imagine-image-quality"]);
  if (provider === "google")
    return values(["gemini-3.1-flash-image"], ["/image-model google gemini-3.1-flash-image"]);
  return values(
    ["status", "openai", "xai", "google", "unset"],
    ["/image-model status", "/image-model openai gpt-image-2", "/image-model google gemini-3.1-flash-image"],
  );
}

function videoModelArguments(context: ArgumentContext): StaticArgumentSpec {
  if (context.args[0]?.toLowerCase() === "xai")
    return values(["grok-imagine-video-1.5"], ["/video-model xai grok-imagine-video-1.5"]);
  return values(
    ["status", "xai", "unset"],
    ["/video-model status", "/video-model xai grok-imagine-video-1.5"],
  );
}

function connectArguments(context: ArgumentContext): StaticArgumentSpec {
  if (context.args[0]?.toLowerCase() === "status") return { values: [], examples: ["/connect status"] };
  return values(
    ["status", "linear", "email", "discord"],
    ["/connect status", "/connect linear", "/connect email", "/connect discord"],
  );
}

function voiceArguments(context: ArgumentContext): StaticArgumentSpec {
  const setting = context.args[0]?.toLowerCase();
  if (setting === "status") return { values: [], examples: ["/voice status"] };
  // The bare command opens the wizard (provider, ElevenLabs voice/model/key);
  // `status` is its only argument (ADR 0070).
  return values(["status"], ["/voice", "/voice status"]);
}

function values(valuesList: readonly string[], examples: readonly string[]): StaticArgumentSpec {
  return {
    values: valuesList.map((value) => ({ value, label: value })),
    examples,
  };
}

function argumentWarning(
  command: ClankieAutocompleteCommand,
  staticSpec: StaticArgumentSpec,
  argumentText: string,
): string | undefined {
  if (!command.takesArgument && argumentText.trim().length > 0) return "this command does not take arguments";
  const first = splitArgumentTokens(argumentText)[0];
  if (first === undefined || first.length === 0) return undefined;
  const hasStaticFirstArgs = staticArgumentSpec(command.name, { args: [], prefix: "" }).values.length > 0;
  if (!hasStaticFirstArgs) return undefined;
  const validFirstArgs = new Set(
    staticArgumentSpec(command.name, { args: [], prefix: "" }).values.map((item) => item.value),
  );
  if (validFirstArgs.has(first)) return undefined;
  if (staticSpec.values.some((item) => item.value === first)) return undefined;
  const closeFirstArgs = fuzzyFilter([...validFirstArgs], first, (value) => value);
  if (closeFirstArgs.length > 0) return undefined;
  return `unknown first arg "${first}"`;
}
