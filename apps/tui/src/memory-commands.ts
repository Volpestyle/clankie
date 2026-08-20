import type { ClankieApiClient } from "@clankie/api-client";
import type {
  CaptainEpisode,
  DiscordPersonIdentity,
  DiscordPersonMemoryFact,
  DiscordPersonMemoryVisibility,
  OperatorMemoryCatalog,
} from "@clankie/protocol";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export type MemoryCommandClient = Pick<
  ClankieApiClient,
  | "deleteCaptainEpisode"
  | "deleteDiscordPersonMemoryFact"
  | "inspectMemory"
  | "updateCaptainEpisode"
  | "updateDiscordPersonMemoryFact"
>;

export interface MemoryCommandServices {
  readonly client?: MemoryCommandClient;
}

export function buildMemoryCommands(services: MemoryCommandServices): FaceShellCommand[] {
  return [
    {
      name: "memory",
      aliases: ["memories"],
      description: "Browse, edit, or forget Clankie's durable memory",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const label = argument.trim() === "status" ? "/memory status" : "/memory";
        if (services.client === undefined) {
          shell.insertCommandResult(
            label,
            "Memory requires the local operator credential. Restart the console after configuring it.",
            "error",
          );
          return;
        }
        try {
          const catalog = await services.client.inspectMemory();
          if (argument.trim() === "status") {
            shell.insertCommandResult(label, formatMemoryCatalog(catalog), "success");
            return;
          }
          await runMemoryBrowser(shell, services.client, catalog);
        } catch (error) {
          shell.insertCommandResult(label, error instanceof Error ? error.message : String(error), "error");
        }
      },
    },
  ];
}

export function formatMemoryCatalog(catalog: OperatorMemoryCatalog): string {
  const lines = [`Clankie's episodes (${String(catalog.captainEpisodes.length)})`];
  for (const episode of newestEpisodes(catalog.captainEpisodes)) {
    lines.push(
      `- ${episode.occurredAt} · ${episode.lane}/${episode.targetId} · ${episode.visibility} · ${episode.episodeId}`,
      `  ${episode.summary}`,
    );
  }
  const factCount = catalog.discordPeople.reduce((count, person) => count + person.facts.length, 0);
  lines.push("", `People (${String(catalog.discordPeople.length)} people, ${String(factCount)} facts)`);
  for (const person of catalog.discordPeople) {
    lines.push(`- ${person.subject.guildId}/${person.subject.userId}`);
    for (const fact of person.facts) {
      lines.push(
        `  - ${fact.kind} · ${visibilityLabel(fact.visibility)} · ${fact.confidence.toFixed(2)} · ${fact.factId}`,
        `    ${fact.body}`,
      );
    }
  }
  if (catalog.captainEpisodes.length === 0 && factCount === 0) lines.push("", "No memories yet.");
  return lines.join("\n");
}

async function runMemoryBrowser(
  shell: ClankieFaceShell,
  client: MemoryCommandClient,
  catalog: OperatorMemoryCatalog,
): Promise<void> {
  const flow = shell.setupFlow;
  const factCount = catalog.discordPeople.reduce((count, person) => count + person.facts.length, 0);
  flow.begin("memory");
  try {
    const selected = await flow.readSelect({
      message: "Clankie's memory",
      options: [
        {
          value: "episodes",
          label: "His episodes",
          hint: `${String(catalog.captainEpisodes.length)} notes`,
          description: "Things Clankie chose to remember doing.",
        },
        {
          value: "people",
          label: "People",
          hint: `${String(factCount)} facts`,
          description: "Approved facts about people, scoped by Discord server and user.",
        },
        { value: "done", label: "Done" },
      ],
    });
    if (selected === "episodes") await browseEpisodes(shell, client, catalog.captainEpisodes);
    else if (selected === "people") await browsePeople(shell, client, catalog);
  } finally {
    flow.end();
  }
}

async function browseEpisodes(
  shell: ClankieFaceShell,
  client: MemoryCommandClient,
  episodes: readonly CaptainEpisode[],
): Promise<void> {
  const ordered = newestEpisodes(episodes);
  if (ordered.length === 0) {
    shell.setupFlow.renderLine("No episodes yet.", "info");
    return;
  }
  const picked = await shell.setupFlow.readSelect({
    message: "Episode",
    options: ordered.map((episode, index) => ({
      value: String(index),
      label: truncate(episode.summary),
      hint: `${episode.lane} · ${episode.occurredAt.slice(0, 10)}`,
      description: `${episode.targetId} · ${episode.visibility} · ${episode.episodeId}`,
    })),
  });
  const episode = picked === undefined ? undefined : ordered[Number(picked)];
  if (episode === undefined) return;
  const action = await shell.setupFlow.readSelect({
    message: truncate(episode.summary, 96),
    options: [
      { value: "edit", label: "Edit", hint: "note and visibility" },
      { value: "forget", label: "Forget", hint: "delete this episode" },
      { value: "back", label: "Back" },
    ],
  });
  if (action === "edit") await editEpisode(shell, client, episode);
  else if (action === "forget" && (await confirmForget(shell, "episode"))) {
    await client.deleteCaptainEpisode(episode.lane, episode.episodeId);
    shell.setupFlow.renderLine("Forgot episode.", "success");
  }
}

async function editEpisode(
  shell: ClankieFaceShell,
  client: MemoryCommandClient,
  episode: CaptainEpisode,
): Promise<void> {
  const summary = await shell.setupFlow.readText({
    message: "What should Clankie remember?",
    defaultValue: episode.summary,
    validate: (value) =>
      value.trim().length === 0 || value.trim().length > 512 ? "Use 1–512 characters." : undefined,
  });
  if (summary === undefined) return;
  const visibility = await shell.setupFlow.readSelect({
    message: "Where may this resurface?",
    options: [
      { value: "shareable", label: "Shareable", hint: "any relevant room" },
      { value: "operator_private", label: "Operator only", hint: "private console" },
    ],
    initialValue: episode.visibility,
  });
  if (visibility === undefined) return;
  await client.updateCaptainEpisode(episode.lane, episode.episodeId, {
    summary: summary.trim(),
    visibility: visibility as CaptainEpisode["visibility"],
  });
  shell.setupFlow.renderLine("Saved episode.", "success");
}

type PersonFact = { readonly subject: DiscordPersonIdentity; readonly fact: DiscordPersonMemoryFact };

async function browsePeople(
  shell: ClankieFaceShell,
  client: MemoryCommandClient,
  catalog: OperatorMemoryCatalog,
): Promise<void> {
  const facts: PersonFact[] = catalog.discordPeople.flatMap((person) =>
    person.facts.map((fact) => ({ subject: person.subject, fact })),
  );
  if (facts.length === 0) {
    shell.setupFlow.renderLine("No person memories yet.", "info");
    return;
  }
  const picked = await shell.setupFlow.readSelect({
    message: "Person memory",
    options: facts.map(({ subject, fact }, index) => ({
      value: String(index),
      label: truncate(fact.body),
      hint: `${subject.guildId}/${subject.userId} · ${fact.kind}`,
      description: `${visibilityLabel(fact.visibility)} · confidence ${fact.confidence.toFixed(2)} · ${fact.factId}`,
    })),
  });
  const selected = picked === undefined ? undefined : facts[Number(picked)];
  if (selected === undefined) return;
  const action = await shell.setupFlow.readSelect({
    message: truncate(selected.fact.body, 96),
    options: [
      { value: "edit", label: "Edit", hint: "fact, kind, visibility, confidence" },
      { value: "forget", label: "Forget", hint: "delete this fact" },
      { value: "back", label: "Back" },
    ],
  });
  if (action === "edit") await editPersonFact(shell, client, selected);
  else if (action === "forget" && (await confirmForget(shell, "fact"))) {
    await client.deleteDiscordPersonMemoryFact(selected.subject, selected.fact.factId);
    shell.setupFlow.renderLine("Forgot person fact.", "success");
  }
}

async function editPersonFact(
  shell: ClankieFaceShell,
  client: MemoryCommandClient,
  selected: PersonFact,
): Promise<void> {
  const { fact, subject } = selected;
  const body = await shell.setupFlow.readText({
    message: "Fact",
    defaultValue: fact.body,
    validate: (value) =>
      value.trim().length === 0 || value.trim().length > 2_048 ? "Use 1–2048 characters." : undefined,
  });
  if (body === undefined) return;
  const kind = await shell.setupFlow.readSelect({
    message: "Kind",
    options: [
      { value: "person-fact", label: "Person fact" },
      { value: "preference", label: "Preference" },
      { value: "relationship-note", label: "Relationship note" },
    ],
    initialValue: fact.kind,
  });
  if (kind === undefined) return;
  const scope = await shell.setupFlow.readSelect({
    message: "Visibility",
    options: [
      { value: "guild", label: "Server", hint: "all admitted channels in this server" },
      { value: "channel", label: "One channel" },
      { value: "operator_private", label: "Operator only" },
    ],
    initialValue: fact.visibility.scope,
  });
  if (scope === undefined) return;
  let visibility: DiscordPersonMemoryVisibility;
  if (scope === "channel") {
    const channelId = await shell.setupFlow.readText({
      message: "Discord channel ID",
      ...(fact.visibility.scope === "channel" ? { defaultValue: fact.visibility.channelId } : {}),
      validate: (value) => (value.trim().length === 0 || value.trim().length > 64 ? "Required." : undefined),
    });
    if (channelId === undefined) return;
    visibility = { scope: "channel", channelId: channelId.trim() };
  } else {
    visibility = { scope: scope as "guild" | "operator_private" };
  }
  const confidence = await shell.setupFlow.readText({
    message: "Confidence (0–1)",
    defaultValue: String(fact.confidence),
    validate: (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? undefined : "Use a number from 0 to 1.";
    },
  });
  if (confidence === undefined) return;
  await client.updateDiscordPersonMemoryFact(subject, fact.factId, {
    body: body.trim(),
    kind: kind as DiscordPersonMemoryFact["kind"],
    visibility,
    confidence: Number(confidence),
  });
  shell.setupFlow.renderLine("Saved person fact.", "success");
}

async function confirmForget(shell: ClankieFaceShell, noun: string): Promise<boolean> {
  const confirmation = await shell.setupFlow.readSelect({
    message: `Forget this ${noun}?`,
    options: [
      { value: "cancel", label: "Keep it" },
      { value: "forget", label: "Forget", hint: "cannot be undone" },
    ],
    initialValue: "cancel",
  });
  return confirmation === "forget";
}

function newestEpisodes(episodes: readonly CaptainEpisode[]): CaptainEpisode[] {
  return [...episodes].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function visibilityLabel(visibility: DiscordPersonMemoryVisibility): string {
  return visibility.scope === "channel" ? `channel ${visibility.channelId}` : visibility.scope;
}

function truncate(value: string, max = 64): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
