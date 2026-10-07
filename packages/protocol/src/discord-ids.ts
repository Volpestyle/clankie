import { z } from "zod";

// Node-free, so app bundles can import the contracts that use them.
export const DiscordIdSchema = z.string().regex(/^[0-9]{1,20}$/u);
/**
 * What wakes a body for ordinary channel chat (VUH-1765): `addressed` is a
 * mention, DM, reply or slash command; `name` adds his name in a message;
 * `any` lets every admitted message reach him so he decides for himself.
 */
export const DiscordWakeTriggerSchema = z.enum(["addressed", "name", "any"]);
export type DiscordWakeTrigger = z.infer<typeof DiscordWakeTriggerSchema>;
