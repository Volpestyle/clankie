import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const RelocationSchema = z.object({
  workingDirectory: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  start: z.string().min(1),
  startReason: z.string(),
  remoteMain: z.string().min(1),
  at: z.string(),
});
export type HireWorktreeRelocation = z.infer<typeof RelocationSchema>;
const StateSchema = z.record(z.string(), RelocationSchema);
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The start folder a hire queues in before relocation: machine and start folder. */
export function hireWorktreeScope(input: {
  readonly fleet?: string | undefined;
  readonly workingDirectory: string;
}): string {
  return JSON.stringify([input.fleet ?? "local", input.workingDirectory]);
}

/**
 * The launch a relocation belongs to: its start folder, harness and the caller's brief (#614).
 * Only a retry of that same launch finds it; new work from the folder gets its own worktree.
 * Entries recorded before this carry the start folder alone (`hireWorktreeScope`).
 */
export function hireRetryScope(
  input: {
    readonly fleet?: string | undefined;
    readonly workingDirectory: string;
    readonly harness?: string | undefined;
  },
  briefSha256: string,
): string {
  return JSON.stringify([input.fleet ?? "local", input.workingDirectory, input.harness ?? "", briefSha256]);
}

/**
 * Where each launch from a start folder was moved to (ADR 0306). A retry of a launch that is
 * still unresolved must reuse that worktree, so its allocation and receipt keys match the
 * first attempt and the retry inspects it instead of starting a second agent (ADR 0207).
 */
export class HireWorktrees {
  private readonly path: string;
  public constructor(path: string) {
    this.path = path;
  }

  public get(scope: string): HireWorktreeRelocation | undefined {
    return this.read()[scope];
  }

  /** Exact controller-created relocation; ambiguity or reused launch paths cannot prove a close. */
  public closeRelocation(claim: { workingDirectory: string; harness?: string | undefined; hiredAt: string }) {
    const matches = () =>
      Object.entries(this.read()).filter(([scope, entry]) => {
        const key = JSON.parse(scope) as unknown[];
        return (
          key.length === 4 &&
          key[0] === "local" &&
          key[1] === entry.start &&
          key[2] === claim.harness &&
          entry.path === claim.workingDirectory &&
          entry.workingDirectory === claim.workingDirectory &&
          Number.isFinite(Date.parse(entry.at)) &&
          Date.parse(entry.at) <= Date.parse(claim.hiredAt)
        );
      });
    const all = matches();
    if (all.length !== 1) return undefined;
    const [key, entry] = all[0]!;
    const saved = JSON.stringify(entry);
    return {
      entry: structuredClone(entry),
      validate: () => {
        const latest = matches();
        if (latest.length !== 1 || latest[0]![0] !== key || JSON.stringify(latest[0]![1]) !== saved)
          throw new Error("Original worktree relocation changed");
      },
    };
  }

  /** Initial main SHA for this exact relocated worktree, on its own machine. */
  public baseFor(fleet: string | undefined, path: string): string | undefined {
    return Object.entries(this.read()).find(
      ([scope, entry]) =>
        (JSON.parse(scope) as [string, string])[0] === (fleet ?? "local") && entry.path === path,
    )?.[1].remoteMain;
  }

  /**
   * Records a relocation. An older entry is dropped only once it is past retention and `retained`
   * says its launch no longer needs it, so a fenced launch always keeps its way back.
   */
  public record(
    scope: string,
    relocation: HireWorktreeRelocation,
    retained: (fleet: string | undefined, entry: HireWorktreeRelocation) => boolean,
  ): void {
    const now = Date.now();
    const state = Object.fromEntries(
      Object.entries(this.read()).filter(([key, entry]) => {
        if (now - Date.parse(entry.at) < RETENTION_MS) return true;
        const fleet = (JSON.parse(key) as [string, string])[0];
        return retained(fleet === "local" ? undefined : fleet, entry);
      }),
    );
    state[scope] = relocation;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(StateSchema.parse(state))}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
  }

  private read(): z.infer<typeof StateSchema> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    // An unreadable ledger cannot prove a retry is new, so the hire stops rather than guess.
    return StateSchema.parse(JSON.parse(raw));
  }
}
