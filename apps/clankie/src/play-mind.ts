/** Core supplies Clankie's persona and configured model to game extensions. */
import { createRequire } from "node:module";
import path from "node:path";
import {
  createModelFreePlayMind,
  createModelVoice,
  type ClankieVoice,
  type FreePlayMind,
} from "@clankie/play";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { personaImageBriefing } from "@clankie/persona-images";
import { personaInstructions, SettingsStore } from "@clankie/settings";
import { createPersonaImageSource } from "./persona-images.ts";

/**
 * How long one decision may take before the turn is abandoned.
 *
 * The deadline exists to stop a wedged request hanging the playthrough, not to
 * keep turns snappy. Too tight a bound converts a late answer into no answer,
 * and the journal records `mind_failed` instead of a move. 60s was that, once
 * his vision model slowed down: measured 2026-08-15, a trivial "describe this
 * screen in ten words" call to grok-4.6 took 20-25s, and a full decision ran
 * past the minute and lost three turns in a row.
 */
const PLAY_MODEL_REQUEST_TIMEOUT_MS = 180_000;

export function resolvePlayRuntimeRoots(repoRoot: string | undefined): {
  emulatorPackage: string;
  repoRoot: string;
} {
  const require = createRequire(import.meta.url);
  const emulatorPackage =
    repoRoot === undefined
      ? path.dirname(require.resolve("@clankie/play/package.json"))
      : path.join(repoRoot, "integrations", "gba-emulator");
  return { emulatorPackage, repoRoot: repoRoot ?? path.resolve(emulatorPackage, "../..") };
}

export async function resolvePlayMind(options: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  createMind?: () => Promise<FreePlayMind>;
  createVoiceAgent?: () => Promise<ClankieVoice | undefined>;
}): Promise<{ mind: FreePlayMind; voiceAgent: ClankieVoice | undefined }> {
  let voiceAgent: ClankieVoice | undefined;
  if (options.createVoiceAgent !== undefined) voiceAgent = await options.createVoiceAgent();
  if (options.createMind !== undefined) {
    return { mind: await options.createMind(), voiceAgent };
  }
  const configured = await resolveConfiguredLanguageModel({
    cwd: options.repoRoot,
    env: options.env,
    purpose: "gameplay",
  });
  // One character across every surface (ADR 0051): the Clankie an audience
  // watches play is the one they talk to, in his `gameplay` register — not a
  // second character defined by this file's prompt.
  const settings = new SettingsStore();
  const character = [
    personaInstructions((await settings.load()).persona, "gameplay"),
    personaImageBriefing(await createPersonaImageSource(settings, options.repoRoot)()),
  ]
    .filter(Boolean)
    .join("\n\n");
  const providerOptions = configured.modelOptions?.providerOptions ?? {};
  const requestTimeoutMs = positiveIntegerOr(
    options.env["CLANKIE_PLAY_MODEL_REQUEST_TIMEOUT_MS"],
    PLAY_MODEL_REQUEST_TIMEOUT_MS,
  );
  return {
    mind: createModelFreePlayMind({
      model: configured.model,
      character,
      providerOptions,
      requestTimeoutMs,
      ...(configured.cost === undefined ? {} : { pricing: configured.cost }),
    }),
    voiceAgent: createModelVoice({
      model: configured.model,
      character,
      providerOptions,
      requestTimeoutMs,
      ...(configured.cost === undefined ? {} : { pricing: configured.cost }),
    }),
  };
}

function positiveIntegerOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
