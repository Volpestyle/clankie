import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  ApprovedMemoryProposalSchema,
  MemoryCategorySchema,
  MemoryFactSchema,
  type ApprovedMemoryProposal,
  type MemoryCategory,
  type MemoryDoctrine,
  type MemoryFact,
} from "./schema.ts";

export * from "./schema.ts";

export const DEFAULT_CATEGORY_CAP = 64;
export const DEFAULT_RECALL_MAX_FACTS = 12;
export const DEFAULT_RECALL_MAX_CHARACTERS = 4_096;

export interface MemoryStoreOptions {
  readonly doctrine: MemoryDoctrine;
  readonly categoryCaps?: Partial<Readonly<Record<MemoryCategory, number>>>;
}

export interface RecallCardOptions {
  readonly query: string;
  readonly categories?: readonly MemoryCategory[];
  readonly maxFacts?: number;
  readonly maxCharacters?: number;
}

export interface ApplyProposalResult {
  readonly fact: MemoryFact;
  readonly merged: boolean;
  readonly evictedFactIds: readonly string[];
}

interface FactRow {
  fact_id: string;
  category: string;
  body: string;
  mission_id: string;
  correlation_id: string;
  source_event_id: string;
  source_kind: string;
  public_source: number;
  confidence: number;
  created_at: string;
  updated_at: string;
}

const MIGRATION = `
CREATE TABLE memory_facts (
  fact_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  body TEXT NOT NULL,
  normalized_body TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  public_source INTEGER NOT NULL CHECK (public_source IN (0, 1)),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (category, normalized_body)
) STRICT;
CREATE INDEX memory_facts_eviction ON memory_facts (category, confidence, updated_at, fact_id);
CREATE TABLE applied_memory_proposals (
  proposal_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE memory_facts_fts USING fts5(body, content='memory_facts', content_rowid='rowid');
CREATE TRIGGER memory_facts_ai AFTER INSERT ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER memory_facts_ad AFTER DELETE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER memory_facts_au AFTER UPDATE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO memory_facts_fts(rowid, body) VALUES (new.rowid, new.body);
END;`;

export class MemoryStore {
  private readonly database: DatabaseSync;
  private readonly doctrine: MemoryDoctrine;
  private readonly caps: Readonly<Record<MemoryCategory, number>>;

  public constructor(path: string, options: MemoryStoreOptions) {
    validateDoctrine(options.doctrine);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.doctrine = options.doctrine;
    this.caps = Object.fromEntries(
      MemoryCategorySchema.options.map((category) => {
        const cap = options.categoryCaps?.[category] ?? DEFAULT_CATEGORY_CAP;
        if (!Number.isSafeInteger(cap) || cap < 1) throw new Error(`Invalid cap for ${category}`);
        return [category, cap];
      }),
    ) as Record<MemoryCategory, number>;
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
    this.migrate();
  }

  /** The sole mutation entry point. Unapproved proposal shapes fail schema validation. */
  public applyApprovedProposal(input: unknown): ApplyProposalResult {
    const proposal = ApprovedMemoryProposalSchema.parse(input);
    if (proposal.fact.provenance.publicSource && !this.doctrine.publicToPrivatePropagation) {
      throw new Error("Doctrine rejects propagation from a public source into private memory");
    }
    const payload = JSON.stringify(proposal);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.database
        .prepare("SELECT payload FROM applied_memory_proposals WHERE proposal_id = ?")
        .get(proposal.proposalId) as { payload: string } | undefined;
      if (prior !== undefined) {
        if (prior.payload !== payload) throw new Error("Proposal id was reused with different content");
        this.database.exec("COMMIT");
        const fact = this.findByIdentity(proposal.fact.category, normalize(proposal.fact.body));
        if (fact === undefined) throw new Error("Applied proposal references an evicted fact");
        return { fact, merged: fact.factId !== proposal.fact.factId, evictedFactIds: [] };
      }

      const normalized = normalize(proposal.fact.body);
      const existing = this.findByIdentity(proposal.fact.category, normalized);
      const merged = existing !== undefined;
      const fact = existing === undefined ? proposal.fact : mergeFact(existing, proposal.fact);
      if (existing === undefined) this.insertFact(fact, normalized);
      else this.updateFact(fact, normalized, existing.factId);
      this.database
        .prepare("INSERT INTO applied_memory_proposals (proposal_id, approval_id, payload) VALUES (?, ?, ?)")
        .run(proposal.proposalId, proposal.approval.approvalId, payload);
      const evictedFactIds = this.enforceCap(fact.category);
      this.database.exec("COMMIT");
      return { fact, merged, evictedFactIds };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public pruneRetention(now = new Date()): readonly string[] {
    const cutoff = new Date(
      now.getTime() - this.doctrine.rawTranscriptRetentionDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const rows = this.database
      .prepare(
        "SELECT fact_id FROM memory_facts WHERE source_kind = 'raw-transcript' AND updated_at < ? ORDER BY fact_id",
      )
      .all(cutoff) as unknown as Array<{ fact_id: string }>;
    this.database
      .prepare("DELETE FROM memory_facts WHERE source_kind = 'raw-transcript' AND updated_at < ?")
      .run(cutoff);
    return rows.map((row) => row.fact_id);
  }

  public list(category?: MemoryCategory): readonly MemoryFact[] {
    const rows = (category === undefined
      ? this.database.prepare("SELECT * FROM memory_facts ORDER BY category, updated_at DESC, fact_id").all()
      : this.database
          .prepare("SELECT * FROM memory_facts WHERE category = ? ORDER BY updated_at DESC, fact_id")
          .all(MemoryCategorySchema.parse(category))) as unknown as FactRow[];
    return rows.map(rowToFact);
  }

  public recallCard(options: RecallCardOptions): string {
    const maxFacts = boundedInteger(options.maxFacts ?? DEFAULT_RECALL_MAX_FACTS, 1, 64, "maxFacts");
    const maxCharacters = boundedInteger(
      options.maxCharacters ?? DEFAULT_RECALL_MAX_CHARACTERS,
      128,
      32_768,
      "maxCharacters",
    );
    const query = options.query.trim();
    if (query.length === 0) return "Memory recall: no query supplied.";
    const categories = (options.categories ?? MemoryCategorySchema.options).map((value) =>
      MemoryCategorySchema.parse(value),
    );
    if (categories.length === 0) return "Memory recall: no matching facts.";
    const placeholders = categories.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT memory_facts.*, bm25(memory_facts_fts) AS rank
         FROM memory_facts_fts JOIN memory_facts ON memory_facts.rowid = memory_facts_fts.rowid
         WHERE memory_facts_fts MATCH ? AND category IN (${placeholders})
         ORDER BY rank ASC, confidence DESC, updated_at DESC, fact_id ASC LIMIT ?`,
      )
      .all(toFtsQuery(query), ...categories, maxFacts) as unknown as FactRow[];
    if (rows.length === 0) return "Memory recall: no matching facts.";
    const lines = ["## Memory recall"];
    for (const fact of rows.map(rowToFact)) {
      const line = `- **${fact.category}** (${fact.confidence.toFixed(2)}): ${fact.body}`;
      if ([...lines, line].join("\n").length > maxCharacters) break;
      lines.push(line);
    }
    return lines.length === 1 ? "Memory recall: no facts fit the projection bound." : lines.join("\n");
  }

  public close(): void {
    this.database.close();
  }

  private migrate(): void {
    const version = (this.database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (version > 1) throw new Error(`Memory store schema version ${String(version)} is unsupported`);
    if (version === 0) {
      this.database.exec(`BEGIN IMMEDIATE; ${MIGRATION} PRAGMA user_version = 1; COMMIT;`);
    }
  }

  private findByIdentity(category: MemoryCategory, normalizedBody: string): MemoryFact | undefined {
    const row = this.database
      .prepare("SELECT * FROM memory_facts WHERE category = ? AND normalized_body = ?")
      .get(category, normalizedBody) as unknown as FactRow | undefined;
    return row === undefined ? undefined : rowToFact(row);
  }

  private insertFact(fact: MemoryFact, normalizedBody: string): void {
    this.database
      .prepare(`INSERT INTO memory_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...factValues(fact, normalizedBody));
  }

  private updateFact(fact: MemoryFact, normalizedBody: string, oldFactId: string): void {
    this.database
      .prepare(`UPDATE memory_facts SET fact_id=?, category=?, body=?, normalized_body=?, mission_id=?,
        correlation_id=?, source_event_id=?, source_kind=?, public_source=?, confidence=?, created_at=?, updated_at=?
        WHERE fact_id=?`)
      .run(...factValues(fact, normalizedBody), oldFactId);
  }

  private enforceCap(category: MemoryCategory): string[] {
    const count = (
      this.database
        .prepare("SELECT COUNT(*) AS count FROM memory_facts WHERE category = ?")
        .get(category) as {
        count: number;
      }
    ).count;
    const overflow = Math.max(0, count - this.caps[category]);
    const rows = this.database
      .prepare(`SELECT fact_id FROM memory_facts WHERE category = ?
        ORDER BY confidence ASC, updated_at ASC, fact_id ASC LIMIT ?`)
      .all(category, overflow) as unknown as Array<{ fact_id: string }>;
    const ids = rows.map((row) => row.fact_id);
    for (const id of ids) this.database.prepare("DELETE FROM memory_facts WHERE fact_id = ?").run(id);
    return ids;
  }
}

function mergeFact(existing: MemoryFact, incoming: MemoryFact): MemoryFact {
  const newer = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  return MemoryFactSchema.parse({
    ...newer,
    factId: existing.factId,
    confidence: Math.max(existing.confidence, incoming.confidence),
    createdAt: existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt,
    updatedAt: existing.updatedAt > incoming.updatedAt ? existing.updatedAt : incoming.updatedAt,
  });
}

function factValues(fact: MemoryFact, normalizedBody: string): readonly SQLInputValue[] {
  return [
    fact.factId,
    fact.category,
    fact.body,
    normalizedBody,
    fact.provenance.missionId,
    fact.provenance.correlationId,
    fact.provenance.sourceEventId,
    fact.provenance.sourceKind,
    fact.provenance.publicSource ? 1 : 0,
    fact.confidence,
    fact.createdAt,
    fact.updatedAt,
  ];
}

function rowToFact(row: FactRow): MemoryFact {
  return MemoryFactSchema.parse({
    schemaVersion: 1,
    factId: row.fact_id,
    category: row.category,
    body: row.body,
    provenance: {
      missionId: row.mission_id,
      correlationId: row.correlation_id,
      sourceEventId: row.source_event_id,
      sourceKind: row.source_kind,
      publicSource: row.public_source === 1,
    },
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function normalize(body: string): string {
  return body.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens.length === 0
    ? '"__no_match__"'
    : tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function validateDoctrine(doctrine: MemoryDoctrine): void {
  if (!Number.isSafeInteger(doctrine.rawTranscriptRetentionDays) || doctrine.rawTranscriptRetentionDays < 0) {
    throw new Error("rawTranscriptRetentionDays must be a non-negative integer");
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} is out of bounds`);
  return value;
}

export type { ApprovedMemoryProposal };
