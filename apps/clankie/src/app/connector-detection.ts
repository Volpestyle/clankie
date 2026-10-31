import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConnectorMultiplexerIdSchema } from "@clankie/protocol/connector";
import { z } from "zod";

/** Adapters this service discovers. Herdr is the first; another mux is another id. */
const KNOWN_MULTIPLEXERS = ["herdr"] as const;

export type ConnectorMultiplexer = (typeof KNOWN_MULTIPLEXERS)[number];

const PersistedSchema = z
  .object({
    schemaVersion: z.literal(1),
    /**
     * Adapter id to enabled. A record, so a later adapter's key still parses.
     * Absent `herdr` means on (ADR 0308).
     */
    multiplexers: z.record(z.string(), z.boolean()),
    /** Device ids the owner turned off. Absent means served (ADR 0308). */
    unserved: z.array(z.string().min(1).max(256)).max(256),
  })
  .strict();

/**
 * Which multiplexers the connector discovers, and which connected apps it
 * serves (ADR 0308). Herdr detection is on and every app is served until the
 * owner says otherwise, including when the file is missing or unreadable, so
 * a bad file does not hide the fleet. Without a path (tests) the switches
 * live in memory. Mode 0600, same as the other connector owner files.
 */
export class ConnectorDetection {
  /** Known adapters plus any well-formed id already in the file. */
  private readonly flags = new Map<string, boolean>();
  private readonly unserved: Set<string>;
  private readonly path: string | undefined;

  public constructor(path?: string) {
    this.path = path;
    const saved = this.read();
    for (const [id, enabled] of Object.entries(saved?.multiplexers ?? {})) {
      if (ConnectorMultiplexerIdSchema.safeParse(id).success) this.flags.set(id, enabled);
    }
    this.unserved = new Set(saved?.unserved ?? []);
  }

  public multiplexer(id: ConnectorMultiplexer): boolean {
    return this.flags.get(id) ?? id === "herdr";
  }

  /** False when this service does not know the adapter. */
  public setMultiplexer(id: string, enabled: boolean): boolean {
    if (!this.known(id)) return false;
    this.flags.set(id, enabled);
    this.save();
    return true;
  }

  /** The adapters this service knows, in a stable order. */
  public multiplexers(): { id: ConnectorMultiplexer; enabled: boolean }[] {
    return KNOWN_MULTIPLEXERS.map((id) => ({ id, enabled: this.multiplexer(id) }));
  }

  public served(deviceId: string): boolean {
    return !this.unserved.has(deviceId);
  }

  public setServed(deviceId: string, served: boolean): void {
    if (served) this.unserved.delete(deviceId);
    else this.unserved.add(deviceId);
    this.save();
  }

  private known(id: string): id is ConnectorMultiplexer {
    return (KNOWN_MULTIPLEXERS as readonly string[]).includes(id);
  }

  private save(): void {
    if (this.path === undefined) return;
    const multiplexers: Record<string, boolean> = {};
    for (const id of KNOWN_MULTIPLEXERS) {
      const enabled = this.flags.get(id);
      if (enabled !== undefined) multiplexers[id] = enabled;
    }
    for (const [id, enabled] of this.flags) {
      if (!this.known(id)) multiplexers[id] = enabled;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, multiplexers, unserved: [...this.unserved] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.path);
  }

  private read(): z.infer<typeof PersistedSchema> | undefined {
    if (this.path === undefined || !existsSync(this.path)) return undefined;
    try {
      return PersistedSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return undefined;
    }
  }
}
