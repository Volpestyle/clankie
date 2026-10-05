import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessInstallConsentContext } from "../../../integrations/claude-plugin/worker/bin/harness-install.mjs";

export { installHarnessBridges } from "../../../integrations/claude-plugin/worker/bin/harness-install.mjs";
export { codexSourceSetupCommand } from "../../../integrations/claude-plugin/worker/bin/harness-install.mjs";

/** Automatic setup may reuse exact prior source consent; it cannot authorize a new source command. */
export async function automaticCodexConsent(
  detail: string,
  context: HarnessInstallConsentContext | undefined,
  marketplace: string,
): Promise<boolean> {
  if (!context) return false;
  const source = await realpath(join(context.profile, "config.toml")).catch(() =>
    join(context.profile, "config.toml"),
  );
  if (source !== context.source) return false;
  if (!context.managed)
    return (
      context.sourceSetup === undefined &&
      detail ===
        `Install clankie-worker@clankie-fleet from ${marketplace} through Codex's native plugin manager (bridge and skills).`
    );
  const setup = context.sourceSetup;
  if (!setup) return false;
  try {
    const record = JSON.parse(
      await readFile(join(context.profile, "plugins", "clankie-source-setup.json"), "utf8"),
    );
    return (
      record.source === context.source &&
      record.command === setup.command &&
      Array.isArray(record.args) &&
      record.args.length === setup.args.length &&
      record.args.every(
        (arg: unknown, index: number) => typeof arg === "string" && arg === setup.args[index],
      ) &&
      detail ===
        `codex configuration is managed at ${context.source}. Run source setup ${setup.command} to install clankie-worker@clankie-fleet.`
    );
  } catch {
    return false;
  }
}
