import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// An open draft pull request that closes an issue holds it (#318), but nothing fires when
// one closes: holds are derived as issues are read. So each read notes the draft holds it
// saw, and a later round looks at those pull requests again. One that closed unmerged
// while the tracker still says In Progress puts its issue back in the queue (#541).

/** Pull requests remembered at once; the oldest noted fall out first. */
const KEPT = 500;

const HoldSchema = z.strictObject({
  /** The repo as the read named it, so the write goes where the read came from. */
  repo: z.string().min(1),
  local: z.boolean(),
  /** The item's id in its tracker. */
  id: z.string().min(1),
});
const PullSchema = z.strictObject({
  url: z.string().min(1),
  slug: z.string().min(1),
  number: z.number().int().positive(),
  notedAt: z.string(),
  holds: z.array(HoldSchema),
});
const LedgerSchema = z.strictObject({ schemaVersion: z.literal(1), pulls: z.array(PullSchema) });

export type DraftPullHold = z.infer<typeof HoldSchema>;
export type DraftPull = z.infer<typeof PullSchema>;

/** `https://github.com/owner/repo/pull/12`, lowercased owner/repo and its number. */
export function githubPullOf(url: string): { slug: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/iu.exec(url.trim());
  return match ? { slug: match[1]!.toLowerCase(), number: Number(match[2]) } : undefined;
}

/** The draft holds the service has seen, kept across restarts. */
export class DraftPullHolds {
  private readonly pulls = new Map<string, DraftPull>();
  private readonly path: string;
  private readonly clock: () => Date;

  constructor(path: string, clock: () => Date = () => new Date()) {
    this.path = path;
    this.clock = clock;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    // An unreadable ledger only forgets which closes to watch for; reads note them again.
    const parsed = LedgerSchema.safeParse(json);
    if (parsed.success) for (const pull of parsed.data.pulls) this.pulls.set(pull.url, pull);
  }

  /** Notes that this draft pull request holds this item; saves only when it is new. */
  note(url: string, hold: DraftPullHold): void {
    const pull = githubPullOf(url);
    if (pull === undefined) return;
    const existing = this.pulls.get(url);
    if (existing?.holds.some((entry) => entry.repo === hold.repo && entry.id === hold.id)) return;
    this.pulls.delete(url);
    this.pulls.set(url, {
      url,
      ...pull,
      notedAt: this.clock().toISOString(),
      holds: [...(existing?.holds ?? []), hold],
    });
    for (const old of this.pulls.keys()) {
      if (this.pulls.size <= KEPT) break;
      this.pulls.delete(old);
    }
    this.save();
  }

  list(): DraftPull[] {
    return [...this.pulls.values()];
  }

  /** Forgets a pull request, or only the holds it no longer needs watching. */
  settle(url: string, remaining: readonly DraftPullHold[] = []): void {
    const pull = this.pulls.get(url);
    if (pull === undefined) return;
    if (remaining.length === 0) this.pulls.delete(url);
    else this.pulls.set(url, { ...pull, holds: [...remaining] });
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, pulls: [...this.pulls.values()] })}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
  }
}
