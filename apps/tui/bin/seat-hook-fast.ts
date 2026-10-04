/**
 * The per-turn seat hook commands (`memory-card`, `seat-sync`, `seat-hook`)
 * without the launcher's import graph: about a third of the cold start, paid on
 * every prompt and tool call of a harness seat. Anything unusual — a hosted
 * install, unreadable settings, a direct conversation flag, any other command —
 * returns undefined and takes the full launcher, the one dispatcher of record.
 */
import { defaultSettingsPath, SettingsStore } from "@clankie/settings";

const FAST_COMMANDS = new Set(["memory-card", "seat-sync", "seat-hook"]);

export async function runFastSeatHook(argv: readonly string[]): Promise<number | undefined> {
  const [command, ...rest] = argv;
  if (command === undefined || !FAST_COMMANDS.has(command) || rest.includes("--chat")) return undefined;
  // A hosted install routes these through its device transport; only the
  // launcher knows how, and it also owns reporting unreadable settings.
  const settings = await new SettingsStore(defaultSettingsPath(process.env)).load().catch(() => undefined);
  if (settings === undefined || settings.client?.mode === "hosted") return undefined;
  try {
    if (command === "memory-card") {
      const { runMemoryCardCommand } = await import("../src/command/memory-card.ts");
      return await runMemoryCardCommand(rest, { stdout: process.stdout });
    }
    if (command === "seat-hook") {
      const { runSeatHookCommand } = await import("../src/command/seat-hook.ts");
      return await runSeatHookCommand(rest);
    }
    const { runSeatSyncCommand } = await import("../src/command/seat-sync.ts");
    return await runSeatSyncCommand(rest);
  } catch (error) {
    process.stderr.write(`clankie: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
