import { closeSync, constants, fstatSync, fsyncSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeUpdater } from "../../../../tui/bin/runtime-updater.ts";
import { readRuntimeUpdate, type RuntimeUpdateResult } from "../../../../tui/bin/runtime-update.ts";
import { operationId } from "../../../../tui/bin/update-files.ts";

/** Initial health failure automatically boots the old reader. Keep its layout until that window closes. */
export function createInboundReportMigrationGate(options: {
  readonly updater: Pick<RuntimeUpdater, "runtime" | "status">;
  readonly updatesDirectory: string;
  readonly operation?: string;
}): () => boolean {
  const { updater, updatesDirectory, operation } = options;
  const boot = updater.runtime;
  let ready = false;
  const healthy = (result: RuntimeUpdateResult) =>
    result.phase === "healthy" &&
    result.healthy === true &&
    result.newCommit === boot.commit &&
    (operation === undefined || result.id === operation) &&
    result.serviceReceipts?.some(
      (receipt) =>
        receipt.ok &&
        receipt.services.every((service) => service.ok) &&
        receipt.services.some((service) => service.id === "clankie") &&
        receipt.runtime?.root === boot.root &&
        receipt.runtime.commit === boot.commit &&
        // An ordinary restart may follow a healthy cutover of this same commit.
        (operation === undefined ||
          (receipt.runtime.instanceId === boot.instanceId && receipt.runtime.pid === boot.pid)),
    ) === true;
  return () => {
    // After a durable healthy cutover the helper cannot automatically roll back.
    // A later explicit downgrade still requires the offline conversion runbook.
    if (ready) return true;
    try {
      const status = updater.status();
      if (status.error || status.needsReconciliation) return false;
      const result = status.latest;
      if (result === undefined) {
        // A fresh standalone install has no previous runtime transaction.
        if (operation !== undefined || status.pending !== undefined) return false;
        return (ready = true);
      }
      if (status.pending !== undefined && status.pending !== result.id) return false;
      if (!healthy(result)) return false;
      const directory = join(updatesDirectory, operationId(result.id));
      const path = join(directory, "result.json");
      const before = statSync(path, { bigint: true });
      const persisted = readRuntimeUpdate(directory);
      if (persisted.id !== result.id || !healthy(persisted)) return false;
      const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(file, { bigint: true });
        if (
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size ||
          opened.mtimeNs !== before.mtimeNs ||
          opened.ctimeNs !== before.ctimeNs
        )
          return false;
        // The updater atomically renames its record. Sync it and its parents
        // before making the receipt format unreadable to the old runtime.
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      for (const parent of [directory, updatesDirectory]) {
        const file = openSync(parent, "r");
        try {
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
      }
      ready = true;
      return true;
    } catch {
      // Missing, corrupt, changing or unsynced provenance leaves the legacy inbox intact.
      return false;
    }
  };
}
