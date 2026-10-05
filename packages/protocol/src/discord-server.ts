import { z } from "zod";

/** Native Discord REST within the connected server; authority stays in the body. */
export const DiscordServerActionSchema = z
  .object({
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    // No encoded, normalized, query-string, or bearer-token routes.
    path: z
      .string()
      .max(512)
      .regex(
        /^\/(?:guilds\/(?:@server|\d{5,32})|channels\/\d{5,32}|webhooks\/\d{5,32})(?:\/(?:[a-z][a-z_-]*|\d{5,32}|@me))*$/u,
      )
      .refine((path) => !path.startsWith("/webhooks/") || /^\/webhooks\/\d{5,32}$/u.test(path), {
        message: "Webhook bearer routes are never accepted.",
      }),
    body: z.union([z.record(z.string(), z.json()), z.array(z.json())]).optional(),
  })
  .strict();
export type DiscordServerAction = z.infer<typeof DiscordServerActionSchema>;

export const DiscordServerActionResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().min(1).max(1_000),
    resourceId: z
      .string()
      .regex(/^\d{5,32}$/u)
      .optional(),
    /** Credentials are redacted by the executor before reaching any caller. */
    data: z.json().optional(),
  })
  .strict();
export type DiscordServerActionResult = z.infer<typeof DiscordServerActionResultSchema>;
