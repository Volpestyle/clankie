import { z } from "zod";

/** The running service's selected worker runtime; settings may have a pending change. */
export const HERDR_BINDING_PATH = "/v1/herdr";
export const HERDR_SOCKET_HEADER = "x-clankie-herdr-socket";
export const HerdrBindingSchema = z
  .object({
    runtime: z.enum(["bundled", "external"]),
    session: z.string().min(1).max(64),
    socketPath: z.string().startsWith("/").max(102),
  })
  .strict();
export type HerdrBinding = z.infer<typeof HerdrBindingSchema>;
