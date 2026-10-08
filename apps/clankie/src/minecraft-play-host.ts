import { MinecraftPlayHost as ExtensionPlayHost } from "@clankie/minecraft/play-host";
import { resolveMinecraftPlayMind } from "./minecraft-play-mind.ts";

/** Compatibility composition: persona and credentialed model resolution stay in core. */
export class MinecraftPlayHost extends ExtensionPlayHost {
  public constructor(
    options: Omit<ConstructorParameters<typeof ExtensionPlayHost>[0], "resolveMind"> & { repoRoot: string },
  ) {
    super({
      ...options,
      resolveMind: (model) => resolveMinecraftPlayMind({ model, repoRoot: options.repoRoot }),
    });
  }
}
