import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** Agents the owner granted one app beyond its own hires, at most this many in all. */
const PANE_GRANTS_MAX = 256;

const DeviceIdSchema = z.string().min(1).max(256);
const PaneGrantSchema = z
  .object({ deviceId: DeviceIdSchema, terminalId: z.string().min(1).max(256) })
  .strict();
const PersistedSchema = z.union([
  z.object({ schemaVersion: z.literal(1), deviceIds: z.array(DeviceIdSchema).max(256) }).strict(),
  z
    .object({
      schemaVersion: z.literal(2),
      deviceIds: z.array(DeviceIdSchema).max(256),
      paneGrants: z.array(PaneGrantSchema).max(PANE_GRANTS_MAX),
    })
    .strict(),
]);

export type PaneGrant = z.infer<typeof PaneGrantSchema>;

/**
 * The apps signed in to the connector that the owner lets answer a prompt open
 * in an agent's pane (ADR 0303). Off for every app until the owner turns it on
 * on his Mac; an unreadable file reads as off for all. Without a path (tests)
 * the switch lives in memory.
 *
 * An app that is on answers only agents it hired itself. The owner may grant it
 * one exact agent id more (`clankie connector prompts pane APP AGENT on`); each
 * grant is listed with the app and recorded on the note board when used.
 *
 * The file is read once, when the service starts. It changes only through
 * {@link ConnectorPromptAnswers.set} and {@link ConnectorPromptAnswers.setPane},
 * which the owner's own route calls; an edit on disk while the service runs takes
 * effect nowhere and is overwritten by the owner's next change.
 */
export class ConnectorPromptAnswers {
  private readonly deviceIds: Set<string>;
  private paneGrants: PaneGrant[];
  private readonly path: string | undefined;

  public constructor(path?: string) {
    this.path = path;
    const persisted = this.read();
    this.deviceIds = new Set(persisted.deviceIds);
    this.paneGrants = persisted.paneGrants;
  }

  public allowed(deviceId: string): boolean {
    return this.deviceIds.has(deviceId);
  }

  /** Whether the owner granted this app this exact agent id beyond its own hires. */
  public paneGranted(deviceId: string, terminalId: string): boolean {
    return this.paneGrants.some((grant) => grant.deviceId === deviceId && grant.terminalId === terminalId);
  }

  /** The agent ids the owner granted this app. */
  public panes(deviceId: string): string[] {
    return this.paneGrants.filter((grant) => grant.deviceId === deviceId).map((grant) => grant.terminalId);
  }

  public set(deviceId: string, allowed: boolean): void {
    if (allowed) this.deviceIds.add(deviceId);
    else this.deviceIds.delete(deviceId);
    this.write();
  }

  /** Grant or withdraw one exact agent id for one app; false when the grants are full. */
  public setPane(deviceId: string, terminalId: string, allowed: boolean): boolean {
    const others = this.paneGrants.filter(
      (grant) => grant.deviceId !== deviceId || grant.terminalId !== terminalId,
    );
    if (allowed && others.length >= PANE_GRANTS_MAX) return false;
    this.paneGrants = allowed ? [...others, { deviceId, terminalId }] : others;
    this.write();
    return true;
  }

  private write(): void {
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: 2, deviceIds: [...this.deviceIds], paneGrants: this.paneGrants }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.path);
  }

  private read(): { deviceIds: string[]; paneGrants: PaneGrant[] } {
    if (this.path === undefined || !existsSync(this.path)) return { deviceIds: [], paneGrants: [] };
    try {
      const persisted = PersistedSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      return {
        deviceIds: persisted.deviceIds,
        paneGrants: persisted.schemaVersion === 2 ? persisted.paneGrants : [],
      };
    } catch {
      return { deviceIds: [], paneGrants: [] };
    }
  }
}
