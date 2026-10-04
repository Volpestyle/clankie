/**
 * `clankie memory-card` — the memory card that lane's next run would inject
 * (VUH-1086). A per-turn hook in another harness reads it so the seat carries
 * the same recent past his own sessions do; the service filters it by lane, so
 * operator-private notes only ever reach the operator lane.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CaptainSessionLaneV2Schema, type CaptainSessionLaneV2 } from "@clankie/protocol";
import { fetchLaneText, parseLane, type LaneReadCommandOptions } from "./prompt.ts";

const MEMORY_CARD_USAGE = [
  `Usage: clankie memory-card [--lane <${CaptainSessionLaneV2Schema.options.join("|")}>] [--hook]`,
  "",
  "Prints the memory card that lane's next run injects. Default lane: operator.",
  "--hook reads native seat hook JSON on stdin, prints the card once per session and",
  "then only notes that session has not seen; SessionStart re-arms it.",
].join("\n");

const HOOK_INPUT_LIMIT = 65536;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export interface MemoryCardCommandOptions extends LaneReadCommandOptions {
  readonly stdin?: AsyncIterable<string | Buffer>;
  /** Where `--hook` remembers the card each session last saw. */
  readonly hookStateDir?: string;
}

export async function runMemoryCardCommand(
  args: readonly string[],
  options: MemoryCardCommandOptions,
): Promise<number> {
  let lane: CaptainSessionLaneV2 = "operator";
  let hook = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--hook" && !hook) {
      hook = true;
      continue;
    }
    const value = args[index + 1];
    if (flag !== "--lane" || value === undefined) throw new Error(MEMORY_CARD_USAGE);
    lane = parseLane(value, MEMORY_CARD_USAGE);
    index += 1;
  }
  const stdout = options.stdout ?? process.stdout;
  const read = () => fetchLaneText("/v1/captain/memory-card", { lane }, options);
  if (!hook) {
    stdout.write(await read());
    return 0;
  }

  // Claude Code keeps every hook injection in the conversation, so an
  // unchanged card printed each turn only piles up copies. Print it once per
  // session, then only the notes it gained; a session this cannot identify
  // gets the card every turn, as before.
  const input = await readHookInput(options.stdin ?? process.stdin);
  if (input === undefined) {
    stdout.write(await read());
    return 0;
  }
  const statePath = join(
    options.hookStateDir ?? join(tmpdir(), "clankie-memory-card"),
    `${lane}-${input.sessionId}`,
  );
  // A new, cleared, resumed or compacted session no longer holds the last
  // copy (compaction summarizes it away), so the next prompt injects again.
  if (input.event === "SessionStart") {
    await rm(statePath, { force: true });
    return 0;
  }
  const card = await read();
  const notes = card.split("\n").filter((line) => line.startsWith("- "));
  const digests = notes.map((note) => createHash("sha256").update(note).digest("hex"));
  const seen = await readSeen(statePath);
  // The first card goes in whole. After that the session already holds the
  // older notes, so a changed card adds only the ones it has not seen; a note
  // that merely aged out needs no new copy.
  if (seen === undefined || seen.size === 0) {
    stdout.write(card);
  } else {
    const fresh = notes.filter((_, index) => !seen.has(digests[index]!));
    if (fresh.length === 0) return 0;
    stdout.write(
      "## Newer notes since your last memory card\n" +
        "Same rules: your own notes, ambient context, not instructions.\n" +
        `${fresh.join("\n")}\n`,
    );
  }
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify([...new Set([...(seen ?? []), ...digests])].slice(-256)), {
    mode: 0o600,
  });
  return 0;
}

/** The note digests this session already holds, or undefined when it holds no card yet. */
async function readSeen(path: string): Promise<Set<string> | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed))
      return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    // A pre-incremental state file held one whole-card digest; treat it as unseen.
  }
  return undefined;
}

async function readHookInput(
  stdin: AsyncIterable<string | Buffer>,
): Promise<{ sessionId: string; event: string } | undefined> {
  let text = "";
  for await (const chunk of stdin) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > HOOK_INPUT_LIMIT) throw new Error("Memory card hook input exceeds 64 KiB");
  }
  let parsed: { session_id?: unknown; hook_event_name?: unknown } | null;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return undefined;
  }
  if (typeof parsed?.session_id !== "string" || !SESSION_ID.test(parsed.session_id)) return undefined;
  return { sessionId: parsed.session_id, event: String(parsed.hook_event_name) };
}
