import { z } from "zod";

export const RemoteLeadLaunchSchema = z
  .object({
    requestId: z.string().uuid(),
    fleet: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    workingDirectory: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
    title: z.string().trim().min(1).max(100),
    conversationId: z.string().min(1).max(256).optional(),
  })
  .strict();

export type RemoteLeadLaunch = z.infer<typeof RemoteLeadLaunchSchema>;
