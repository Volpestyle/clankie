import { resolve } from "node:path";
import { captainSessionDatabasePath, stableProjectId } from "./project-identity.ts";
import { openCaptainSessionLedger, type CaptainSessionLedger } from "./ledger.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
let ledgerPromise: Promise<CaptainSessionLedger> | undefined;

export function captainSessionLedger(): Promise<CaptainSessionLedger> {
  ledgerPromise ??= stableProjectId(repoRoot).then((projectId) =>
    openCaptainSessionLedger(projectId, captainSessionDatabasePath(projectId)),
  );
  return ledgerPromise;
}
