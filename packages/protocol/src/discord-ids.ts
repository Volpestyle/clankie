import { z } from "zod";

// Node-free, so app bundles can import the contracts that use them.
export const DiscordIdSchema = z.string().regex(/^[0-9]{1,20}$/u);
/**
 * What wakes a body for ordinary channel chat (VUH-1765): `mention` is an
 * @mention, DM, reply or slash command (his name in plain text does not count);
 * `name` adds his name in a message; `any` lets every admitted message reach
 * him so he decides for himself. `addressed` is the earlier spelling of
 * `mention`, still accepted on the wire and in stored settings; read it through
 * `discordWakeTrigger`.
 */
export const DiscordWakeTriggerSchema = z.enum(["mention", "name", "any", "addressed"]);
export type DiscordWakeTrigger = z.infer<typeof DiscordWakeTriggerSchema>;
type CurrentWakeTrigger = Exclude<DiscordWakeTrigger, "addressed">;

/** A stored or received wake trigger in its current spelling. */
export function discordWakeTrigger(value: DiscordWakeTrigger): CurrentWakeTrigger;
export function discordWakeTrigger(value: DiscordWakeTrigger | undefined): CurrentWakeTrigger | undefined;
export function discordWakeTrigger(value: DiscordWakeTrigger | undefined) {
  return value === "addressed" ? "mention" : value;
}
