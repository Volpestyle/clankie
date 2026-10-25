import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const PaneKeepSchema = z
  .object({
    /** The tidy session key: fleet, harness and native session, so a new session in the pane is not kept. */
    sessionKey: z.string().min(1).max(1024),
    paneId: z.string().min(1).max(256),
    title: z.string().max(512),
    reason: z.string().min(1).max(512),
    /** The conversation that asked to keep it. */
    by: z.string().min(1).max(256),
    at: z.string().datetime(),
  })
  .strict();
export type PaneKeep = z.infer<typeof PaneKeepSchema>;
const StateSchema = z.object({ version: z.literal(1), keeps: z.array(PaneKeepSchema) }).strict();
const KEEP = 512;

/**
 * Worker panes the owner or a lead chose to keep open (VUH-2392). Automatic tidy never
 * closes a kept session; a lead's own close_worker_pane still can.
 */
export class PaneKeeps {
  private state: z.infer<typeof StateSchema>;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.state = existsSync(path)
      ? StateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { version: 1, keeps: [] };
  }
  keep(input: Omit<PaneKeep, "at">): PaneKeep {
    const keep = PaneKeepSchema.parse({ ...input, at: new Date().toISOString() });
    this.save([...this.state.keeps.filter((item) => item.sessionKey !== keep.sessionKey), keep].slice(-KEEP));
    return keep;
  }
  release(sessionKey: string): boolean {
    const keeps = this.state.keeps.filter((item) => item.sessionKey !== sessionKey);
    if (keeps.length === this.state.keeps.length) return false;
    this.save(keeps);
    return true;
  }
  /** Release every keep the predicate selects, in one write; returns what it released. */
  releaseWhere(selected: (keep: PaneKeep) => boolean): PaneKeep[] {
    const released = this.state.keeps.filter(selected);
    if (released.length > 0) this.save(this.state.keeps.filter((item) => !released.includes(item)));
    return released;
  }
  kept(sessionKey: string): PaneKeep | undefined {
    return this.state.keeps.find((item) => item.sessionKey === sessionKey);
  }
  list(): readonly PaneKeep[] {
    return this.state.keeps;
  }
  private save(keeps: PaneKeep[]): void {
    const next = { version: 1 as const, keeps };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(StateSchema.parse(next)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    this.state = next;
  }
}
