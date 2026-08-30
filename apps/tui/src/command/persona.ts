import { SettingsStore, defaultSettingsPath, type PersonaSettings } from "@clankie/settings";

const PERSONA_USAGE = [
  "Usage: clankie persona [status]",
  "       clankie persona set [--display-name NAME] [--aliases name,name]",
  "                           [--character-notes TEXT] [--chattiness quiet|balanced|chatty]",
  "                           [--reply-policy addressed|all] [--live-message-window N]",
].join("\n");

export interface PersonaCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface PersonaCommandResult {
  readonly ok: true;
  readonly persona: PersonaSettings;
  readonly settingsFile: string;
  readonly restart: string;
}

function store(options: PersonaCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

export function formatPersonaLines(persona: PersonaSettings): string[] {
  const notes = persona.characterNotes.trim();
  return [
    `name: ${persona.displayName}`,
    `also answers to: ${persona.aliases.length === 0 ? "—" : persona.aliases.join(", ")}`,
    `chattiness: ${persona.chattiness}`,
    `reads text channels: ${persona.replyPolicy === "all" ? "every admitted message" : "when addressed"}`,
    "",
    "character:",
    ...(notes.length === 0
      ? ["  (none set — he will sound like a default assistant)"]
      : notes.split("\n").map((line) => `  ${line}`)),
  ];
}

export async function personaStatus(options: PersonaCommandOptions = {}): Promise<PersonaCommandResult> {
  const settings = store(options);
  return {
    ok: true,
    persona: (await settings.load()).persona,
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
}

export async function personaUpdate(
  patch: Partial<PersonaSettings>,
  options: PersonaCommandOptions = {},
): Promise<PersonaCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({
    ...current,
    persona: { ...current.persona, ...patch },
  }));
  return {
    ok: true,
    persona: updated.persona,
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
}

function parseSetArgs(args: readonly string[]): Partial<PersonaSettings> {
  const patch: Partial<PersonaSettings> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined) throw new Error(PERSONA_USAGE);
    if (flag === "--display-name") patch.displayName = value;
    else if (flag === "--aliases") {
      patch.aliases =
        value.toLowerCase() === "none"
          ? []
          : value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
    } else if (flag === "--character-notes") patch.characterNotes = value;
    else if (flag === "--chattiness") patch.chattiness = value as PersonaSettings["chattiness"];
    else if (flag === "--reply-policy") patch.replyPolicy = value as PersonaSettings["replyPolicy"];
    else if (flag === "--live-message-window") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) throw new Error("Live message window must be a whole number.");
      patch.liveMessageWindow = parsed;
    } else throw new Error(PERSONA_USAGE);
  }
  if (Object.keys(patch).length === 0) throw new Error(PERSONA_USAGE);
  return patch;
}

export async function runPersonaCommand(
  args: readonly string[],
  options: PersonaCommandOptions = {},
): Promise<PersonaCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await personaStatus(options);
  if (verb === "set") return await personaUpdate(parseSetArgs(args.slice(1)), options);
  throw new Error(PERSONA_USAGE);
}
