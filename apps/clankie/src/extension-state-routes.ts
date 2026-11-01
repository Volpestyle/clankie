import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  EXTENSIONS_PATH,
  ExtensionStatesSchema,
  UpdateExtensionSchema,
  type ExtensionStateReport,
  type ExtensionStates,
} from "@clankie/protocol/extensions";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";

type Authorize = (request: Request) => Promise<true | "authentication_required" | "forbidden">;

export interface ExtensionStateSource {
  snapshot(): readonly ExtensionStateReport[];
  report(): Promise<readonly ExtensionStateReport[]>;
}

/**
 * Each extension's state and the owner's switch for it (ADR 0328). Reading
 * needs the owner or a paired device; switching needs the owner and takes
 * effect at the next service start.
 */
export function createExtensionStateRoutes(options: {
  readonly read: Authorize;
  readonly change: Authorize;
  readonly settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>;
  readonly extensions?: ExtensionStateSource;
}): Hono {
  const app = new Hono();
  const states = (
    extensions: readonly ExtensionStateReport[],
    current: ClankieSettings,
    restartRequired?: boolean,
  ): ExtensionStates =>
    ExtensionStatesSchema.parse({
      schemaVersion: 1,
      extensions,
      switches: current.extensions,
      ...(restartRequired === undefined ? {} : { restartRequired }),
    });
  const refuse = (authority: "authentication_required" | "forbidden") =>
    Response.json({ error: authority }, { status: authority === "forbidden" ? 403 : 401 });
  app.use(EXTENSIONS_PATH, async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.get(EXTENSIONS_PATH, async (context) => {
    const authority = await options.read(context.req.raw);
    if (authority !== true) return refuse(authority);
    try {
      return context.json(states((await options.extensions?.report()) ?? [], await options.settings.load()));
    } catch {
      return context.json({ error: "unavailable" }, 503);
    }
  });
  app.post(EXTENSIONS_PATH, bodyLimit({ maxSize: 1024 }), async (context) => {
    const authority = await options.change(context.req.raw);
    if (authority !== true) return refuse(authority);
    if (!options.settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateExtensionSchema.safeParse(
      // allow-swallowed-rejection -- Invalid JSON follows the explicit malformed-request refusal below.
      await context.req.json().catch(() => null),
    );
    if (!input.success) return context.json({ error: "malformed" }, 400);
    const running = options.extensions?.snapshot() ?? [];
    const current = running.find((extension) => extension.id === input.data.id);
    if (current === undefined) return context.json({ error: "unknown_extension" }, 404);
    let updated: ClankieSettings;
    try {
      updated = await options.settings.update(
        (settings) => ({
          ...settings,
          extensions: { ...settings.extensions, [input.data.id]: input.data.switch },
        }),
        async () => {
          if ((await options.change(context.req.raw)) !== true) throw new Error("Owner authority changed");
        },
      );
    } catch {
      return context.json({ error: "extension_switch_conflict" }, 409);
    }
    const off = current.state === "off";
    return context.json(states(running, updated, input.data.switch === "off" ? !off : off));
  });
  return app;
}
