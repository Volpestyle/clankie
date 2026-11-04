import { z } from "zod";
import { PublicGatewayDoorwayStateSchema } from "./public-gateway.ts";

/** The owner's app signs this Mac in to clankie.bot (ADR 0153, #722). Same-Mac only. */
export const MAC_ACCOUNT_PATH = "/v1/mac-account";
export const MAC_ACCOUNT_START_PATH = "/v1/mac-account/start";
export const MAC_ACCOUNT_COMPLETE_PATH = "/v1/mac-account/complete";

/** The public gateway Clankie's accounts live behind, unless settings name another. */
export const DEFAULT_PUBLIC_GATEWAY_URL = "https://api.clankie.bot";

export const MacAccountStartRequestSchema = z.object({ email: z.string().min(1).max(320) }).strict();
export const MacAccountCompleteRequestSchema = z
  .object({ code: z.string().regex(/^\s*\d{4,12}\s*$/u) })
  .strict();

/** `never_set_up`: this Mac never held an account. `signed_out`: it did, and must sign in again. */
export const MacAccountStateSchema = z.enum(["signed_in", "signed_out", "never_set_up"]);
export type MacAccountState = z.infer<typeof MacAccountStateSchema>;

export const MacAccountStatusSchema = z
  .object({
    state: MacAccountStateSchema,
    /** Absent when signed out, and for a Mac signed in before the email was kept. */
    email: z.string().optional(),
    /** A sign-in waiting for its emailed code. */
    pending: z.boolean(),
    doorway: PublicGatewayDoorwayStateSchema,
  })
  .strict();
export type MacAccountStatus = z.infer<typeof MacAccountStatusSchema>;

export const MacAccountStartResponseSchema = z
  .object({ email: z.string(), expiresAt: z.string().datetime() })
  .strict();

/** The tokens are stored. `restarting` means the exit began, not that the replacement is healthy. */
export const MacAccountCompleteResponseSchema = z
  .object({
    state: z.literal("signed_in"),
    email: z.string(),
    restart: z.enum(["restarting", "waiting"]),
  })
  .strict();
export type MacAccountCompleteResponse = z.infer<typeof MacAccountCompleteResponseSchema>;
