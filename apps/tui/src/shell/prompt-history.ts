/**
 * Prompt history persistence for the face editor: one JSON-encoded prompt per
 * line so multi-line prompts survive round-trips. Best-effort — a missing or
 * corrupt file never blocks the face.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const HISTORY_LIMIT = 200;

export async function readPromptHistory(path: string): Promise<readonly string[]> {
  try {
    const raw = await readFile(path, "utf8");
    const entries: string[] = [];
    for (const line of raw.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "string" && parsed.length > 0) entries.push(parsed);
      } catch {
        // Skip corrupt lines rather than losing the whole history.
      }
    }
    return entries.slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export async function appendPromptHistory(path: string, prompt: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(prompt)}\n`, "utf8");
  } catch {
    // Best-effort: history persistence must never break the face.
  }
}
