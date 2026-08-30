import { SettingsStore, type PersonaSettings } from "@clankie/settings";
import { formatPersonaLines, personaStatus, personaUpdate } from "./command/persona.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface PersonaCommandServices {
  settings: SettingsStore;
}

/**
 * `/persona` edits **who Clankie is**, not what he may do.
 *
 * Character is deliberately owner-authored: the code carries a personality, it
 * does not invent one. Authority is unreachable from here — a warmer persona
 * never widens permission.
 */
export function buildPersonaCommands(services: PersonaCommandServices): FaceShellCommand[] {
  return [
    {
      name: "persona",
      aliases: [],
      description: "Edit Clankie's character, names, and how readily he speaks",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "status") {
          await showPersonaStatus(shell, services);
          return;
        }
        await runPersonaWizard(shell, services);
      },
    },
  ];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Typed input wins; blank keeps what was already configured. */
function resolvePersonaText(typed: string, existing: string): string {
  return typed.trim().length > 0 ? typed.trim() : existing;
}

async function showPersonaStatus(shell: ClankieFaceShell, services: PersonaCommandServices): Promise<void> {
  const result = await personaStatus({ settings: services.settings });
  shell.insertCommandResult(
    "/persona status",
    [`settings file: ${result.settingsFile}`, "", ...formatPersonaLines(result.persona)].join("\n"),
    "success",
  );
}

async function runPersonaWizard(shell: ClankieFaceShell, services: PersonaCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("persona");
  try {
    for (;;) {
      const action = await flow.readSelect({
        message: "Character",
        options: [
          {
            value: "character",
            label: "Character",
            hint: "who he is",
            description: "Free-text personality carried into every surface.",
          },
          {
            value: "names",
            label: "Name and aliases",
            hint: "what he answers to",
            description: "Used both for display and to decide whether a message addressed him.",
          },
          {
            value: "voice",
            label: "How much he talks",
            hint: "chattiness and reply policy",
          },
          { value: "status", label: "Show status" },
          { value: "done", label: "Done" },
        ],
      });
      const choice = action;
      if (choice === undefined || choice === "done") break;
      if (choice === "status") {
        await showPersonaStatus(shell, services);
        continue;
      }
      if (choice === "character") await editCharacter(shell, services);
      else if (choice === "names") await editNames(shell, services);
      else if (choice === "voice") await editVoice(shell, services);
    }
  } finally {
    flow.end();
  }
}

async function editCharacter(shell: ClankieFaceShell, services: PersonaCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).persona;
  const notes = await flow.readText({
    message: "Character — how he acts, jokes, and carries himself",
    defaultValue: current.characterNotes,
    placeholder: "chill, likes to roast, genuinely helpful",
    multiline: true,
    allowBack: true,
    validate: (value: string) => (value.length > 4_000 ? "Keep it under 4000 characters." : undefined),
  });
  if (notes === undefined) return;
  await personaUpdate(
    { characterNotes: resolvePersonaText(notes, current.characterNotes) },
    { settings: services.settings },
  );
  flow.renderLine("Saved character. New Discord and voice turns pick it up.", "success");
}

async function editNames(shell: ClankieFaceShell, services: PersonaCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).persona;
  let displayNameDraft = current.displayName;

  for (;;) {
    const displayName = await flow.readText({
      message: "Name",
      defaultValue: displayNameDraft,
      allowBack: true,
      validate: (value: string) => (value.trim().length > 64 ? "Keep it under 64 characters." : undefined),
    });
    if (displayName === undefined) return;
    displayNameDraft = displayName;

    // Humans shorten and misspell names constantly; every alias here is another
    // way someone can get his attention without an @mention.
    const aliases = await flow.readText({
      message: "Other names he answers to (comma separated)",
      defaultValue: current.aliases.join(", "),
      placeholder: "Clanky, clanker",
      allowBack: true,
      validate: (value: string) => (splitList(value).length > 16 ? "At most 16 aliases." : undefined),
    });
    if (aliases === undefined) continue;

    await personaUpdate(
      {
        displayName: resolvePersonaText(displayName, current.displayName),
        ...(aliases.trim() ? { aliases: splitList(aliases) } : {}),
      },
      { settings: services.settings },
    );
    flow.renderLine("Saved names.", "success");
    return;
  }
}

async function editVoice(shell: ClankieFaceShell, services: PersonaCommandServices): Promise<void> {
  const flow = shell.setupFlow;

  for (;;) {
    const chattiness = await flow.readSelect({
      message: "How talkative is he by nature?",
      options: [
        { value: "quiet", label: "Quiet", hint: "short, sparing" },
        { value: "balanced", label: "Balanced", hint: "a sentence or two" },
        { value: "chatty", label: "Chatty", hint: "takes more room" },
      ],
      allowBack: true,
    });
    const chattinessChoice = chattiness;
    if (chattinessChoice === undefined) return;

    const replyPolicy = await flow.readSelect({
      message: "Which admitted text messages should he see?",
      options: [
        {
          value: "all",
          label: "Every message",
          hint: "recommended",
          description: "He sees each message and decides for himself whether speaking would add anything.",
        },
        {
          value: "addressed",
          label: "When addressed",
          description:
            "Only a mention or one of his names spends a model turn; useful when cost matters more.",
        },
      ],
      allowBack: true,
    });
    const replyChoice = replyPolicy;
    if (replyChoice === undefined) continue;

    await personaUpdate(
      {
        chattiness: chattinessChoice as PersonaSettings["chattiness"],
        replyPolicy: replyChoice as PersonaSettings["replyPolicy"],
      },
      { settings: services.settings },
    );
    flow.renderLine(
      replyChoice === "all"
        ? "Saved. He will read every admitted message and choose when to speak — restart the bridge to apply."
        : "Saved. Restart the bridge to apply.",
      "success",
    );
    return;
  }
}
