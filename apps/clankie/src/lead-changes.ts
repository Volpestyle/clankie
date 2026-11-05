import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  LEAD_CHANGES_PAGE_BYTES,
  LeadChangeAvailabilitySchema,
  LeadChangeEntrySchema,
  LeadChangeRecordSchema,
  LeadChangeSourceSchema,
  type LeadChangeRecord,
  type LeadChangesRead,
  type LeadChangesResult,
  type LeadChangeSource,
} from "@clankie/protocol/lead-changes";

const ITEMS_MAX = 2048;
const HISTORY_MAX = 4096;
const StateSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    secret: z.string().regex(/^[a-f0-9]{64}$/u),
    head: z.number().int().nonnegative(),
    floor: z.number().int().nonnegative(),
    items: z.record(z.string(), LeadChangeRecordSchema),
    history: z.array(LeadChangeEntrySchema).max(HISTORY_MAX),
    sources: z.array(LeadChangeAvailabilitySchema).max(6),
  })
  .strict();
const PositionSchema = z
  .object({
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    bootstrapTo: z.number().int().nonnegative().optional(),
  })
  .strict();
type State = z.infer<typeof StateSchema>;
type Position = z.infer<typeof PositionSchema>;
export interface LeadChangeSnapshot {
  readonly source: LeadChangeSource;
  readonly records: readonly LeadChangeRecord[];
  readonly unavailable?: string;
}
export class LeadChangesRefusal extends Error {
  constructor(public readonly code: "invalid_cursor" | "not_authorized" | "state_unavailable") {
    super(code);
  }
}
export function leadChangeRecord(
  id: string,
  item: LeadChangeRecord["item"],
  state: LeadChangeRecord["state"],
  at: string,
): LeadChangeRecord {
  return LeadChangeRecordSchema.parse({
    id,
    item,
    state,
    at,
    revision: createHash("sha256").update(JSON.stringify({ item, state })).digest("hex"),
  });
}
const keyOf = (record: LeadChangeRecord) => record.item.kind + ":" + record.id;
const missingFile = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Observation checkpoints only: source records, reports and owner decisions are never mutated. */
export class LeadChanges {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}

  async read(input: {
    /** Supplied by authenticated server context, never decoded from client arguments. */
    readonly scope: string;
    readonly request: LeadChangesRead;
    readonly authorize: () => Promise<boolean>;
    /** Complete projections through existing source visibility filters. */
    readonly snapshot: () => Promise<readonly LeadChangeSnapshot[]>;
  }): Promise<LeadChangesResult> {
    const before = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((done) => {
      release = done;
    });
    await before;
    try {
      return await this.readSerial(input);
    } finally {
      release();
    }
  }

  private async readSerial(input: Parameters<LeadChanges["read"]>[0]): Promise<LeadChangesResult> {
    if (!(await input.authorize())) throw new LeadChangesRefusal("not_authorized");
    const path = join(this.directory, createHash("sha256").update(input.scope).digest("hex") + ".json");
    let state: State;
    try {
      state = StateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!missingFile(error)) throw new LeadChangesRefusal("state_unavailable");
      state = {
        version: 1,
        id: randomUUID(),
        secret: randomBytes(32).toString("hex"),
        head: 0,
        floor: 0,
        items: {},
        history: [],
        sources: [],
      };
    }
    const position = input.request.since === undefined ? undefined : this.decode(input.request.since, state);
    if (position && position.sequence < state.floor)
      return { outcome: "reset_required", reason: "retained_history_gap" };
    // Anchor before asynchronous source reads. Checkpoints reflect only observed records,
    // never the later wall clock, so inserts during collection remain visible next time.
    const anchoredAt = new Date().toISOString();
    const snapshots = await input.snapshot();
    if (!(await input.authorize())) throw new LeadChangesRefusal("not_authorized");
    const sources: State["sources"] = [];
    const append = (record: LeadChangeRecord, removed?: true) => {
      state.history.push({ ...record, sequence: ++state.head, ...(removed ? { removed } : {}) });
    };
    for (const source of LeadChangeSourceSchema.options) {
      const snapshot = snapshots.find((value) => value.source === source);
      const unavailable = snapshot?.unavailable ?? (snapshot ? undefined : "source_unavailable");
      const records = snapshot?.records ?? [];
      const currentKeys = Object.keys(state.items).filter((key) => state.items[key]!.item.kind === source);
      const otherCount = Object.keys(state.items).length - currentKeys.length;
      const reason = unavailable ?? (otherCount + records.length > ITEMS_MAX ? "source_limit" : undefined);
      const previous = state.sources.find((value) => value.source === source);
      if (reason !== undefined) {
        sources.push({ source, status: "unavailable", reason: reason.slice(0, 256) });
        if (previous?.status !== "unavailable")
          for (const key of currentKeys) {
            const record = state.items[key]!;
            append(leadChangeRecord(record.id, record.item, "unknown", anchoredAt));
          }
        continue;
      }
      sources.push({ source, status: "ready" });
      const found = new Set<string>();
      for (const raw of records) {
        const record = LeadChangeRecordSchema.parse(raw);
        if (record.item.kind !== source) throw new LeadChangesRefusal("state_unavailable");
        const key = keyOf(record);
        if (found.has(key)) throw new LeadChangesRefusal("state_unavailable");
        found.add(key);
        if (state.items[key]?.revision !== record.revision || previous?.status === "unavailable") {
          state.items[key] = record;
          append(record);
        }
      }
      for (const key of currentKeys)
        if (!found.has(key)) {
          const record = state.items[key]!;
          append(leadChangeRecord(record.id, record.item, "superseded", anchoredAt), true);
          delete state.items[key];
        }
    }
    state.sources = sources;
    let from = position?.sequence ?? state.head;
    let bootstrapTo = position?.bootstrapTo;
    if (!position) {
      // A bootstrap is a frozen sequence range, not a moving first page.
      from = state.head;
      for (const record of Object.values(state.items)) {
        const ready = sources.find((value) => value.source === record.item.kind)?.status === "ready";
        append(ready ? record : leadChangeRecord(record.id, record.item, "unknown", anchoredAt));
      }
      bootstrapTo = state.head;
    }
    const through = bootstrapTo ?? state.head;
    const latest = new Map(state.history.map((entry) => [keyOf(entry), entry]));
    const entries: z.infer<typeof LeadChangeEntrySchema>[] = [];
    let sequence = from;
    for (const change of state.history) {
      if (change.sequence <= from || change.sequence > through) continue;
      // Coalesce stale queued observations to current facts, including resolution.
      const current = latest.get(keyOf(change))!;
      const candidate = { ...current, sequence: change.sequence };
      if (
        entries.length >= (input.request.limit ?? 50) ||
        Buffer.byteLength(JSON.stringify([...entries, candidate])) > LEAD_CHANGES_PAGE_BYTES - 4096
      )
        break;
      entries.push(candidate);
      sequence = change.sequence;
    }
    const more = sequence < through;
    const next = this.encode(
      { id: state.id, sequence, ...(more && bootstrapTo !== undefined ? { bootstrapTo } : {}) },
      state,
    );
    if (state.history.length > HISTORY_MAX) {
      const removed = state.history.splice(0, state.history.length - HISTORY_MAX);
      state.floor = removed.at(-1)!.sequence;
    }
    if (!(await input.authorize())) throw new LeadChangesRefusal("not_authorized");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    if (!(await input.authorize())) throw new LeadChangesRefusal("not_authorized");
    await rename(temporary, path);
    return { outcome: "ready", bootstrap: bootstrapTo !== undefined, entries, next, more, sources };
  }

  private encode(position: Position, state: State): string {
    const body = Buffer.from(JSON.stringify(position)).toString("base64url");
    return body + "." + createHmac("sha256", state.secret).update(body).digest("hex");
  }
  private decode(token: string, state: State): Position {
    try {
      const [body, signature, extra] = token.split(".");
      if (!body || !signature || extra !== undefined) throw new Error("shape");
      const mac = createHmac("sha256", state.secret).update(body).digest("hex");
      if (signature.length !== mac.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(mac)))
        throw new Error("signature");
      const position = PositionSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
      if (
        position.id !== state.id ||
        position.sequence > state.head ||
        (position.bootstrapTo !== undefined && position.bootstrapTo > state.head)
      )
        throw new Error("range");
      return position;
    } catch {
      throw new LeadChangesRefusal("invalid_cursor");
    }
  }
}
