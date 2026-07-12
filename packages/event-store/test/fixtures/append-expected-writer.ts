import { existsSync, writeFileSync } from "node:fs";
import { OptimisticConcurrencyError, SqliteEventStore } from "../../src/index.ts";
import type { DomainEvent } from "@clankie/protocol";

const [databasePath, readyPath, releasePath, encodedEvent] = process.argv.slice(2);
if (!databasePath || !readyPath || !releasePath || !encodedEvent) {
  throw new Error("append-expected-writer requires database, ready, release, and event arguments");
}

const event = JSON.parse(Buffer.from(encodedEvent, "base64url").toString("utf8")) as DomainEvent;
let store: SqliteEventStore | undefined;
try {
  store = new SqliteEventStore(databasePath);
  writeFileSync(readyPath, "ready\n", "utf8");
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 5);
  const stored = await store.appendExpected(event, {
    streamId: event.missionId,
    expectedRevision: 0,
  });
  console.log(JSON.stringify({ ok: true, stored }));
} catch (error) {
  const candidate = error as Error & { code?: string };
  console.log(
    JSON.stringify({
      ok: false,
      error: {
        name: candidate.name,
        message: candidate.message,
        code: candidate.code,
        optimistic: error instanceof OptimisticConcurrencyError,
      },
    }),
  );
} finally {
  store?.close();
}
