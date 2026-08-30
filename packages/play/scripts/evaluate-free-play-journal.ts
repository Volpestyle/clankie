import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { evaluateFreePlayJournal } from "../src/free-play-evaluator.ts";

export function evaluateFreePlayJournalCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      events: { type: "string" },
      "voice-receipts": { type: "string" },
    },
  });
  const journalPath = positionals[0];
  if (journalPath === undefined) {
    throw new Error(
      "usage: evaluate-free-play-journal <journal.jsonl> [--events path] [--voice-receipts path]",
    );
  }
  const stateRoot = env.CLANKIE_STATE?.trim() || path.join(homedir(), ".clankie");
  const eventOverride = env.CLANKIE_EVENT_LOG?.trim() || undefined;
  const stateHome = env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
  const voiceOverride = env.DISCORD_BRIDGE_RECEIPT_PATH || undefined;
  const lifecycleEvents = optional(values.events ?? eventOverride, path.join(stateRoot, "events.jsonl"));
  const voiceReceipts = optional(
    values["voice-receipts"] ?? voiceOverride,
    path.join(stateHome, "clankie", "discord-live-receipts.jsonl"),
  );

  return `${JSON.stringify(
    evaluateFreePlayJournal({
      journal: readFileSync(path.resolve(journalPath), "utf8"),
      ...(lifecycleEvents === undefined ? {} : { lifecycleEvents }),
      ...(voiceReceipts === undefined ? {} : { voiceReceipts }),
    }),
    null,
    2,
  )}\n`;
}

const optional = (configured: string | undefined, fallback: string): string | undefined => {
  const resolved = configured ?? fallback;
  if (configured !== undefined) return readFileSync(resolved, "utf8");
  return existsSync(fallback) ? readFileSync(fallback, "utf8") : undefined;
};

if (import.meta.main) process.stdout.write(evaluateFreePlayJournalCli(process.argv.slice(2)));
