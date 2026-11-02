import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { OperatorSeatWorkedOnSchema, type OperatorSeatWorkedOn } from "@clankie/protocol";

/** Entries kept per persona, newest first; older work ages out. */
const KEEP = 20;
const PULL_REQUEST = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gu;

const HistorySchema = z.record(z.string().min(1).max(256), z.array(OperatorSeatWorkedOnSchema).max(KEEP));

/**
 * What each persona has worked on (#425): the issue it held, the branch it worked on,
 * the areas its commits touched and the pull requests its done reports named. A lead
 * reads it to route new work to a worker that already knows the area; it records
 * evidence only and decides nothing. Kept in hub state so it survives seats and restarts.
 */
export class PersonaWorkHistory {
  private history: z.infer<typeof HistorySchema> = {};
  private saved = "";

  private readonly path: string;
  private readonly now: () => number;

  public constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
    if (existsSync(path)) {
      try {
        this.history = HistorySchema.parse(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        /* Unreadable history is advisory evidence; it never blocks startup. */
      }
    }
    this.saved = JSON.stringify(this.history);
  }

  /** Newest first. */
  public read(personaId: string): readonly OperatorSeatWorkedOn[] {
    return Object.hasOwn(this.history, personaId) ? this.history[personaId]! : [];
  }

  /**
   * The seat's current work, as the fleet projection sees it. A new issue or branch starts
   * a new entry; the same one refreshes its areas and time.
   */
  public observe(
    personaId: string,
    work: {
      readonly issue?: string;
      readonly branch?: string;
      readonly areas?: readonly string[] | undefined;
    },
  ): void {
    if (work.issue === undefined && work.branch === undefined) return;
    const entries = [...this.read(personaId)];
    const current = entries[0];
    const same =
      current !== undefined &&
      (work.issue === undefined || current.issue === undefined || current.issue === work.issue) &&
      (work.branch === undefined || current.branch === undefined || current.branch === work.branch);
    const { at: _at, ...before } = same ? current : { at: "" };
    const after = {
      ...before,
      ...(work.issue === undefined ? {} : { issue: work.issue }),
      ...(work.branch === undefined ? {} : { branch: work.branch }),
      ...(work.areas === undefined || work.areas.length === 0 ? {} : { areas: work.areas.slice(0, 8) }),
    };
    // Unchanged work keeps its time, so a fleet read writes nothing.
    if (same && JSON.stringify(after) === JSON.stringify(before)) return;
    const next = OperatorSeatWorkedOnSchema.parse({ ...after, at: new Date(this.now()).toISOString() });
    this.put(personaId, same ? [next, ...entries.slice(1)] : [next, ...entries]);
  }

  /** A done report: the pull requests it names join the persona's current entry. */
  public noteDone(personaId: string, text: string): void {
    const found = [...new Set(text.match(PULL_REQUEST) ?? [])];
    if (found.length === 0) return;
    const entries = [...this.read(personaId)];
    const current = entries[0] ?? { at: new Date(this.now()).toISOString() };
    const pullRequests = [...new Set([...(current.pullRequests ?? []), ...found])].slice(-8);
    this.put(personaId, [
      OperatorSeatWorkedOnSchema.parse({ ...current, pullRequests }),
      ...entries.slice(1),
    ]);
  }

  private put(personaId: string, entries: OperatorSeatWorkedOn[]): void {
    this.history[personaId] = entries.slice(0, KEEP);
    const text = JSON.stringify(this.history);
    if (text === this.saved) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, text, { mode: 0o600 });
      renameSync(`${this.path}.tmp`, this.path);
      this.saved = text;
    } catch {
      /* The next observation retries; routing evidence never fails a fleet read. */
    }
  }
}
