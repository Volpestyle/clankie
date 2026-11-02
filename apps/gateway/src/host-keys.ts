import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Public installation keys only; first successful proof pins the host permanently. */
export class HostKeys {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec(`PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS host_keys (host_id TEXT PRIMARY KEY, public_key TEXT NOT NULL);`);
  }
  get(hostId: string): string | undefined {
    return this.database.prepare("SELECT public_key FROM host_keys WHERE host_id=?").get(hostId)?.public_key as string | undefined;
  }
  /** Insert-if-absent and read back: concurrent first proofs cannot replace a pinned key. */
  accept(hostId: string, publicKey: string): boolean {
    this.database.prepare("INSERT INTO host_keys(host_id, public_key) VALUES (?, ?) ON CONFLICT(host_id) DO NOTHING").run(hostId, publicKey);
    return this.get(hostId) === publicKey;
  }
  close(): void { this.database.close(); }
}
