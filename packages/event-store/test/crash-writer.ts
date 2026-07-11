/**
 * Crash-test child: appends events one at a time and acknowledges each id on
 * stdout only after the append has resolved (i.e. the transaction committed).
 * The parent test SIGKILLs this process mid-stream and asserts that every
 * acknowledged event survived. Run with: node crash-writer.ts <db-path> <count>
 */
// Import the sqlite module directly (not the package barrel): this file runs
// under plain `node`, whose strip-only TypeScript mode cannot erase the
// parameter properties used elsewhere in the package.
import { SqliteEventStore } from "../src/sqlite.ts";

const path = process.argv[2];
const total = Number(process.argv[3] ?? 5000);
if (!path) throw new Error("Usage: crash-writer.ts <db-path> <count>");

const store = new SqliteEventStore(path);
for (let index = 1; index <= total; index += 1) {
  const stored = await store.append({
    id: `crash-e-${String(index)}`,
    occurredAt: new Date(Date.UTC(2026, 6, 10, 0, 0, 0, index)).toISOString(),
    missionId: "m-crash",
    correlationId: "c-crash",
    profileHash: "profile-crash",
    type: "task.started",
    data: { index },
  });
  process.stdout.write(`${stored.event.id}\n`);
}
store.close();
