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

/** The scope a hire's retry is recognised by before relocation: machine and start folder. */
export function hireWorktreeScope(input: {
  readonly fleet?: string | undefined;
  readonly workingDirectory: string;
}): string {
  return JSON.stringify([input.fleet ?? "local", input.workingDirectory]);
}

/**
 * Where each start folder's last hire was moved to (ADR 0306). A retry of a launch that is
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

  public record(scope: string, relocation: HireWorktreeRelocation): void {
    const now = Date.now();
    const state = Object.fromEntries(
      Object.entries(this.read()).filter(([, entry]) => now - Date.parse(entry.at) < RETENTION_MS),
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
