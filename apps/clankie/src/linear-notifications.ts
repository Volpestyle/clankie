import { existsSync, rmSync } from "node:fs";

/** Retire the old account-inbox checkpoint once. Webhooks now deliver directly to an ordinary chat. */
export function retireLinearNotifications(path: string, log: (message: string) => void): void {
  if (!existsSync(path)) return;
  rmSync(path);
  log("Retired Linear notification inbox checkpoint; previous account notification history dropped.");
}
