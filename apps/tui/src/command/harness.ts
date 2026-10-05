import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import { refreshLinkedHarnesses } from "../harness-refresh.ts";
import type { BrowserCommandOptions } from "./browser.ts";
import { automaticCodexConsent, codexSourceSetupCommand, installHarnessBridges } from "../harness-install.ts";
import { confirmMachineSetupApproval, machineSetupContext } from "./machine-setup.ts";

export async function runHarnessCommand(
  args: readonly string[],
  options: BrowserCommandOptions & {
    repoRoot: string;
    cwd?: string;
    execute?: NonNullable<Parameters<typeof installHarnessBridges>[0]["execute"]>;
    prepareSkills?: NonNullable<Parameters<typeof installHarnessBridges>[0]["prepareSkills"]>;
  },
) {
  const usage =
    "Usage: clankie harness install [--refresh-linked | --codex-source-setup /absolute/source-owned/script] [--project PROJECT] [--approve]";
  if (args[0] !== "install") throw new Error(usage);
  const flags = new Map<string, string>();
  let approvalRequested = false;
  let refreshLinked = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--approve" && !approvalRequested) {
      approvalRequested = true;
      continue;
    }
    if (flag === "--refresh-linked" && !refreshLinked) {
      refreshLinked = true;
      continue;
    }
    if (
      !["--codex-source-setup", "--project"].includes(flag) ||
      flags.has(flag) ||
      args[index + 1] === undefined
    )
      throw new Error(usage);
    flags.set(flag, args[++index]!);
  }
  const sourceSetup = flags.get("--codex-source-setup");
  if (refreshLinked && sourceSetup !== undefined) throw new Error(usage);
  if (sourceSetup !== undefined && (!isAbsolute(sourceSetup) || /\p{Cc}/u.test(sourceSetup)))
    throw new Error("Source setup must be an absolute source-owned script path");
  if (sourceSetup !== undefined && !approvalRequested)
    throw new Error(
      "New Codex source setup requires interactive owner approval; use --approve in an interactive terminal.",
    );
  const requestedProject = flags.get("--project");
  const contextOptions = {
    ...options,
    ...(requestedProject === undefined ? {} : { projectId: requestedProject }),
  };
  const initial = await machineSetupContext("local", contextOptions);
  let approved = false;
  if (approvalRequested) {
    await confirmMachineSetupApproval(
      `${refreshLinked ? "Refresh linked harness profiles on local and configured SSH machines" : "Install harness bridges on local"} in ${initial.workingDirectory}${initial.projectId ? ` (project ${initial.projectId})` : ""}.${sourceSetup ? ` Run and remember Codex source setup ${sourceSetup}.` : ""}`,
    );
    const after = await machineSetupContext("local", contextOptions);
    if (after.projectId !== initial.projectId || after.workingDirectory !== initial.workingDirectory)
      throw new Error("The setup workspace or project changed during approval.");
    approved = true;
  }
  const env = options.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || homedir();
  const claudeProfile = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexProfile = env.CODEX_HOME || join(home, ".codex");
  const claudeExists = await stat(claudeProfile)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  const codexExists = await stat(codexProfile)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  const claudeSource = await realpath(join(claudeProfile, "settings.json")).catch(() =>
    join(claudeProfile, "settings.json"),
  );
  const marketplace = join(options.repoRoot, "integrations", "claude-plugin");
  const selectedClaudeDetails = [
    `Install and enable clankie-worker@clankie from ${marketplace} for profile ${claudeProfile} (bridge, native hooks and packaged skills).`,
    `Update the existing clankie-worker cache for alias profile ${claudeProfile}; shared settings at ${claudeSource} stay unchanged.`,
  ];
  const selectedConsent: Parameters<typeof installHarnessBridges>[0]["consent"] = async (
    harness,
    detail,
    context,
  ) => {
    if (harness === "codex")
      return (
        codexExists &&
        context?.profile === codexProfile &&
        (approved || (await automaticCodexConsent(detail, context, marketplace)))
      );
    return claudeExists && context?.profile === claudeProfile && selectedClaudeDetails.includes(detail);
  };
  if (refreshLinked) {
    const refreshSettings = options.settings ?? new SettingsStore(defaultSettingsPath(options.env));
    const authorizeSetup: NonNullable<
      Parameters<typeof refreshLinkedHarnesses>[0]["authorizeSetup"]
    > = async (machine, fleet) => {
      const current = await machineSetupContext(machine, contextOptions);
      if (current.projectId !== initial.projectId || current.workingDirectory !== initial.workingDirectory)
        throw new Error("The setup workspace or project changed; inspect its policy before proceeding.");
      if (fleet) {
        const connection = (await refreshSettings.load()).execution.connections.find(
          (entry) => entry.id === machine,
        );
        if (
          fleet.id !== machine ||
          !connection?.enabled ||
          connection.session !== fleet.session ||
          connection.ssh?.host !== fleet.ssh.host ||
          connection.ssh.shell !== fleet.ssh.shell
        )
          throw new Error("The linked setup destination changed; inspect its connection before proceeding.");
      }
      if (current.effective.machineSetup === "owner" && !approved)
        throw new Error("Harness refresh requires the owner's explicit --approve under owner policy.");
      if (!current.machine.linked && !approved)
        throw new Error("Automatic harness refresh needs an already-linked machine.");
    };
    await authorizeSetup("local");
    return refreshLinkedHarnesses({
      ...options,
      settings: refreshSettings,
      authorizeSetup,
      consent: async (harness, detail, context) =>
        harness === "claude" || approved || automaticCodexConsent(detail, context, marketplace),
    });
  }
  if (initial.effective.machineSetup === "lead" && !initial.machine.linked && !approved)
    throw new Error(
      "Automatic harness setup needs an already-linked machine; ask the owner to approve setup or connect it.",
    );
  if (
    initial.effective.machineSetup === "owner" &&
    !approved &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error(
      "Harness setup requires owner approval. Use an interactive terminal or the owner's explicit --approve. No changes made.",
    );
  const terminal =
    initial.effective.machineSetup === "owner" && !approved
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
  try {
    return await installHarnessBridges({
      ...options,
      ...(sourceSetup ? { codexSourceSetup: codexSourceSetupCommand(sourceSetup) } : {}),
      consent: async (harness, detail, context) => {
        const current = await machineSetupContext("local", contextOptions);
        if (current.projectId !== initial.projectId || current.workingDirectory !== initial.workingDirectory)
          throw new Error("The setup project changed; inspect its policy before proceeding.");
        if (current.effective.machineSetup === "lead" || approved) {
          if (!current.machine.linked && !approved) throw new Error("The setup machine is no longer linked.");
          return selectedConsent(harness, detail, context);
        }
        if (!terminal)
          throw new Error("Machine setup now requires owner approval; review the current policy.");
        if (!/^y(?:es)?$/iu.test((await terminal.question(`${detail}\nProceed? [y/N] `)).trim()))
          return false;
        const after = await machineSetupContext("local", contextOptions);
        if (after.projectId !== initial.projectId || after.workingDirectory !== initial.workingDirectory)
          throw new Error("The setup project changed during approval.");
        return true;
      },
    });
  } finally {
    terminal?.close();
  }
}
