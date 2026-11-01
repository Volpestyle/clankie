import type { Context, Hono } from "hono";
import {
  GenerateImageRequestSchema,
  GenerateVideoRequestSchema,
  MEDIA_IMAGE_GENERATION_PATH,
  MEDIA_VIDEO_GENERATION_PATH,
} from "@clankie/protocol";
import { readJson } from "./app/http-auth.ts";
import type { MediaProjection } from "./extension-host.ts";
import type { ExtensionRouteHost, ExtensionRoutes } from "./ports/routes.ts";
import { skinDraftRoutes } from "./skin-draft-routes.ts";

/**
 * The media extension's routes (ADR 0328): making a picture or a clip
 * (ADR 0085) and the owner's skin drafts. They mount only while media runs.
 */
export function mediaRoutes(media: MediaProjection): ExtensionRoutes {
  const skinDrafts = skinDraftRoutes(media.skinDrafts);
  return {
    place: "owner",
    register(app, host) {
      registerGenerationRoutes(app, host, media.generator);
      skinDrafts.register(app, host);
    },
  };
}

/** The Discord body, the console's captain or the operator; anyone else is refused. */
async function captainOrOperator(context: Context, host: ExtensionRouteHost): Promise<Response | undefined> {
  const captain = await host.captainCaller(context.req.raw);
  if (captain && captain !== "unavailable") return undefined;
  const operator = await host.operator(context.req.raw);
  if (operator === "unavailable")
    return captain === "unavailable"
      ? context.json({ error: "authentication_unavailable" }, 503)
      : context.json({ error: "authentication_required" }, 401);
  if (!operator) return context.json({ error: "authentication_required" }, 401);
  return undefined;
}

/**
 * A refusal comes back 200 with a reason he can say out loud; only a malformed
 * body or a failed upstream is an error status.
 */
function registerGenerationRoutes(
  app: Hono,
  host: ExtensionRouteHost,
  generator: MediaProjection["generator"],
): void {
  const route = <Request>(
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: Request } | { success: false } },
    run: (request: Request, signal: AbortSignal) => Promise<unknown>,
  ): void => {
    app.post(path, async (context) => {
      const denial = await captainOrOperator(context, host);
      if (denial) return denial;
      const parsed = schema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "invalid_media_request" }, 400);
      try {
        const result = await run(parsed.data, context.req.raw.signal);
        return context.json({ result }, 200, { "cache-control": "no-store" });
      } catch {
        return context.json({ error: "media_upstream_failure" }, 502);
      }
    });
  };
  route(MEDIA_IMAGE_GENERATION_PATH, GenerateImageRequestSchema, (request) =>
    generator.generateImage(request),
  );
  route(MEDIA_VIDEO_GENERATION_PATH, GenerateVideoRequestSchema, (request, signal) =>
    generator.generateVideo(request, { signal }),
  );
}
