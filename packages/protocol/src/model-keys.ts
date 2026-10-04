import { z } from "zod";

/** Promotion order shared by /auth and account setup; actual support comes from the body catalog. */
export const FEATURED_MODEL_PROVIDERS = [
  "anthropic",
  "openai",
  "xai",
  "google",
  "openrouter",
  "groq",
  "mistral",
] as const;

/** Owner/operator or active Take Control device only; remote calls use the encrypted envelope. */
export const MODEL_KEYS_PATH = "/v1/model-keys";
export const MODEL_KEY_SET_PATH = "/v1/model-keys/set";
export const MODEL_KEY_VALIDATE_PATH = "/v1/model-keys/validate";
export const MODEL_SELECT_PATH = "/v1/model-keys/select";
export const MODEL_KEY_REMOVE_PATH = "/v1/model-keys/remove";
/** A separate read so clients built against the strict catalog never see a new field. */
export const MODEL_SUBSCRIPTIONS_PATH = "/v1/model-keys/subscriptions";
/** What the owner can switch to now: usable providers and the running model's reasoning effort. */
export const MODEL_OPTIONS_PATH = "/v1/model-keys/options";
export const MODEL_EFFORT_SET_PATH = "/v1/model-keys/effort";

const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const ModelIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\P{Cc}+$/u);
const ModelRefSchema = ModelIdSchema.refine((value) => {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
});

export const ModelKeySetRequestSchema = z
  .object({
    providerId: ProviderIdSchema,
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .regex(/^\P{Cc}+$/u),
  })
  .strict();
export const ModelKeyValidateRequestSchema = z
  .object({
    providerId: ProviderIdSchema,
    modelId: ModelIdSchema,
  })
  .strict();
export const ModelSelectRequestSchema = z.object({ model: ModelRefSchema }).strict();
export const ModelKeyRemoveRequestSchema = z.object({ providerId: ProviderIdSchema }).strict();

/** No keys, prefixes, suffixes, endpoint headers, or credential metadata are returned. */
export const ModelKeysResponseSchema = z
  .object({
    model: ModelRefSchema.nullable(),
    effectiveModel: ModelRefSchema.nullable(),
    providers: z.array(
      z
        .object({
          id: ProviderIdSchema,
          name: z.string(),
          acceptsApiKey: z.boolean(),
          keyConfigured: z.boolean(),
          models: z.array(z.object({ id: ModelIdSchema, name: z.string() }).strict()),
        })
        .strict(),
    ),
  })
  .strict();
export type ModelKeysResponse = z.infer<typeof ModelKeysResponseSchema>;

/**
 * Providers the body is signed in to through their own account (OAuth or a
 * subscription) rather than a stored API key. Names only; no token metadata.
 */
export const ModelSubscriptionsResponseSchema = z
  .object({
    subscriptions: z.array(z.object({ providerId: ProviderIdSchema, name: z.string() }).strict()).max(64),
  })
  .strict();
export type ModelSubscriptionsResponse = z.infer<typeof ModelSubscriptionsResponseSchema>;

/** Pi's reasoning ladder; a model accepts the subset its options list. */
export const ModelEffortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ModelEffort = z.infer<typeof ModelEffortSchema>;

/**
 * `usableProviders` can serve a turn now (a stored key, an account sign-in, an
 * environment key or a local endpoint), so switching to one needs no key entry.
 * `effort` describes the model that runs, or is null when none resolves;
 * `current` null means the model's own `default`, and fewer than two `levels`
 * means the model has no adjustable reasoning.
 */
export const ModelOptionsResponseSchema = z
  .object({
    usableProviders: z.array(ProviderIdSchema).max(256),
    effort: z
      .object({
        model: ModelRefSchema,
        current: ModelEffortSchema.nullable(),
        default: ModelEffortSchema,
        levels: z.array(ModelEffortSchema).max(7),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ModelOptionsResponse = z.infer<typeof ModelOptionsResponseSchema>;

/** Sets (or, with null, clears) the effort of the model that runs, as `clankie effort set`. */
export const ModelEffortSetRequestSchema = z.object({ effort: ModelEffortSchema.nullable() }).strict();

/** Validation deliberately collapses upstream messages (which can echo credentials). */
export const ModelKeyResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum([
        "authentication_required",
        "forbidden",
        "malformed",
        "unsupported_provider",
        "unsupported_model",
        "key_missing",
        "validation_failed",
        "validation_timeout",
        "unavailable",
      ]),
    })
    .strict(),
]);
export type ModelKeyResult = z.infer<typeof ModelKeyResultSchema>;
