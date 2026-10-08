import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PlayEnvironmentIdSchema, EmbodimentVenueSchema } from "@clankie/protocol";

export const PlayJournalIdentitySchema = z.strictObject({
  runId: z.string().min(1).max(200),
  journeyId: z.string().trim().min(1).max(512),
  environmentId: PlayEnvironmentIdSchema,
  environmentSessionId: z.string().min(1).max(200),
  venue: EmbodimentVenueSchema,
});
export type PlayJournalIdentity = z.infer<typeof PlayJournalIdentitySchema>;

/** One append-only envelope; game payloads are evidence, never motor authority. */
export function openPlayJournalSink(options: {
  rootDir: string;
  identity: PlayJournalIdentity;
  clock?: () => Date;
  onError?: (error: unknown) => void;
}) {
  const identity = PlayJournalIdentitySchema.parse(options.identity);
  const clock = options.clock ?? (() => new Date());
  const stamp = clock().toISOString().replace(/[:.]/gu, "-");
  const safeRun = identity.runId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 120);
  mkdirSync(options.rootDir, { recursive: true, mode: 0o700 });
  const path = join(options.rootDir, `${stamp}-${safeRun}.jsonl`);
  return {
    path,
    append(line: { kind: string; [key: string]: unknown }) {
      try {
        const serialized =
          JSON.stringify({
            ...line,
            schemaVersion: line.kind === "header" ? 3 : 2,
            at: line.at ?? clock().toISOString(),
            ...identity,
          }) + "\n";
        if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("free_play_journal_line_too_large");
        appendFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        if (!options.onError) throw error;
        options.onError(error);
      }
    },
  };
}

/** Strip only validated envelope fields before a game's strict payload parser. */
export function journalPayload(line: Record<string, unknown>): Record<string, unknown> {
  if (line.kind === "header" || line.journeyId === undefined) return line;
  PlayJournalIdentitySchema.parse({
    runId: line.runId,
    journeyId: line.journeyId,
    environmentId: line.environmentId,
    environmentSessionId: line.environmentSessionId,
    venue: line.venue,
  });
  const {
    runId: _run,
    journeyId: _journey,
    environmentId: _environment,
    environmentSessionId: _session,
    venue: _venue,
    ...payload
  } = line;
  return payload;
}
