import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { HerdrBindingSchema } from "@clankie/protocol";

export function isLocalCodexEndpoint(value: string): boolean {
  return (
    value.startsWith("unix:///") &&
    value.length > "unix:///".length &&
    !["\0", "\r", "\n"].some((character) => value.includes(character))
  );
}

/** Controller-created launches; records alone never establish a live occupant. */
export const LocalCodexStateSchema = z
  .object({
    version: z.literal(1),
    seats: z.array(
      z
        .object({
          pid: z.number().int().min(2),
          pane: z.string().regex(/^w[\w]+:p[\w]+$/u),
          binding: HerdrBindingSchema,
          start: z.string().min(1),
          nativeOccupantId: z.string().min(1),
          threadId: z.string().min(1).optional(),
          endpoint: z.string().refine(isLocalCodexEndpoint).optional(),
          parent: z
            .object({
              paneId: z.string().regex(/^w[\w]+:p[\w]+$/u),
              occupantId: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

function localCodexRecordsPath(): string {
  return join(
    resolve(process.env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie")),
    "local-codex-seats.json",
  );
}

/** Read-only discovery fails closed; only the registry may repair its state file. */
export function readLocalCodexRecords(
  path = localCodexRecordsPath(),
): z.infer<typeof LocalCodexStateSchema>["seats"] {
  try {
    return LocalCodexStateSchema.parse(JSON.parse(readFileSync(path, "utf8"))).seats;
  } catch {
    return [];
  }
}
