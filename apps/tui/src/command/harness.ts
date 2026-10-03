import { createInterface } from "node:readline/promises";
import { installHarnessBridges } from "../harness-install.ts";

export async function runHarnessCommand(
  args: readonly string[],
  options: { repoRoot: string; env?: NodeJS.ProcessEnv },
) {
  if (
    args[0] !== "install" ||
    ![1, 3].includes(args.length) ||
    (args.length === 3 && args[1] !== "--codex-source-setup")
  )
    throw new Error("Usage: clankie harness install [--codex-source-setup /absolute/source-owned/script]");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Harness install needs an interactive terminal to review consent for each harness. No changes made.",
    );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await installHarnessBridges({
      ...options,
      ...(args[2] ? { codexSourceSetup: { command: args[2], args: [] } } : {}),
      consent: async (_harness, detail) =>
        /^y(?:es)?$/iu.test((await terminal.question(`${detail}\nProceed? [y/N] `)).trim()),
    });
  } finally {
    terminal.close();
  }
}
