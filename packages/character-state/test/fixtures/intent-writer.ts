import { existsSync, writeFileSync } from "node:fs";
import { CharacterStateRepository } from "../../src/index.ts";
import { OptimisticConcurrencyError, SqliteEventStore } from "@clankie/event-store";

const [databasePath, readyPath, releasePath, encodedCommand, revisionText] = process.argv.slice(2);
if (!databasePath || !readyPath || !releasePath || !encodedCommand || !revisionText) {
  throw new Error("intent-writer requires database, ready, release, command, and revision arguments");
}

const command = JSON.parse(Buffer.from(encodedCommand, "base64url").toString("utf8")) as unknown;
let store: SqliteEventStore | undefined;
try {
  store = new SqliteEventStore(databasePath);
  const repository = new CharacterStateRepository(store);
  writeFileSync(readyPath, "ready\n", "utf8");
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 5);
  const result = await repository.submitIntent(command, Number(revisionText));
  console.log(JSON.stringify({ ok: true, decision: result.decision, stored: result.stored }));
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
