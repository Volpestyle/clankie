import {
  createCodingTools,
  createReadOnlyTools,
  createPowerShellTool,
} from "@earendil-works/pi-coding-agent";
import type { SettingsStore } from "@clankie/settings";
import { requireMachineAccess } from "../machine-access.ts";

/** Override every native coding tool, including tools a session can activate later. */
export function machineCodingTools(
  cwd: string,
  settings: SettingsStore,
  options?: Parameters<typeof createCodingTools>[1],
) {
  const coding = createCodingTools(cwd, options);
  const tools = [
    ...coding,
    ...createReadOnlyTools(cwd, options).filter((tool) => tool.name !== "read"),
    createPowerShellTool(cwd),
  ];
  return tools.map((tool) => ({
    ...tool,
    // Let the SDK retain its configured/default active loadout.
    defaultActive: false,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      await requireMachineAccess(settings, "local", "shell");
      return tool.execute(...args);
    },
  }));
}
