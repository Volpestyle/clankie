import { MachineWorkerAccountsSchema } from "@clankie/protocol/worker-accounts";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** The same identity-keyed list supplies CLI, Settings and usage. */
export async function readHarnessAccountList(harness: "claude" | "codex", options: OwnerSettingsApiOptions) {
  const api = await ownerSettingsApi(options);
  const report = await api.get("/v1/worker-accounts", MachineWorkerAccountsSchema);
  return {
    ok: true as const,
    accounts: report.accounts
      .filter((account) => account.harness === harness)
      .map((account) => ({ ...account, authPresent: account.signedIn === true })),
    notices: report.notices ?? [],
  };
}
