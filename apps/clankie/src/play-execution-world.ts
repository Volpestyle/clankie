import { pokemonExtension, type PokemonExtensionHost } from "@clankie/pokemon";
import type { InstalledGameExtensions } from "./game-extension-projection.ts";
import type { FreePlayMind, ClankieVoice } from "@clankie/play";
import { createBrokeredPlayVoiceClient } from "@clankie/play-voice";
import { createBrokeredActivityFrameSink } from "@clankie/rendered-surface-client";
import type { PlayExecution } from "./play-host.ts";
import { resolvePlayMind, resolvePlayRuntimeRoots } from "./play-mind.ts";

export interface WorldPlayExecutionOptions extends Omit<PokemonExtensionHost, "resolveMind"> {
  repoRoot?: string;
  createMind?: () => Promise<FreePlayMind>;
  createVoiceAgent?: () => Promise<ClankieVoice | undefined>;
}

/** Existing callers enter the same game-extension lifecycle as the service. */
export function createWorldPlayExecution(
  options: WorldPlayExecutionOptions,
  registry?: InstalledGameExtensions,
): PlayExecution {
  const env = options.env ?? process.env;
  const { repoRoot } = resolvePlayRuntimeRoots(options.repoRoot);
  const host: PokemonExtensionHost = {
    ...options,
    env,
    resolveMind: () =>
      resolvePlayMind({
        env,
        repoRoot,
        ...(options.createMind === undefined ? {} : { createMind: options.createMind }),
        ...(options.createVoiceAgent === undefined ? {} : { createVoiceAgent: options.createVoiceAgent }),
      }),
    createVoice: options.createVoice ?? (() => createBrokeredPlayVoiceClient()),
    createActivitySink:
      options.createActivitySink ??
      (() =>
        createBrokeredActivityFrameSink({
          url: env["CLANKIE_ACTIVITY_PRODUCER_URL"] ?? "ws://127.0.0.1:4322/producer",
        })),
  };
  const runtime =
    registry === undefined ? pokemonExtension.create(host) : registry.register(pokemonExtension, host);
  return (session, control, onRunning) =>
    runtime.start(
      session,
      {
        stopRequested: control.stopRequested,
        guard: async () => {
          await control.guard?.();
        },
        confirmStopped: () => control.confirmStopped?.(),
      },
      onRunning,
    );
}
