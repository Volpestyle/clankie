import { minecraftTools } from "./tools.ts";
import { minecraftHostTools, type MinecraftHostToolPort } from "./host-tools.ts";
import { createMinecraftRoutes, type MinecraftRouteOptions } from "./routes.ts";
import type { MinecraftExtensionRuntime } from "./extension.ts";
import type { MinecraftIdentity } from "./authority.ts";

/** All game-specific tool/route registration lives with the installed extension. */
export function minecraftProjection(
  runtime: MinecraftExtensionRuntime,
  host: () => MinecraftHostToolPort | undefined,
) {
  return {
    paths: ["/v1/minecraft", "/v1/minecraft/host", "/v1/minecraft/configuration"],
    tools: (turn: { readonly bodyIdentity?: MinecraftIdentity | undefined }) => {
      const admin = host();
      return [
        ...minecraftTools(runtime.service, turn),
        ...(admin === undefined ? [] : minecraftHostTools(admin, turn)),
      ];
    },
    routes: (options: Omit<MinecraftRouteOptions, "service" | "host">) =>
      createMinecraftRoutes({
        ...options,
        service: runtime.service,
        ...(host() === undefined ? {} : { host: host()! }),
      }),
  };
}
