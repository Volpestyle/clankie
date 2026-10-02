import { z } from "zod";

/**
 * A hosted Clankie's AI credits (VUH-1403), for the owner's app. 1 credit is
 * $1 of AI usage at Clankie's rate. A monthly pack's credits reset each billing
 * period and are spent first; top-up credits roll over until used. The fleet
 * owns the numbers: the body asks it (`FLEET_BODY_CREDITS_PATH`) and returns
 * its answer unchanged, so the app, body and account page never disagree.
 */

/** Device → body, owner/operator devices; remote calls use the encrypted envelope. */
export const HOSTED_CREDITS_PATH = "/v1/hosted/credits";
/** Body → fleet: a signed body call, `POST /fleet/v1/body/credits`. */
export const FLEET_BODY_CREDITS_PATH = "/fleet/v1/body/credits";

/** Credits to one decimal place. */
const CreditsSchema = z.number().nonnegative().max(1_000_000);

export const HostedCreditsSchema = z
  .object({
    /** This billing period's monthly pack; null without one. */
    pack: z
      .object({
        credits: CreditsSchema,
        used: CreditsSchema,
        resetsAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    /** Top-up credits left. They roll over. */
    topUp: CreditsSchema,
    /** What Clankie can still spend: the pack's remainder plus top-ups. */
    available: CreditsSchema,
    /** At or under the low mark: show the low-balance notice. */
    low: z.boolean(),
    /** Where the owner buys credits: the account page's top-up. Never a payment link itself. */
    buyUrl: z.url({ protocol: /^https$/u }),
  })
  .strict();
export type HostedCredits = z.infer<typeof HostedCreditsSchema>;
