import { FreeAgentIntentSchema } from "./free-agent.ts";
import type { z } from "zod";

/** Exact current native recipient for an owner-authorized work handoff; busy is allowed. */
export const WorkHandoffIntentSchema = FreeAgentIntentSchema.omit({ helpTarget: true }).strict();
export type WorkHandoffIntent = z.infer<typeof WorkHandoffIntentSchema>;
