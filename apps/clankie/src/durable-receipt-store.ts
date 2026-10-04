import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

interface DurableReceipt {
  id: string;
  createdAt: number;
  state: "uncertain" | "settled";
  result?: unknown;
}

const SETTLED_BODY_LIMIT = 1_000;

/** Flat receipt journals retain admission tombstones and never dispatch or retry work. */
export class DurableReceiptStore<Record extends DurableReceipt> {
  private records = new Map<string, Record>();
  private readonly path: string | undefined;
  private readonly schema: z.ZodType<Record[]>;
  private readonly unreadableMessage: string;

  public constructor(options: { path?: string; schema: z.ZodType<Record>; unreadableMessage: string }) {
    this.path = options.path;
    this.schema = z.array(options.schema);
    this.unreadableMessage = options.unreadableMessage;
  }

  /** Reload at each synchronous journal operation, including after a service restart. */
  public load(): Map<string, Record> {
    if (this.path === undefined) return this.records;
    try {
      const records = this.schema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      this.records = new Map(records.map((record) => [record.id, record]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(this.unreadableMessage, { cause: error });
      this.records.clear();
    }
    return this.records;
  }

  public save(): void {
    // Keep identity tombstones and every uncertain record; bound only settled result bodies.
    const settled = [...this.records.values()]
      .filter((record) => record.state === "settled" && record.result !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const record of settled.slice(SETTLED_BODY_LIMIT)) delete record.result;
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...this.records.values()])}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
