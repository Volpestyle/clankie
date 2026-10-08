/** Service-owned provider/persona resolution; the mind lives in the extension. */
import { createModelMinecraftPlayMind, type MinecraftPlayMind } from "@clankie/minecraft";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { personaInstructions, SettingsStore } from "@clankie/settings";
import { personaImageBriefing } from "@clankie/persona-images";
import { createPersonaImageSource } from "./persona-images.ts";
export { createModelMinecraftPlayMind } from "@clankie/minecraft";
export async function resolveMinecraftPlayMind(options: {
  model: string;
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
}): Promise<MinecraftPlayMind> {
  const env = options.env ?? process.env;
  const configured = await resolveConfiguredLanguageModel({
    cwd: options.repoRoot,
    env,
    purpose: "gameplay",
    ref: options.model,
  });
  if (!configured.cost) throw new Error("Minecraft play model pricing unavailable");
  const settings = new SettingsStore();
  const character = [
    personaInstructions((await settings.load()).persona, "gameplay"),
    personaImageBriefing(await createPersonaImageSource(settings, options.repoRoot)()),
  ]
    .filter(Boolean)
    .join("\n\n");
  const requested = Number(env["CLANKIE_PLAY_MODEL_REQUEST_TIMEOUT_MS"]);
  return createModelMinecraftPlayMind({
    model: configured.model,
    pricing: configured.cost,
    character,
    providerOptions: configured.modelOptions?.providerOptions ?? {},
    requestTimeoutMs: Number.isSafeInteger(requested) && requested > 0 ? requested : 180000,
  });
}
