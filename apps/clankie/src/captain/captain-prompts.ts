import { formatFleetAutonomyGuidance } from "@clankie/protocol";
import { effectiveFleetAutonomy } from "@clankie/settings";
import { type CaptainSessionLaneV2 } from "@clankie/protocol";
import {
  FLEET_MODEL_GUIDANCE,
  FLEET_SIZE_GUIDANCE,
  personaInstructions,
  safetyInstructions,
  type ClankieSettings,
  type PersonaRegister,
} from "@clankie/settings";
import { type InlineExtension } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { renderComputerUseReach, type ComputerUseHarness } from "../computer-use-harnesses.ts";
import type { CaptainDeps } from "./deps.ts";
import type { CaptainPromptSection, PromptHarness } from "./port.ts";

const REGISTER_FOR_LANE: Readonly<Record<CaptainSessionLaneV2, PersonaRegister>> = {
  operator: "operator",
  discord_voice: "social",
  discord_presence: "social",
  gameplay: "gameplay",
};

const DISCORD_LANES: ReadonlySet<CaptainSessionLaneV2> = new Set(["discord_voice", "discord_presence"]);

const DISCORD_ROOM = [
  "# In Discord",
  "A picture, video, diagram or screenshot you make or take attaches itself to the reply you are writing; only the last one of a turn rides. Take it, then talk about what is on it. Never write a markdown image, a `sandbox:` URI or a file path as though it were the attachment. In a room that cannot show pictures, describe it or quote what you read.",
].join("\n");

/**
 * An empty memory still says so. A missing card reads as "you have no memory",
 * and nothing else in the prompt would ever prompt the first write — so the
 * store's existence is on every turn and the floor retires itself once he
 * writes one. A recall *failure* stays silent: a broken store degrades the
 * prompt, it does not lie about what he remembers.
 */
const EMPTY_MEMORY_CARD = [
  "## Your memory",
  "Nothing yet — you have not written a memory. `memory` with action `write` is how one gets here.",
].join("\n");

/** The card as it reaches the prompt: an empty store says so rather than vanishing. */
export function renderMemoryCard(card: string): string {
  return card.length === 0 ? EMPTY_MEMORY_CARD : card;
}

/** Refresh bounded episodic recall as trusted context for every Pi run. */
export function captainMemoryExtension(memory: CaptainDeps["memory"], lane: CaptainSessionLaneV2) {
  return {
    name: "captain-memory",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", async (event) => {
        const card = await memory.recallMemoryCard(lane, event.prompt).catch(() => undefined);
        if (card === undefined) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${renderMemoryCard(card)}` };
      });
    },
  } satisfies InlineExtension;
}

/**
 * The project instruction files a seat still needs from the service. Claude
 * Code reads every CLAUDE.md on its own path but never AGENTS.md, so a Claude
 * seat drops the CLAUDE.md files and any AGENTS.md beside one, and keeps an
 * AGENTS.md that stands alone. Without a harness, every file passes.
 */
export function instructionsForHarness<T extends { readonly path: string }>(
  files: readonly T[],
  harness: PromptHarness | undefined,
  exists: (path: string) => boolean = existsSync,
): readonly T[] {
  if (harness === undefined) return files;
  return files.filter(
    (file) => basename(file.path) !== "CLAUDE.md" && !exists(join(dirname(file.path), "CLAUDE.md")),
  );
}

/** The captain's instructions.md: identity, trust and where things live, re-read per call. */
export function captainInstructions(): string {
  return readFileSync(join(import.meta.dirname, "instructions.md"), "utf8");
}

/** The sections a pi session is built with; the model card is refreshed per run instead. */
export const SESSION_PROMPT_SECTIONS: readonly CaptainPromptSection[] = [
  "identity",
  "persona",
  "reach",
  "fleet",
  "address",
];

/**
 * The prompt a lane starts from, one section per concern. The pi session and a
 * seat outside pi (`lanePrompt`) both call this, so the two can never drift:
 * there is one assembly, and each caller names the sections it wants. Selected
 * sections are trimmed and separated by one blank line; absent ones leave no
 * gap.
 */
export function fleetInstructions(systemTools: boolean, currentSettings: ClankieSettings): string {
  if (!systemTools) return "";
  const { notes, size, models } = currentSettings.fleet;
  const policy = effectiveFleetAutonomy(currentSettings.autonomy);
  return [
    "# Your fleet",
    "",
    `Fleet size: ${size}. ${FLEET_SIZE_GUIDANCE[size]}`,
    `Models: ${models}. ${FLEET_MODEL_GUIDANCE[models]}`,
    "Size and models are budget targets, not caps: go past them when the work warrants and say so.",
    ...formatFleetAutonomyGuidance(policy),
    "Under lead closure, workers report to the lead without parking for owner acceptance. Release publication, including App Store or TestFlight, follows the resolved release preference. Owner-only payments, evals and account sign-ups become linked follow-ups without holding delivered work open; missing implementation or verification is never a pass.",
    "These preferences are standing work guidance within existing authority. They grant no tools, accounts, credentials or machine authority. Sign-ins, codes, CAPTCHAs, payments, account changes, credentials and destructive actions outside fleet workspaces remain owner-only. Evals require explicit owner authorization; a release preference never authorizes them.",
    ...(notes.trim()
      ? ["", "Routing notes are preferences; you still choose a harness for each job.", notes.trim()]
      : []),
  ].join("\n");
}

export function assembleLanePrompt(
  lane: CaptainSessionLaneV2,
  systemTools: boolean,
  currentSettings: ClankieSettings,
  selected: readonly CaptainPromptSection[] = SESSION_PROMPT_SECTIONS,
  extra: Readonly<Partial<Record<CaptainPromptSection, string>>> = {},
  computerUse: readonly ComputerUseHarness[] = [],
): string {
  const identity = captainInstructions();
  const persona = personaInstructions(currentSettings.persona, REGISTER_FOR_LANE[lane]);
  // Machine access says only whether this room has a shell. The herdr contract —
  // joining, the census, the bare-`herdr-lead` hang — is identity, stated once in
  // instructions.md, and every lane that gets this section gets that one too.
  // Computer-use harnesses drive the owner's own apps and sessions, so they are
  // named only where a hire could happen at all: a room with the machine grant
  // (ADR 0199). The owner can take them off the card to save those plans.
  const harnessReach =
    systemTools && currentSettings.browser.harnessDelegation ? renderComputerUseReach(computerUse) : "";
  const machine = systemTools
    ? [
        "# Machine access",
        currentSettings.safety.codeExecution === "delegate"
          ? "You can read files and coordinate native harness workers in this authorized context. Your direct shell and file edits are blocked."
          : "You have shell and filesystem tools in this authorized context.",
        // VUH-1391: a reply has an output limit and a long one is cut off mid-file.
        "Long code and long documents go in files: put a whole script, module or write-up in one and say where it is rather than pasting it into a reply that can be cut off.",
        ...(harnessReach.length > 0 ? ["", harnessReach] : []),
      ].join("\n")
    : [
        "# This room",
        "You do not have a shell or filesystem tools in this room. If someone asks you to inspect herdr, run a command, or read a file, say you cannot from here. Do not imply you chose not to look.",
      ].join("\n");
  // How a Discord reply carries media is true only in a Discord room, so the
  // console and the seats never pay for it (VUH-1456).
  const reach = DISCORD_LANES.has(lane) ? `${machine}\n\n${DISCORD_ROOM}` : machine;
  const fleet = fleetInstructions(systemTools, currentSettings);
  // His own address is a fact he should be able to say without calling a tool
  // for it, and it belongs to whichever mailbox is actually connected — so it
  // is derived from settings rather than written into the persona a second
  // time, where it would drift the day the mailbox changes.
  const mailbox = currentSettings.email.fromAddress ?? currentSettings.email.username;
  const address =
    mailbox === undefined
      ? ""
      : [
          "# Your address",
          "",
          `Your own mailbox is ${mailbox}. That is how someone reaches you directly, and you can give it out. Reading it stays at the console.`,
        ].join("\n");
  const sections: Partial<Record<CaptainPromptSection, string>> = {
    identity,
    persona,
    reach,
    fleet,
    address,
    ...extra,
  };
  const prompt = selected
    .map((name) => sections[name]?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n\n");
  return [prompt, safetyInstructions(currentSettings.safety)].filter(Boolean).join("\n\n");
}

/**
 * What a lane holds by default, outside any turn: the operator console always
 * has the shell; a social lane never does on its own. A Discord machine grant
 * is decided per actor and per delivery by `planDiscordTurnSession`, which a
 * bare lane bearer cannot present, so a lane read from outside a turn is the
 * social default. `buildSession` takes the per-turn answer; this is the one for
 * everything that asks about a lane rather than a turn.
 */
export function laneHoldsSystemTools(lane: CaptainSessionLaneV2): boolean {
  return lane === "operator";
}
