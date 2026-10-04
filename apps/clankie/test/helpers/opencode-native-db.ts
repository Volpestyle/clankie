import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

/** Own fixture only: native startup's schema/session write, never an owner DB. */
export async function writeOpenCodeNativeSession(database: string, cwd: string, sessionId: string) {
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA foreign_keys=OFF"); // Only history tables are present in this fixture.
    db.exec(await readFile(new URL("../fixtures/opencode-history-1.18.18.sql", import.meta.url), "utf8"));
    db.prepare(
      "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
    ).run(sessionId, "project", "native", cwd, "Native fixture", "1.18.18", 1, 2);
  } finally {
    db.close();
  }
}
