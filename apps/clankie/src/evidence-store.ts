import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { chmod, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  EVIDENCE_RECENT_PATH,
  EVIDENCE_PREVIEW_PATH,
  EVIDENCE_PREVIEW_MAX_BYTES,
  EvidenceRecentQuerySchema,
  type EvidenceRecentQuery,
  type EvidenceRecentResponse,
  EVIDENCE_FETCH_PATH,
  EVIDENCE_RECEIPTS_PATH,
  EVIDENCE_RECORDS_PATH,
  EVIDENCE_ROOT_PATH,
  EVIDENCE_SIGNED_URL_MAX_MS,
  EVIDENCE_STATUS_PATH,
  EVIDENCE_UPLOADS_PATH,
  EvidenceFetchRequestSchema,
  EvidenceSha256Schema,
  EvidenceUploadRequestSchema,
  evidenceLink,
  type EvidenceActor,
  type EvidenceFetchResponse,
  type EvidenceReceipt,
  type EvidenceRecord,
  type EvidenceStoreStatus,
  type EvidenceUploadRequest,
} from "@clankie/protocol/evidence";

/**
 * The evidence store (ADR 0258): content-addressed, immutable blobs plus the
 * records that describe them. Blob and metadata storage sit behind the two
 * interfaces below so the hosted S3/R2 and Postgres backends (VUH-1913) slot in
 * without changing the API. Nothing here deletes a blob.
 */
export interface EvidenceBlobStore {
  readonly backend: string;
  readonly location: string;
  has(sha256: string): Promise<boolean>;
  /** Accepts the bytes only when both their sha256 and size match; otherwise stores nothing. */
  write(
    sha256: string,
    size: number,
    body: AsyncIterable<Uint8Array>,
  ): Promise<{ ok: true } | { ok: false; reason: "sha256_mismatch" | "size_mismatch" }>;
  open(sha256: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | undefined>;
}

export interface EvidenceUploadRow {
  readonly actorKey: string;
  readonly idempotencyKey: string;
  readonly request: EvidenceUploadRequest;
  readonly actor: EvidenceActor;
  state: "pending" | "applied" | "refused";
  recordId?: string | undefined;
  refusal?: "sha256_mismatch" | "size_mismatch" | undefined;
}

export interface EvidenceMetadataStore {
  readonly backend: string;
  readonly location: string;
  /** Inserts unless the key exists; always answers with the stored row. */
  claimUpload(row: EvidenceUploadRow): Promise<EvidenceUploadRow>;
  findUpload(actorKey: string, idempotencyKey: string): Promise<EvidenceUploadRow | undefined>;
  /** Moves a pending upload to applied with its record, or to refused; never changes a settled one. */
  settleUpload(
    row: EvidenceUploadRow,
    outcome: { record: Omit<EvidenceRecord, "url"> } | { refusal: "sha256_mismatch" | "size_mismatch" },
  ): Promise<EvidenceUploadRow>;
  listRecords(filter: { issueKey: string } | { commit: string }): Promise<Omit<EvidenceRecord, "url">[]>;
  recent(query: EvidenceRecentQuery): Promise<EvidenceRecentResponse>;
  hasRecordForBlob(sha256: string): Promise<boolean>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Local disk blobs
// ---------------------------------------------------------------------------

class LocalDiskEvidenceBlobs implements EvidenceBlobStore {
  readonly backend = "local-disk";
  readonly location: string;
  private readonly incoming: string;

  constructor(root: string) {
    this.location = root;
    this.incoming = join(root, "incoming");
    mkdirSync(this.incoming, { recursive: true, mode: 0o700 });
  }

  private path(sha256: string) {
    return join(this.location, "sha256", sha256.slice(0, 2), sha256);
  }

  async has(sha256: string) {
    try {
      return (await stat(this.path(sha256))).isFile();
    } catch {
      return false;
    }
  }

  async write(sha256: string, size: number, body: AsyncIterable<Uint8Array>) {
    const temporary = join(this.incoming, `${randomUUID()}.part`);
    const hash = createHash("sha256");
    let received = 0;
    let oversize = false;
    const out = createWriteStream(temporary, { mode: 0o600, flags: "wx" });
    try {
      for await (const chunk of body) {
        received += chunk.byteLength;
        if (received > size) {
          oversize = true;
          break;
        }
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
      if (oversize || received !== size) return { ok: false as const, reason: "size_mismatch" as const };
      if (hash.digest("hex") !== sha256) return { ok: false as const, reason: "sha256_mismatch" as const };
      const target = this.path(sha256);
      mkdirSync(join(this.location, "sha256", sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
      await chmod(temporary, 0o400);
      // Same bytes under the same name: a concurrent writer that won is equivalent.
      await rename(temporary, target);
      return { ok: true as const };
    } finally {
      out.destroy();
      await rm(temporary, { force: true });
    }
  }

  async open(sha256: string) {
    try {
      const info = await stat(this.path(sha256));
      if (!info.isFile()) return undefined;
      return {
        size: info.size,
        body: Readable.toWeb(createReadStream(this.path(sha256))) as ReadableStream<Uint8Array>,
      };
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite metadata
// ---------------------------------------------------------------------------

interface UploadSqlRow {
  actor_key: string;
  idempotency_key: string;
  request: string;
  actor: string;
  state: EvidenceUploadRow["state"];
  record_id: string | null;
  refusal: EvidenceUploadRow["refusal"] | null;
}

interface RecordSqlRow {
  id: string;
  file_name: string;
  sha256: string;
  size: number;
  content_type: string;
  issue_key: string | null;
  commit_sha: string | null;
  actor: string;
  caption: string | null;
  created_at: string;
  details: string;
}

class SqliteEvidenceMetadata implements EvidenceMetadataStore {
  readonly backend = "sqlite";
  readonly location: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.location = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS uploads(
        actor_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, request TEXT NOT NULL, actor TEXT NOT NULL,
        state TEXT NOT NULL, record_id TEXT, refusal TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(actor_key, idempotency_key));
      CREATE TABLE IF NOT EXISTS records(
        id TEXT PRIMARY KEY, file_name TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
        content_type TEXT NOT NULL, issue_key TEXT, commit_sha TEXT, actor TEXT NOT NULL, caption TEXT,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_issue ON records(issue_key);
      CREATE INDEX IF NOT EXISTS records_commit ON records(commit_sha);
      CREATE INDEX IF NOT EXISTS records_sha ON records(sha256);
    `);
    const columns = this.db.prepare("PRAGMA table_info(records)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "details"))
      this.db.exec("ALTER TABLE records ADD COLUMN details TEXT NOT NULL DEFAULT '{}'");
    this.db.exec("CREATE INDEX IF NOT EXISTS records_recent ON records(created_at DESC, id DESC)");
  }

  private static upload(row: UploadSqlRow): EvidenceUploadRow {
    return {
      actorKey: row.actor_key,
      idempotencyKey: row.idempotency_key,
      request: JSON.parse(row.request) as EvidenceUploadRequest,
      actor: JSON.parse(row.actor) as EvidenceActor,
      state: row.state,
      ...(row.record_id === null ? {} : { recordId: row.record_id }),
      ...(row.refusal === null ? {} : { refusal: row.refusal }),
    };
  }

  private static record(row: RecordSqlRow): Omit<EvidenceRecord, "url"> {
    return {
      ...JSON.parse(row.details),
      id: row.id,
      fileName: row.file_name,
      sha256: row.sha256,
      size: row.size,
      contentType: row.content_type,
      ...(row.issue_key === null ? {} : { issueKey: row.issue_key }),
      ...(row.commit_sha === null ? {} : { commit: row.commit_sha }),
      actor: JSON.parse(row.actor) as EvidenceActor,
      ...(row.caption === null ? {} : { caption: row.caption }),
      createdAt: row.created_at,
    };
  }

  findUpload(actorKey: string, idempotencyKey: string) {
    const row = this.db
      .prepare("SELECT * FROM uploads WHERE actor_key=? AND idempotency_key=?")
      .get(actorKey, idempotencyKey) as UploadSqlRow | undefined;
    return Promise.resolve(row === undefined ? undefined : SqliteEvidenceMetadata.upload(row));
  }

  claimUpload(row: EvidenceUploadRow) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO uploads(actor_key, idempotency_key, request, actor, state, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        row.actorKey,
        row.idempotencyKey,
        JSON.stringify(row.request),
        JSON.stringify(row.actor),
        row.state,
        new Date().toISOString(),
      );
    return this.findUpload(row.actorKey, row.idempotencyKey).then((stored) => stored!);
  }

  settleUpload(
    row: EvidenceUploadRow,
    outcome: { record: Omit<EvidenceRecord, "url"> } | { refusal: "sha256_mismatch" | "size_mismatch" },
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT state FROM uploads WHERE actor_key=? AND idempotency_key=?")
        .get(row.actorKey, row.idempotencyKey) as { state: string } | undefined;
      if (current?.state === "pending") {
        if ("record" in outcome) {
          const record = outcome.record;
          this.db
            .prepare(
              "INSERT INTO records(id, file_name, sha256, size, content_type, issue_key, commit_sha, actor, caption, created_at, details) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              record.id,
              record.fileName,
              record.sha256,
              record.size,
              record.contentType,
              record.issueKey ?? null,
              record.commit ?? null,
              JSON.stringify(record.actor),
              record.caption ?? null,
              record.createdAt,
              JSON.stringify({
                project: record.project,
                repo: record.repo,
                model: record.model,
                outcome: record.outcome,
              }),
            );
          this.db
            .prepare(
              "UPDATE uploads SET state='applied', record_id=? WHERE actor_key=? AND idempotency_key=?",
            )
            .run(record.id, row.actorKey, row.idempotencyKey);
        } else {
          this.db
            .prepare("UPDATE uploads SET state='refused', refusal=? WHERE actor_key=? AND idempotency_key=?")
            .run(outcome.refusal, row.actorKey, row.idempotencyKey);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.findUpload(row.actorKey, row.idempotencyKey).then((stored) => stored!);
  }

  listRecords(filter: { issueKey: string } | { commit: string }) {
    const rows = ("issueKey" in filter
      ? this.db
          .prepare("SELECT * FROM records WHERE issue_key=? ORDER BY created_at, id")
          .all(filter.issueKey)
      : this.db
          .prepare("SELECT * FROM records WHERE commit_sha=? ORDER BY created_at, id")
          .all(filter.commit)) as unknown as RecordSqlRow[];
    return Promise.resolve(rows.map((row) => SqliteEvidenceMetadata.record(row)));
  }

  recent(query: EvidenceRecentQuery): Promise<EvidenceRecentResponse> {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    const fields = {
      project: "json_extract(details,'$.project')",
      repo: "json_extract(details,'$.repo')",
      issue: "issue_key",
      actorKind: "json_extract(actor,'$.kind')",
      actorName: "COALESCE(json_extract(actor,'$.name'),json_extract(actor,'$.id'))",
    };
    for (const [key, column] of Object.entries(fields)) {
      const value = query[key as keyof typeof fields];
      if (value !== undefined) {
        clauses.push(`${column}=?`);
        args.push(value);
      }
    }
    if (query.mediaType) {
      clauses.push("content_type LIKE ? ESCAPE '\\'");
      args.push(query.mediaType.replace(/[\\%_]/g, "\\$&") + (query.mediaType.includes("/") ? "" : "/%"));
    }
    if (query.since) {
      clauses.push("created_at>=?");
      args.push(new Date(query.since).toISOString());
    }
    if (query.until) {
      clauses.push("created_at<=?");
      args.push(new Date(query.until).toISOString());
    }
    if (query.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
      } catch {
        throw new EvidenceRefusal(400, "invalid_cursor");
      }
      if (!Array.isArray(cursor) || cursor.length !== 2 || cursor.some((v) => typeof v !== "string"))
        throw new EvidenceRefusal(400, "invalid_cursor");
      clauses.push("(created_at<? OR (created_at=? AND id<?))");
      args.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM records ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(...args, query.limit + 1) as unknown as RecordSqlRow[];
    const records = rows
      .slice(0, query.limit)
      .map((row) => ({ ...SqliteEvidenceMetadata.record(row), url: evidenceLink(row.sha256) }));
    const last = records.at(-1);
    return Promise.resolve({
      records,
      ...(rows.length > query.limit && last
        ? { nextCursor: Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url") }
        : {}),
    });
  }

  hasRecordForBlob(sha256: string) {
    return Promise.resolve(
      this.db.prepare("SELECT 1 FROM records WHERE sha256=? LIMIT 1").get(sha256) !== undefined,
    );
  }

  close() {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class EvidenceRefusal extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503;
  readonly code: string;
  constructor(status: EvidenceRefusal["status"], code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const SIGNED_URL_MS = EVIDENCE_SIGNED_URL_MAX_MS;

export class EvidenceStore {
  /** Per-process: a restart invalidates every outstanding link, and none outlives 15 minutes anyway. */
  private readonly signingKey = randomBytes(32);
  private readonly clock: () => number;

  readonly blobs: EvidenceBlobStore;
  readonly metadata: EvidenceMetadataStore;

  constructor(
    blobs: EvidenceBlobStore,
    metadata: EvidenceMetadataStore,
    options: { clock?: () => number } = {},
  ) {
    this.blobs = blobs;
    this.metadata = metadata;
    this.clock = options.clock ?? Date.now;
  }

  static local(root: string): EvidenceStore {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return new EvidenceStore(
      new LocalDiskEvidenceBlobs(join(root, "blobs")),
      new SqliteEvidenceMetadata(join(root, "evidence.sqlite")),
    );
  }

  status(): EvidenceStoreStatus {
    return {
      blobs: { backend: this.blobs.backend, location: this.blobs.location },
      metadata: { backend: this.metadata.backend, location: this.metadata.location },
    };
  }

  close() {
    this.metadata.close();
  }

  private sign(method: "GET" | "PUT", path: string, expires: number) {
    return createHmac("sha256", this.signingKey).update(`${method}\n${path}\n${expires}`).digest("base64url");
  }

  private signed(method: "GET" | "PUT", path: string) {
    const expires = this.clock() + SIGNED_URL_MS;
    return {
      url: `${path}?expires=${expires}&signature=${this.sign(method, path, expires)}`,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  verifySignature(
    method: "GET" | "PUT",
    path: string,
    expires: string | undefined,
    signature: string | undefined,
  ) {
    const at = Number(expires);
    if (!Number.isSafeInteger(at) || signature === undefined) return false;
    if (at < this.clock() || at > this.clock() + SIGNED_URL_MS) return false;
    const expected = Buffer.from(this.sign(method, path, at));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  static actorKey(actor: EvidenceActor) {
    return `${actor.kind}:${actor.id}`;
  }

  static blobPath(sha256: string) {
    return `${EVIDENCE_ROOT_PATH}/blobs/${sha256}`;
  }

  /** The signed path names the actor and receipt; the signature, not a bearer, is the authority. */
  static uploadPath(actorKey: string, receiptId: string) {
    return `${EVIDENCE_UPLOADS_PATH}/${Buffer.from(actorKey).toString("base64url")}/${receiptId}/blob`;
  }

  private async receipt(row: EvidenceUploadRow): Promise<EvidenceReceipt> {
    let current = row;
    // Another receipt may have supplied the same bytes meanwhile.
    if (current.state === "pending" && (await this.blobs.has(current.request.sha256)))
      current = await this.apply(current);
    const base = {
      receiptId: current.idempotencyKey,
      state: current.state,
      sha256: current.request.sha256,
      size: current.request.size,
      url: evidenceLink(current.request.sha256),
      ...(current.recordId === undefined ? {} : { recordId: current.recordId }),
      ...(current.refusal === undefined ? {} : { refusal: current.refusal }),
    };
    if (current.state !== "pending") return base;
    const upload = this.signed("PUT", EvidenceStore.uploadPath(current.actorKey, current.idempotencyKey));
    return { ...base, uploadUrl: upload.url, uploadExpiresAt: upload.expiresAt };
  }

  private apply(row: EvidenceUploadRow) {
    const request = row.request;
    return this.metadata.settleUpload(row, {
      record: {
        id: randomUUID(),
        fileName: request.fileName,
        sha256: request.sha256,
        size: request.size,
        contentType: request.contentType,
        ...(request.issueKey === undefined ? {} : { issueKey: request.issueKey }),
        ...(request.commit === undefined ? {} : { commit: request.commit }),
        ...(request.project === undefined ? {} : { project: request.project }),
        ...(request.repo === undefined ? {} : { repo: request.repo }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.outcome === undefined ? {} : { outcome: request.outcome }),
        actor: row.actor,
        ...(request.caption === undefined ? {} : { caption: request.caption }),
        createdAt: new Date(this.clock()).toISOString(),
      },
    });
  }

  async upload(actor: EvidenceActor, input: unknown): Promise<EvidenceReceipt> {
    const parsed = EvidenceUploadRequestSchema.safeParse(input);
    if (!parsed.success) throw new EvidenceRefusal(400, "invalid_request");
    const request = parsed.data;
    const stored = await this.metadata.claimUpload({
      actorKey: EvidenceStore.actorKey(actor),
      idempotencyKey: request.idempotencyKey,
      request,
      actor,
      state: "pending",
    });
    if (JSON.stringify(stored.request) !== JSON.stringify(request))
      throw new EvidenceRefusal(409, "idempotency_conflict");
    return this.receipt(stored);
  }

  async lookup(actor: EvidenceActor, receiptId: string): Promise<EvidenceReceipt> {
    const row = await this.metadata.findUpload(EvidenceStore.actorKey(actor), receiptId);
    if (row === undefined) throw new EvidenceRefusal(404, "unknown_receipt");
    return this.receipt(row);
  }

  /** The signed PUT: verifies sha256 and size before the blob exists, and settles the receipt. */
  async acceptBlob(
    actorKey: string,
    receiptId: string,
    body: AsyncIterable<Uint8Array>,
  ): Promise<EvidenceReceipt> {
    const row = await this.metadata.findUpload(actorKey, receiptId);
    if (row === undefined) throw new EvidenceRefusal(404, "unknown_receipt");
    if (row.state === "pending" && !(await this.blobs.has(row.request.sha256))) {
      const written = await this.blobs.write(row.request.sha256, row.request.size, body);
      if (!written.ok)
        return this.receipt(await this.metadata.settleUpload(row, { refusal: written.reason }));
    }
    return this.receipt(row);
  }

  async fetch(input: unknown): Promise<EvidenceFetchResponse> {
    const parsed = EvidenceFetchRequestSchema.safeParse(input);
    if (!parsed.success) throw new EvidenceRefusal(400, "invalid_request");
    const { sha256 } = parsed.data;
    const blob = await this.blobs.open(sha256);
    // Bytes nobody recorded are not evidence; a half-settled upload stays invisible.
    if (blob === undefined || !(await this.metadata.hasRecordForBlob(sha256))) {
      await blob?.body.cancel();
      throw new EvidenceRefusal(404, "unknown_object");
    }
    await blob.body.cancel();
    const link = this.signed("GET", EvidenceStore.blobPath(sha256));
    return { sha256, size: blob.size, url: link.url, expiresAt: link.expiresAt };
  }

  async list(filter: { issueKey: string } | { commit: string }): Promise<EvidenceRecord[]> {
    return (await this.metadata.listRecords(filter)).map((record) => ({
      ...record,
      url: evidenceLink(record.sha256),
    }));
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Bearer routes for upload, receipt, fetch, list and status; the two signed
 * routes (blob PUT and GET) carry no bearer, only an HMAC link that expires
 * within 15 minutes. Blobs are served as opaque bytes so stored HTML can never
 * run on the service's origin.
 */
export function createEvidenceRoutes(
  store: EvidenceStore | undefined,
  authenticate: (request: Request) => Promise<EvidenceActor | "unavailable" | undefined>,
) {
  const app = new Hono();
  app.use(`${EVIDENCE_ROOT_PATH}/*`, async (context, next) => {
    context.header("cache-control", "no-store");
    if (store === undefined) return context.json({ error: "evidence_store_unavailable" }, 503);
    await next();
  });
  const actor = async (request: Request) => {
    const identity = await authenticate(request);
    if (identity === "unavailable") throw new EvidenceRefusal(503, "authentication_unavailable");
    if (identity === undefined) throw new EvidenceRefusal(401, "authentication_required");
    return identity;
  };
  const guarded =
    (handler: (context: import("hono").Context) => Promise<Response>) =>
    async (context: import("hono").Context) => {
      try {
        return await handler(context);
      } catch (error) {
        if (error instanceof EvidenceRefusal) return context.json({ error: error.code }, error.status);
        if (error instanceof SyntaxError) return context.json({ error: "invalid_request" }, 400);
        throw error;
      }
    };
  const small = bodyLimit({ maxSize: 64 * 1024 });

  app.get(
    EVIDENCE_STATUS_PATH,
    guarded(async (context) => {
      await actor(context.req.raw);
      return context.json(store!.status());
    }),
  );
  app.post(
    EVIDENCE_UPLOADS_PATH,
    small,
    guarded(async (context) => {
      const caller = await actor(context.req.raw);
      return context.json(await store!.upload(caller, await context.req.json()));
    }),
  );
  app.get(
    `${EVIDENCE_RECEIPTS_PATH}/:receiptId`,
    guarded(async (context) => {
      const caller = await actor(context.req.raw);
      return context.json(await store!.lookup(caller, context.req.param("receiptId") ?? ""));
    }),
  );
  app.put(
    `${EVIDENCE_UPLOADS_PATH}/:actor/:receiptId/blob`,
    guarded(async (context) => {
      const url = new URL(context.req.url);
      if (
        !store!.verifySignature(
          "PUT",
          url.pathname,
          url.searchParams.get("expires") ?? undefined,
          url.searchParams.get("signature") ?? undefined,
        )
      )
        throw new EvidenceRefusal(403, "invalid_signature");
      const body = context.req.raw.body;
      if (body === null) throw new EvidenceRefusal(400, "invalid_request");
      const actorKey = Buffer.from(context.req.param("actor") ?? "", "base64url").toString("utf8");
      const receipt = await store!.acceptBlob(
        actorKey,
        context.req.param("receiptId") ?? "",
        body as unknown as AsyncIterable<Uint8Array>,
      );
      return context.json(receipt, receipt.state === "refused" ? 422 : 200);
    }),
  );
  app.post(
    EVIDENCE_FETCH_PATH,
    small,
    guarded(async (context) => {
      await actor(context.req.raw);
      return context.json(await store!.fetch(await context.req.json()));
    }),
  );
  app.get(
    `${EVIDENCE_ROOT_PATH}/blobs/:sha256`,
    guarded(async (context) => {
      const url = new URL(context.req.url);
      const sha256 = EvidenceSha256Schema.safeParse(context.req.param("sha256"));
      if (!sha256.success) throw new EvidenceRefusal(404, "unknown_object");
      if (
        !store!.verifySignature(
          "GET",
          url.pathname,
          url.searchParams.get("expires") ?? undefined,
          url.searchParams.get("signature") ?? undefined,
        )
      )
        throw new EvidenceRefusal(403, "invalid_signature");
      const blob = await store!.blobs.open(sha256.data);
      if (blob === undefined) throw new EvidenceRefusal(404, "unknown_object");
      return new Response(blob.body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(blob.size),
          "x-content-type-options": "nosniff",
          "content-disposition": "attachment",
          "cache-control": "no-store",
        },
      });
    }),
  );
  app.get(
    EVIDENCE_RECENT_PATH,
    guarded(async (context) => {
      await actor(context.req.raw);
      const query = EvidenceRecentQuerySchema.safeParse(context.req.query());
      if (!query.success) throw new EvidenceRefusal(400, "invalid_request");
      return context.json(await store!.metadata.recent(query.data));
    }),
  );
  app.get(
    `${EVIDENCE_PREVIEW_PATH}/:sha256`,
    guarded(async (context) => {
      await actor(context.req.raw);
      const hash = EvidenceSha256Schema.safeParse(context.req.param("sha256"));
      if (!hash.success) throw new EvidenceRefusal(400, "invalid_request");
      // Resolve only recorded bytes, under the same authentication as fetch.
      await store!.fetch({ sha256: hash.data });
      const blob = await store!.blobs.open(hash.data);
      if (!blob) throw new EvidenceRefusal(404, "unknown_object");
      if (blob.size > EVIDENCE_PREVIEW_MAX_BYTES) {
        await blob.body.cancel();
        return context.json({ sha256: hash.data, available: false, reason: "too_large" });
      }
      const bytes = Buffer.from(await new Response(blob.body).arrayBuffer());
      // Detect safe raster types from their magic, never serve SVG/HTML from the service origin.
      const contentType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216
          ? "image/jpeg"
          : bytes.subarray(0, 3).toString() === "GIF"
            ? "image/gif"
            : undefined;
      return context.json(
        contentType
          ? { sha256: hash.data, available: true, contentType, data: bytes.toString("base64") }
          : { sha256: hash.data, available: false, reason: "not_image" },
      );
    }),
  );
  app.get(
    EVIDENCE_RECORDS_PATH,
    guarded(async (context) => {
      await actor(context.req.raw);
      const issueKey = context.req.query("issue");
      const commit = context.req.query("commit");
      if ((issueKey === undefined) === (commit === undefined) || (issueKey ?? commit)!.length === 0)
        throw new EvidenceRefusal(400, "issue_or_commit_required");
      return context.json({
        records: await store!.list(issueKey === undefined ? { commit: commit! } : { issueKey }),
      });
    }),
  );
  return app;
}
