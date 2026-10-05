import { isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { installHarnessBridges } from "../harness-install.ts";
import { refreshLinkedHarnesses } from "../harness-refresh.ts";
import type { BrowserCommandOptions } from "./browser.ts";
import { codexSourceSetupCommand } from "../../../../integrations/claude-plugin/worker/bin/harness-install.mjs";

export async function runHarnessCommand(
  args: readonly string[],
  options: BrowserCommandOptions & { repoRoot: string },
) {
  if (args.length === 2 && args[0] === "install" && args[1] === "--refresh-linked")
    return refreshLinkedHarnesses(options);
  if (
    args[0] !== "install" ||
    ![1, 3].includes(args.length) ||
    (args.length === 3 && args[1] !== "--codex-source-setup")
  )
    throw new Error(
      "Usage: clankie harness install [--refresh-linked | --codex-source-setup /absolute/source-owned/script]",
    );
  if (args[2] && !isAbsolute(args[2]))
    throw new Error("Source setup must be an absolute source-owned script path");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Harness install needs an interactive terminal to review consent for each harness. No changes made.",
    );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await installHarnessBridges({
      ...options,
      ...(args[2] ? { codexSourceSetup: codexSourceSetupCommand(args[2]) } : {}),
      consent: async (_harness, detail) =>
        /^y(?:es)?$/iu.test((await terminal.question(`${detail}\nProceed? [y/N] `)).trim()),
    });
  } finally {
    terminal.close();
  }
}
