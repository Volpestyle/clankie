import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPTAIN_LANE_ENTRIES_MAX,
  CAPTAIN_LANE_TEXT_MAX,
  CaptainLaneObservationEntrySchema,
  CaptainSessionLaneV2Schema,
  type ObservableCaptainLane,
} from "@clankie/protocol";
import type { LaneObservation, LaneObservationEntry } from "./port.ts";

/**
 * One JSONL file per lane recording what he heard and what he said there.
 * This is what makes him one person across rooms: `observe_room` and the TUI
 * lanes view both read it. Entries are bounded on read, never rewritten.
 */
export class LaneLog {
  private readonly dir: string;

  public constructor(dir: string) {
    this.dir = dir;
  }

  public async append(lane: string, targetId: string, entry: LaneObservationEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const line = `${JSON.stringify({ ...entry, targetId })}\n`;
    await appendFile(join(this.dir, `${laneKey(lane, targetId)}.jsonl`), line, "utf8");
  }

  public async read(lane: string, targetId: string, limit = 40): Promise<LaneObservation> {
    const entries = await this.readEntries(laneKey(lane, targetId), limit);
    return { lane, targetId, entries };
  }

  public async list(limit = 20): Promise<readonly ObservableCaptainLane[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const lanes: ObservableCaptainLane[] = [];
    for (const file of files.filter((name) => name.endsWith(".jsonl")).sort()) {
      const key = file.slice(0, -".jsonl".length);
      const separator = key.indexOf("~");
      const parsedLane = CaptainSessionLaneV2Schema.safeParse(
        separator === -1 ? key : key.slice(0, separator),
      );
      if (!parsedLane.success) continue;
      const targetId = separator === -1 ? "" : decodeURIComponent(key.slice(separator + 1));
      if (targetId.length === 0 || targetId.length > 512) continue;
      lanes.push({ lane: parsedLane.data, targetId, entries: await this.readEntries(key, limit) });
    }
    return lanes;
  }

  private async readEntries(key: string, limit: number): Promise<LaneObservationEntry[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, `${key}.jsonl`), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-Math.min(limit, CAPTAIN_LANE_ENTRIES_MAX))
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as LaneObservationEntry & { targetId?: string };
          const entry = CaptainLaneObservationEntrySchema.safeParse({
            at: parsed.at,
            kind: parsed.kind,
            text: typeof parsed.text === "string" ? parsed.text.slice(0, CAPTAIN_LANE_TEXT_MAX) : parsed.text,
          });
          return entry.success ? [entry.data] : [];
        } catch {
          return [];
        }
      });
  }
}

/**
 * One filesystem name per room. The lane log spends it on `<key>.jsonl`; the
 * one-shot turn trail spends it on a directory of pi trees, so the two trails
 * for a room sort next to each other under the same name.
 */
export function laneKey(lane: string, targetId: string): string {
  return `${lane}~${encodeURIComponent(targetId)}`;
}
