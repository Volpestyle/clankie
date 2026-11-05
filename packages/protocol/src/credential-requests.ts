import { z } from "zod";

/**
 * Sign-in requests (#245, ADR 0342). A hired worker names the site's origin and
 * the shape of its form; the owner types the values into a masked prompt, and
 * the credential broker fills them into Clankie's own private browser. A value
 * goes only from the owner's prompt to the broker: no request, list, result or
 * receipt here carries one.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** An exact `scheme://host[:port]`: https anywhere, http only on this machine. */
export const CredentialOriginSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.origin !== value) return false;
      return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
    } catch {
      return false;
    }
  }, "An exact origin, such as https://example.com (http only for this machine)");

export const CredentialFieldKindSchema = z.enum(["username", "password", "code"]);
export type CredentialFieldKind = z.infer<typeof CredentialFieldKindSchema>;

export const CredentialFieldSchema = z.strictObject({
  kind: CredentialFieldKindSchema,
  /** A CSS selector for the input in the page's top document. */
  selector: z.string().min(1).max(512),
});

/** What a worker sends: never a value. */
export const CredentialRequestInputSchema = z.strictObject({
  /** The browser conversation whose current tab shows the sign-in form (`clankie browser call --conversation`). */
  conversation: z.string().min(1).max(256),
  origin: CredentialOriginSchema,
  fields: z
    .array(CredentialFieldSchema)
    .min(1)
    .max(3)
    .refine(
      (fields) => new Set(fields.map((field) => field.kind)).size === fields.length,
      "One field per kind",
    )
    .refine((fields) => fields.some((field) => field.kind !== "username"), "Ask for a password or a code"),
});
export type CredentialRequestInput = z.infer<typeof CredentialRequestInputSchema>;

/** The only results a worker ever reads. */
export const CredentialOutcomeSchema = z.enum(["filled", "declined", "saved", "failed"]);
export type CredentialOutcome = z.infer<typeof CredentialOutcomeSchema>;

export const CredentialRequestIdSchema = z.string().regex(/^cr_[0-9a-f]{32}$/u);

/** A request as the owner's prompt shows it. */
export const CredentialRequestSchema = z.strictObject({
  requestId: CredentialRequestIdSchema,
  origin: z.string(),
  /** The worker that asked: its fleet pane. */
  requester: z.string(),
  fields: z.array(CredentialFieldKindSchema),
  state: z.enum(["open", "filling", "settled"]),
  outcome: CredentialOutcomeSchema.optional(),
  /** A short code for why it failed, never page or value text. */
  reason: z.string().max(64).optional(),
  createdAt: z.string(),
});
export type CredentialRequest = z.infer<typeof CredentialRequestSchema>;

export const CredentialRequestListSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requests: z.array(CredentialRequestSchema),
});
export type CredentialRequestList = z.infer<typeof CredentialRequestListSchema>;

/** The owner's answer: one value per requested kind. */
export const CredentialAnswerSchema = z.strictObject({
  values: z.partialRecord(CredentialFieldKindSchema, z.string().min(1).max(4096)),
});
export type CredentialAnswer = z.infer<typeof CredentialAnswerSchema>;

/** What the owner's answer or decline returns: the settled request, or why it was refused. */
export const CredentialAnswerResultSchema = z.union([
  z.strictObject({ outcome: z.literal("settled"), request: CredentialRequestSchema }),
  z.strictObject({
    outcome: z.literal("refused"),
    reason: z.enum(["not_found", "closed", "missing_value", "unexpected_value"]),
  }),
]);
export type CredentialAnswerResult = z.infer<typeof CredentialAnswerResultSchema>;

export const CREDENTIAL_REQUESTS_PATH = "/v1/credential-requests";
export const CREDENTIAL_ANSWER_PATH = "/v1/credential-requests/:requestId/answer";
export const CREDENTIAL_DECLINE_PATH = "/v1/credential-requests/:requestId/decline";
export const credentialAnswerPath = (requestId: string) =>
  `${CREDENTIAL_REQUESTS_PATH}/${encodeURIComponent(requestId)}/answer`;
export const credentialDeclinePath = (requestId: string) =>
  `${CREDENTIAL_REQUESTS_PATH}/${encodeURIComponent(requestId)}/decline`;
