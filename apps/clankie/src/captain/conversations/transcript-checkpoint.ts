import { chmodSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Exact native entry membership, including sessions no longer in the tail.
 * SQLite changes bounded pages rather than rewriting the lifetime set on each
 * metadata save. DELETE journals are removed at commit; the index itself keeps
 * historical IDs until the conversation is reset or removed.
 */
export class TranscriptCheckpointIndex {
  private readonly db: DatabaseSync;
  private readonly lookup;
  private readonly insert;
  // Covers the native 9k-entry tail without keeping lifetime IDs in memory.
  // Eviction changes only lookup cost: older IDs still have exact disk membership.
  private readonly recent = new Set<string>();

  private remember(id: string): void {
    this.recent.delete(id);
    this.recent.add(id);
    if (this.recent.size > 16_384) this.recent.delete(this.recent.values().next().value!);
  }

  public constructor(path: string, required: boolean) {
    if (required && !statSync(path, { throwIfNoEntry: false })?.isFile())
      throw new Error("Native transcript checkpoint index is missing; refusing duplicate replay");
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA cache_size=-512; PRAGMA journal_mode=DELETE;");
      if (!required) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS checkpoint_version (version INTEGER PRIMARY KEY CHECK(version = 1));
          INSERT OR IGNORE INTO checkpoint_version VALUES (1);
          CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY) WITHOUT ROWID;
        `);
      }
      const version = this.db.prepare("SELECT version FROM checkpoint_version").get();
      if (version?.version !== 1) throw new Error("Unsupported native transcript checkpoint index");
      this.lookup = this.db.prepare("SELECT 1 FROM entries WHERE id = ?");
      this.insert = this.db.prepare("INSERT OR IGNORE INTO entries (id) VALUES (?)");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  public has(id: string): boolean {
    if (this.recent.has(id)) return true;
    if (this.lookup.get(id) === undefined) return false;
    this.remember(id);
    return true;
  }

  /** Commit before replacing the legacy inline checkpoint with its reference. */
  public add(ids: Iterable<string>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        this.insert.run(id);
        this.remember(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.recent.clear();
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public close(): void {
    this.db.close();
  }
}
