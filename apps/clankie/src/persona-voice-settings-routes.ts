import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { loadPersonaImages, personaImageStatus } from "@clankie/persona-images";
import { PersonaAttentionUpdateSchema } from "@clankie/protocol/discord-attention";
import {
  OwnerPersonaUpdateSchema,
  OwnerVoiceUpdateSchema,
  PersonaSettingsSchema,
  VoiceSettingsSchema,
} from "@clankie/protocol/owner-settings";
import {
  assertNoSecretShapedValue,
  resolveVoiceSettings,
  type ClankieSettings,
  type SettingsStore,
} from "@clankie/settings";

const PERSONA = "/v1/operator/persona";
const VOICE = "/v1/operator/voice";
const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const attention = (value: ClankieSettings["persona"]) => ({
  chattiness: value.chattiness,
  replyPolicy: value.replyPolicy,
});
class SettingsConflict extends Error {}
class AuthorityChanged extends Error {}
class InvalidVoice extends Error {}

type SettingsSource = Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>;
export function createPersonaVoiceSettingsRoutes(options: {
  settings: SettingsSource;
  authorizePersona(request: Request): Promise<true | "authentication_required" | "forbidden">;
  operator(request: Request): Promise<string | undefined | "unavailable">;
  voiceSettingsEnv?: NodeJS.ProcessEnv;
}): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  const snapshotPersona = async (current: ClankieSettings, owner: boolean) => {
    const persona = owner ? current.persona : attention(current.persona);
    return {
      revision: revision(persona),
      persona,
      ...(owner ? { images: personaImageStatus(await loadPersonaImages(current.persona.imagesDir)) } : {}),
    };
  };
  app.on(["GET", "POST"], PERSONA, bodyLimit({ maxSize: 24 * 1024 }), async (context) => {
    const request = context.req.raw;
    if ((await options.authorizePersona(request)) !== true)
      return context.json({ error: "operator_authentication_required" }, 401);
    const initialOperator = await options.operator(request);
    const owner = initialOperator !== undefined && initialOperator !== "unavailable";
    const guard = async () => {
      if (
        request.signal.aborted ||
        (await options.authorizePersona(request)) !== true ||
        (await options.operator(request)) !== initialOperator
      )
        throw new AuthorityChanged();
    };
    try {
      let current;
      if (request.method === "POST") {
        if (!options.settings.update) return context.json({ error: "settings_unavailable" }, 503);
        const schema = owner ? OwnerPersonaUpdateSchema : PersonaAttentionUpdateSchema;
        const input = schema.safeParse(await context.req.json().catch(() => null));
        if (!input.success) return context.json({ error: "malformed" }, 400);
        let before: string | undefined;
        current = await options.settings.update(
          (value) => {
            if (revision(owner ? value.persona : attention(value.persona)) !== input.data.expectedRevision)
              throw new SettingsConflict();
            before = JSON.stringify(value);
            return {
              ...value,
              persona: PersonaSettingsSchema.parse({ ...value.persona, ...input.data.persona }),
            };
          },
          async () => {
            await guard();
            if (JSON.stringify(await options.settings.load()) !== before) throw new SettingsConflict();
          },
        );
      } else current = await options.settings.load();
      const result = await snapshotPersona(current, owner);
      await guard();
      return context.json({
        ...result,
        ...(request.method === "POST" ? { restart: "Restart Clankie to apply persona images." } : {}),
      });
    } catch (error) {
      if (error instanceof AuthorityChanged)
        return context.json({ error: "operator_authentication_required" }, 401);
      if (error instanceof SettingsConflict) return context.json({ error: "persona_settings_conflict" }, 409);
      if (error instanceof z.ZodError) return context.json({ error: "malformed" }, 400);
      return context.json({ error: "settings_unavailable" }, 503);
    }
  });
  app.on(["GET", "POST"], VOICE, bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    const request = context.req.raw;
    const identity = await options.operator(request);
    if ((await options.authorizePersona(request)) !== true) {
      if (identity === "unavailable")
        return context.json({ error: "operator_authentication_unavailable" }, 503);
      return context.json({ error: "operator_authentication_required" }, 401);
    }
    const guard = async () => {
      if (
        request.signal.aborted ||
        (await options.authorizePersona(request)) !== true ||
        (await options.operator(request)) !== identity
      )
        throw new AuthorityChanged();
    };
    try {
      let current;
      if (request.method === "POST") {
        if (!options.settings.update) return context.json({ error: "settings_unavailable" }, 503);
        const input = OwnerVoiceUpdateSchema.safeParse(await context.req.json().catch(() => null));
        if (!input.success) return context.json({ error: "malformed" }, 400);
        try {
          assertNoSecretShapedValue(input.data.voice);
        } catch {
          return context.json({ error: "malformed" }, 400);
        }
        // The host's actual environment participates in validation before any persistence.
        try {
          resolveVoiceSettings(input.data.voice, options.voiceSettingsEnv ?? process.env);
        } catch (error) {
          throw new InvalidVoice(error instanceof Error ? error.message : "malformed");
        }
        let before: string | undefined;
        current = await options.settings.update(
          (value) => {
            if (revision(value.voice) !== input.data.expectedRevision) throw new SettingsConflict();
            before = JSON.stringify(value);
            return { ...value, voice: input.data.voice };
          },
          async () => {
            await guard();
            if (JSON.stringify(await options.settings.load()) !== before) throw new SettingsConflict();
          },
        );
      } else current = await options.settings.load();
      const voice = VoiceSettingsSchema.parse(current.voice);
      assertNoSecretShapedValue(voice);
      let resolved;
      try {
        resolved = resolveVoiceSettings(voice, options.voiceSettingsEnv ?? process.env);
      } catch (error) {
        throw new InvalidVoice(error instanceof Error ? error.message : "malformed");
      }
      await guard();
      return context.json({
        revision: revision(voice),
        voice,
        effectiveVoice: resolved.settings,
        overriddenByEnvironment: resolved.overriddenByEnvironment,
        ...(request.method === "POST"
          ? { restart: "Restart the active Discord body to apply voice settings." }
          : {}),
      });
    } catch (error) {
      if (error instanceof AuthorityChanged)
        return context.json({ error: "operator_authentication_required" }, 401);
      if (error instanceof SettingsConflict) return context.json({ error: "voice_settings_conflict" }, 409);
      if (error instanceof InvalidVoice) return context.json({ error: error.message }, 400);
      return context.json({ error: "settings_unavailable" }, 503);
    }
  });
  return app;
}
