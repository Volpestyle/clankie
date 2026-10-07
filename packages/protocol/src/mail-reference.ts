import { z } from "zod";

/** A navigable public link, never a file path or executable URL. */
export const MailUrlSchema = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "Expected an HTTP or HTTPS URL");

export const MailIssueReferenceSchema = z
  .object({
    tracker: z.string().trim().min(1).max(100),
    key: z.string().trim().min(1).max(256),
    url: MailUrlSchema,
  })
  .strict();
export type MailIssueReference = z.infer<typeof MailIssueReferenceSchema>;
