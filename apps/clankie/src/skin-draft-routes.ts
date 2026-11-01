import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  SKIN_DRAFTS_PATH,
  SkinDraftCommandSchema,
  SkinKeyPoseSchema,
  isSkinDraftRoute,
} from "@clankie/protocol/skin-drafts";
import type { QuestionAuthority } from "./captain/conversation-questions.ts";
import type { SkinDraftPort } from "./ports/media.ts";
import { SkinDraftError } from "./skin-drafts.ts";

export function createSkinDraftRoutes(options: {
  service?: SkinDraftPort | undefined;
  authorize(request: Request): Promise<QuestionAuthority | undefined>;
}) {
  const app = new Hono<{ Variables: { owner: QuestionAuthority } }>();
  for (const path of [
    SKIN_DRAFTS_PATH,
    SKIN_DRAFTS_PATH + "/:id",
    SKIN_DRAFTS_PATH + "/:id/reference",
    SKIN_DRAFTS_PATH + "/:id/poses/:pose/:kind",
  ])
    app.use(path, async (context, next) => {
      context.header("cache-control", "private, no-store");
      const owner = await options.authorize(context.req.raw);
      if (!owner) return context.json({ error: "authentication_required" }, 401);
      if (!options.service) return context.json({ error: "skin_drafts_unavailable" }, 503);
      const url = new URL(context.req.raw.url);
      if (!isSkinDraftRoute(context.req.method, url.pathname + url.search))
        return context.json({ error: "skin_draft_malformed" }, 400);
      context.set("owner", owner);
      await next();
    });
  app.onError((error, context) => {
    if (error instanceof SkinDraftError) return context.json({ error: error.code }, error.status);
    return context.json({ error: "skin_drafts_unavailable" }, 503);
  });
  app.get(SKIN_DRAFTS_PATH, async (context) =>
    context.json(await options.service!.handle(context.get("owner"), { action: "list" })),
  );
  app.post(SKIN_DRAFTS_PATH, bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    const command = SkinDraftCommandSchema.safeParse(await context.req.json().catch(() => null));
    if (!command.success) return context.json({ error: "skin_draft_malformed" }, 400);
    return context.json(await options.service!.handle(context.get("owner"), command.data));
  });
  app.get(SKIN_DRAFTS_PATH + "/:id", async (context) => {
    const rawVersion = context.req.query("version");
    const command = SkinDraftCommandSchema.safeParse({
      action: "get",
      draftId: context.req.param("id"),
      ...(rawVersion === undefined ? {} : { version: Number(rawVersion) }),
    });
    if (!command.success) return context.json({ error: "skin_draft_malformed" }, 400);
    return context.json(await options.service!.handle(context.get("owner"), command.data));
  });
  const imageResponse = (image: { bytes: Buffer; sha256: string; mediaType: string }) =>
    new Response(new Uint8Array(image.bytes), {
      headers: {
        "content-type": image.mediaType,
        "content-length": String(image.bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-clankie-sha256": image.sha256,
      },
    });
  app.get(SKIN_DRAFTS_PATH + "/:id/reference", async (context) =>
    imageResponse(
      await options.service!.referencePreview(
        context.get("owner"),
        context.req.param("id") ?? "",
        context.req.query("revision") ?? "",
      ),
    ),
  );
  app.get(SKIN_DRAFTS_PATH + "/:id/poses/:pose/:kind", async (context) => {
    const pose = SkinKeyPoseSchema.safeParse(context.req.param("pose"));
    const kind = context.req.param("kind");
    if (!pose.success || (kind !== "source" && kind !== "native"))
      return context.json({ error: "skin_draft_malformed" }, 400);
    const image = await options.service!.preview(
      context.get("owner"),
      context.req.param("id") ?? "",
      pose.data,
      context.req.query("revision") ?? "",
      kind,
    );
    return imageResponse(image);
  });
  return app;
}
