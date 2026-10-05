import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./command/io.ts";
import type { BrowserCommandOptions } from "./command/browser.ts";
import { createFleetShellRun, type HerdrFleet, type FleetShellRun } from "../../clankie/src/herdr-fleet.ts";
import { prepareFleet, workerPluginDir } from "../../clankie/src/fleet-prepare.ts";
import { installHarnessBridges } from "./harness-install.ts";
import type { HarnessInstallResult } from "../../../integrations/claude-plugin/worker/bin/harness-install.mjs";

export interface HarnessRefreshResult {
  readonly ok: boolean;
  readonly local: readonly HarnessInstallResult[];
  readonly fleets: readonly { fleet: string; ok: boolean; result?: unknown; error?: string }[];
  readonly notices: { state: "announced" | "deferred"; detail?: string };
}
const completed = (results: readonly HarnessInstallResult[]) =>
  results.every((entry) => ["installed", "updated", "source-setup-completed"].includes(entry.status));

/** Update is prior approval to maintain existing links, never permission to enroll new profiles. */
export async function refreshLinkedHarnesses(
  options: BrowserCommandOptions & {
    repoRoot: string;
    env?: NodeJS.ProcessEnv;
    settings?: SettingsStore;
    fleets?: readonly HerdrFleet[];
    shell?: (fleet: HerdrFleet) => FleetShellRun;
  },
): Promise<HarnessRefreshResult> {
  const env = options.env ?? process.env;
  const settings = await (options.settings ?? new SettingsStore(defaultSettingsPath(env))).load();
  const local = await installHarnessBridges({
    repoRoot: options.repoRoot,
    env,
    linkedOnly: true,
    consent: async () => true,
    codexHomes: settings.codexAccounts.map((entry) => entry.home),
  });
  const configured =
    options.fleets ??
    settings.execution.connections.flatMap((entry) =>
      entry.enabled && entry.ssh ? [{ id: entry.id, session: entry.session, ssh: entry.ssh }] : [],
    );
  const fleets: HarnessRefreshResult["fleets"][number][] = [];
  // Session aliases may share a machine/account. Ship and refresh each SSH destination only once.
  const destinations = new Map<string, HarnessRefreshResult["fleets"][number]>();
  for (const fleet of configured) {
    const key = JSON.stringify([fleet.ssh.host, fleet.ssh.shell]);
    const previous = destinations.get(key);
    if (previous) {
      fleets.push({ ...previous, fleet: fleet.id });
      continue;
    }
    let receipt: HarnessRefreshResult["fleets"][number];
    try {
      const result = await prepareFleet(fleet, {
        shell:
          options.shell?.(fleet) ??
          createFleetShellRun(fleet, {
            controlDirectory: join(env.HOME || env.USERPROFILE || homedir(), ".clankie", "ssh"),
          }),
        workerPluginDir: workerPluginDir(options.repoRoot),
        linkedOnly: true,
      });
      receipt = {
        fleet: fleet.id,
        ok: Array.isArray(result.installations) && completed(result.installations),
        result,
      };
    } catch (error) {
      receipt = { fleet: fleet.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    destinations.set(key, receipt);
    fleets.push(receipt);
  }
  const notices = await announceInstalledPlugin(options);
  return { ok: completed(local) && fleets.every((entry) => entry.ok), local, fleets, notices };
}

/** A release can change plugins while the service stays running at its previous release. */
async function announceInstalledPlugin(
  options: BrowserCommandOptions & { repoRoot: string },
): Promise<HarnessRefreshResult["notices"]> {
  try {
    const version = JSON.parse(
      await readFile(join(workerPluginDir(options.repoRoot), ".claude-plugin", "plugin.json"), "utf8"),
    ).version;
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
    });
    if (!credential)
      return {
        state: "deferred",
        detail: "No operator credential; running panes will be inspected when the updated service connects.",
      };
    const response = await (options.fetchImpl ?? fetch)(
      new URL("/v1/harness-plugin-version", commandHost(options)),
      {
        method: "POST",
        headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
        body: JSON.stringify({ version }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      return {
        state: "deferred",
        detail: `Plugin restart flags unavailable (${response.status}); reconnect the updated service to inspect running panes.`,
      };
    return { state: "announced" };
  } catch {
    return {
      state: "deferred",
      detail: "Service unavailable; running panes will be inspected when the updated service connects.",
    };
  }
}
