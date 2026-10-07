import { z } from "zod";

/**
 * Clankie's own mailbox service (ADR 0242). A managed body calls
 * `HOSTED_MAIL_BODY_PATH` with its signed host credential; a self-hosted
 * install signed in to a Clankie account calls `HOSTED_MAIL_ACCOUNT_PATH` with
 * that account's bearer. Both carry the same request and answer the same way.
 */
export const HOSTED_MAIL_BODY_PATH = "/fleet/v1/body/mail";
export const HOSTED_MAIL_ACCOUNT_PATH = "/fleet/v1/account/mail";

export const HOSTED_MAIL_MAX_LIST = 25;

/** The folders the service keeps: what arrived and what he sent. */
export const HostedMailFolderSchema = z.enum(["INBOX", "Sent"]);
export type HostedMailFolder = z.infer<typeof HostedMailFolderSchema>;

const Address = z.email().max(320);
const Limit = z.number().int().min(1).max(HOSTED_MAIL_MAX_LIST);

export const HostedMailRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }).strict(),
  z
    .object({ op: z.literal("list"), folder: HostedMailFolderSchema.optional(), limit: Limit.optional() })
    .strict(),
  z
    .object({
      op: z.literal("read"),
      uid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      folder: HostedMailFolderSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("search"),
      query: z.string().trim().min(1).max(400),
      folder: HostedMailFolderSchema.optional(),
      limit: Limit.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("send"),
      to: Address,
      subject: z.string().min(1).max(500),
      text: z.string().min(1).max(20_000),
    })
    .strict(),
]);
export type HostedMailRequest = z.infer<typeof HostedMailRequestSchema>;

export const HostedMailHeaderSchema = z
  .object({
    uid: z.number().int().positive(),
    folder: HostedMailFolderSchema,
    from: z.string().max(1024),
    to: z.string().max(4096),
    subject: z.string().max(1024),
    date: z.string().datetime().optional(),
  })
  .strict();
export type HostedMailHeader = z.infer<typeof HostedMailHeaderSchema>;

/**
 * Outbound limits are per mailbox. A refusal names the one that was hit, its
 * ceiling, and when the next send can go.
 */
export const HostedMailLimitSchema = z.enum(["sends_per_hour", "sends_per_day", "recipients_per_day"]);
export type HostedMailLimit = z.infer<typeof HostedMailLimitSchema>;

export const HostedMailRefusalSchema = z
  .object({
    ok: z.literal(false),
    refusal: z.enum([
      /** The account's plan or this installation has no mailbox. */
      "not_provisioned",
      /** The caller is not signed in, or its credential lapsed. */
      "sign_in_required",
      "limit_reached",
      /** The recipient bounced or complained before; the service will not send there. */
      "recipient_suppressed",
      "not_found",
      "malformed",
      "unavailable",
    ]),
    limit: z
      .object({
        name: HostedMailLimitSchema,
        max: z.number().int().positive(),
        retryAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HostedMailRefusal = z.infer<typeof HostedMailRefusalSchema>;

export const HostedMailLimitsSchema = z
  .object({
    sendsPerHour: z.number().int().positive(),
    sendsPerDay: z.number().int().positive(),
    recipientsPerDay: z.number().int().positive(),
  })
  .strict();
export type HostedMailLimits = z.infer<typeof HostedMailLimitsSchema>;

const Ok = { ok: z.literal(true), address: Address } as const;

export const HostedMailStatusResultSchema = z.union([
  z.object({ ...Ok, limits: HostedMailLimitsSchema }).strict(),
  HostedMailRefusalSchema,
]);
export const HostedMailListResultSchema = z.union([
  z.object({ ...Ok, messages: z.array(HostedMailHeaderSchema).max(HOSTED_MAIL_MAX_LIST) }).strict(),
  HostedMailRefusalSchema,
]);
export const HostedMailReadResultSchema = z.union([
  z
    .object({
      ...Ok,
      message: HostedMailHeaderSchema.extend({ text: z.string().max(64_000) }).strict(),
    })
    .strict(),
  HostedMailRefusalSchema,
]);
export const HostedMailSendResultSchema = z.union([
  z.object({ ...Ok, messageId: z.string().min(1).max(512) }).strict(),
  HostedMailRefusalSchema,
]);
export type HostedMailStatusResult = z.infer<typeof HostedMailStatusResultSchema>;
export type HostedMailListResult = z.infer<typeof HostedMailListResultSchema>;
export type HostedMailReadResult = z.infer<typeof HostedMailReadResultSchema>;
export type HostedMailSendResult = z.infer<typeof HostedMailSendResultSchema>;
