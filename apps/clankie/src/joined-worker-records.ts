import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ReportLeadSchema } from "./captain/hire-owners.ts";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../../tui/bin/update-files.ts";

const RecordSchema = z.strictObject({
  id: z.uuid(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  machineId: z.string().min(1).max(256),
  directory: z.string().min(1).max(4096),
  sessionId: z.uuid(),
  harness: z.enum(["claude", "codex"]),
  conversationId: z.string().min(1).max(256),
  requiresLead: z.boolean(),
  paneId: z.string().min(1).max(256).optional(),
  nativeSessionId: z.string().min(1).max(256).optional(),
  touchedAt: z.number().finite(),
  reportLeads: z.array(ReportLeadSchema).max(32),
});
export type JoinedWorkerRecord = z.infer<typeof RecordSchema>;

/** Report authority only. Never inserted into the native fleet control/adoption journal. */
export class JoinedWorkerRecords {
  readonly records = new Map<string, JoinedWorkerRecord>();
  private readonly directory: string | undefined;
  constructor(directory?: string) {
    this.directory = directory;
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
    for (const file of readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(file)) continue;
      const record = RecordSchema.parse(readPrivateJson(join(directory, file)));
      if (file !== `${record.id}.json` || this.records.has(record.tokenHash))
        throw Error("joined_worker_journal_conflict");
      this.records.set(record.tokenHash, record);
    }
  }
  save(record: JoinedWorkerRecord): void {
    const parsed = RecordSchema.parse(record);
    if (this.directory) writePrivateJson(join(this.directory, `${parsed.id}.json`), parsed);
    this.records.set(parsed.tokenHash, parsed);
  }
  remove(record: JoinedWorkerRecord): void {
    if (this.directory) {
      const path = join(this.directory, `${record.id}.json`);
      if (existsSync(path)) unlinkSync(path);
    }
    this.records.delete(record.tokenHash);
  }
}
