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
  "--hook reads native seat hook JSON on stdin and prints the card only when this",
  "session has not seen it yet; SessionStart re-arms it.",
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
  // session and again when it changes; a session this cannot identify gets the
  // card every turn, as before.
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
  const digest = createHash("sha256").update(card).digest("hex");
  const seen = await readFile(statePath, "utf8").catch(() => undefined);
  if (seen === digest) return 0;
  stdout.write(card);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, digest, { mode: 0o600 });
  return 0;
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
