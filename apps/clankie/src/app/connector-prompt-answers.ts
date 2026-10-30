import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const PersistedSchema = z
  .object({ schemaVersion: z.literal(1), deviceIds: z.array(z.string().min(1).max(256)).max(256) })
  .strict();

/**
 * The apps signed in to the connector that the owner lets answer a prompt open
 * in an agent's pane (ADR 0303). Off for every app until the owner turns it on
 * on his Mac; an unreadable file reads as off for all. Without a path (tests)
 * the switch lives in memory.
 */
export class ConnectorPromptAnswers {
  private readonly deviceIds: Set<string>;
  private readonly path: string | undefined;

  public constructor(path?: string) {
    this.path = path;
    this.deviceIds = new Set(this.read());
  }

  public allowed(deviceId: string): boolean {
    return this.deviceIds.has(deviceId);
  }

  public set(deviceId: string, allowed: boolean): void {
    if (allowed) this.deviceIds.add(deviceId);
    else this.deviceIds.delete(deviceId);
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, deviceIds: [...this.deviceIds] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.path);
  }

  private read(): string[] {
    if (this.path === undefined || !existsSync(this.path)) return [];
    try {
      return PersistedSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))).deviceIds;
    } catch {
      return [];
    }
  }
}
