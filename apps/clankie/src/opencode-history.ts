import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { redactSensitiveText } from "@clankie/observability";
import {
  OPERATOR_CONVERSATION_CODE_MAX,
  OPERATOR_CONVERSATION_REF_MAX,
  type OperatorSeatSubagents,
} from "@clankie/protocol";
import {
  AgentSessionRequestError,
  SeatTranscriptUploadSchema,
  projectOpenCodeSubagents,
  type AgentSessionEntry,
} from "@clankie/agent-transcript";
import {
  OPEN_CODE_HISTORY_INDEXES,
  OPEN_CODE_HISTORY_MIGRATIONS,
  OPEN_CODE_HISTORY_SCHEMA,
} from "./opencode-history-schema.ts";
// @ts-expect-error Native OpenCode plugins are standalone ESM; reuse their v1 projection semantics.
import { projectMessages } from "../../../integrations/opencode-plugin/runtime.mjs";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PARTS = 2000;
const SessionId = z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u);
const RowId = z.string().min(1).max(160);
const Time = z.number().int().min(0).max(8_640_000_000_000_000);
const identity = (value: { dev: bigint; ino: bigint }) => `${value.dev}:${value.ino}`;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse(message: string): never {
  throw new AgentSessionRequestError(`OpenCode stored history unavailable: ${message}`, 409);
}

function decode(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return refuse("malformed native JSON record");
  }
}

/** A registered address only; no control, process liveness or resume authority. */
export interface OpenCodeHistorySource {
  readonly kind: "opencode-sqlite";
  readonly machineId: "local";
  readonly profileId: string;
  readonly database: string;
  readonly databaseIdentity: string;
  readonly sessionId: string;
  readonly version: "1.18.18";
  readonly workingDirectory: string;
}
export interface OpenCodeHistorySnapshot {
  readonly subagents?: OperatorSeatSubagents;
  readonly source: OpenCodeHistorySource;
  readonly title: string;
  readonly modifiedAt: string;
  readonly entries: readonly AgentSessionEntry[];
  readonly cursor: string;
  readonly reset?: true;
  readonly truncated?: true;
  /** Bytes in this bounded projection, never the size of the whole database. */
  readonly projectionBytes: number;
  readonly scope: "stored-v1-export";
  readonly stagedRevert: boolean;
}

/** DB no-create preflight; native SQLite may coordinate/recreate WAL/SHM in this owned profile. */
async function files(database: string, profileRoot: string) {
  if (
    (await realpath(profileRoot)) !== profileRoot ||
    dirname(database) !== profileRoot ||
    database !== join(profileRoot, "opencode.db")
  )
    refuse("database is outside its canonical dedicated profile");
  const folder = await lstat(profileRoot, { bigint: true });
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== BigInt(process.getuid!()))
    refuse("profile ownership changed");
  const inspect = async (path: string) => {
    const value = await lstat(path, { bigint: true });
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.nlink !== 1n ||
      value.uid !== folder.uid ||
      (await realpath(path)) !== path
    )
      refuse("database or sidecar is not a confined owned regular file");
    return identity(value);
  };
  const db = await inspect(database);
  const handle = await open(database, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (identity(await handle.stat({ bigint: true })) !== db) refuse("database replaced while opening");
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, 100, 0);
    if (bytesRead !== 100 || header.subarray(0, 16).toString() !== "SQLite format 3\0")
      refuse("invalid native SQLite header");
    if (![1, 2].includes(header[18]!) || ![1, 2].includes(header[19]!))
      refuse("unsupported native SQLite journal format");
  } finally {
    await handle.close();
  }
  const sidecars: Record<string, string> = {};
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      sidecars[suffix] = await inspect(database + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (sidecars["-journal"]) refuse("rollback journal requires native recovery");
  return { profile: identity(folder), database: db, sidecars };
}

function schema(db: DatabaseSync) {
  for (const [table, expected] of Object.entries(OPEN_CODE_HISTORY_SCHEMA)) {
    const definition = db
      .prepare("SELECT type, length(sql) AS size, substr(sql,1,24) AS prefix FROM sqlite_master WHERE name=?")
      .get(table);
    if (
      definition?.type !== "table" ||
      typeof definition.prefix !== "string" ||
      !/^CREATE TABLE\s/iu.test(definition.prefix) ||
      typeof definition.size !== "number" ||
      definition.size > 32_768
    )
      refuse("unsupported table schema");
    // Identifiers are from the fixed source-pinned map, never a request or DB row.
    const columns = db
      .prepare(`PRAGMA table_xinfo(${table})`)
      .all()
      .map((row) => [row.name, String(row.type).toUpperCase(), row.notnull, row.pk, row.hidden]);
    if (JSON.stringify(columns) !== JSON.stringify(expected)) refuse(`unsupported ${table} schema`);
  }
  for (const [index, expected] of Object.entries(OPEN_CODE_HISTORY_INDEXES)) {
    const columns = db
      .prepare(`PRAGMA index_info(${index})`)
      .all()
      .map((row) => row.name);
    if (JSON.stringify(columns) !== JSON.stringify(expected))
      refuse("required native history index unavailable");
    const keys = db
      .prepare(`PRAGMA index_xinfo(${index})`)
      .all()
      .filter((row) => row.key === 1);
    if (keys.some((row) => row.desc !== 0 || row.coll !== "BINARY"))
      refuse("unsupported native history index ordering");
  }
  const migrations = db
    .prepare(
      "SELECT CASE WHEN length(id)<=128 THEN id ELSE NULL END AS id FROM migration ORDER BY id LIMIT 65",
    )
    .all()
    .map((row) => row.id);
  if (JSON.stringify(migrations) !== JSON.stringify(OPEN_CODE_HISTORY_MIGRATIONS))
    refuse("unsupported native migration revision");
  return digest([OPEN_CODE_HISTORY_SCHEMA, OPEN_CODE_HISTORY_INDEXES, migrations]);
}

const Cursor = z
  .object({
    version: z.literal(1),
    binding: z.string().length(64),
    content: z.string().length(64),
    tail: z.number().int().min(1).max(500),
  })
  .strict();
function cursor(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new AgentSessionRequestError("Invalid native history cursor");
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    throw new AgentSessionRequestError("Invalid native history cursor");
  }
}

/** Bounded stored v1/export projection. Never current TUI selection or model acceptance. */
export async function readOpenCodeHistory(
  source: OpenCodeHistorySource,
  profileRoot: string,
  options: {
    readonly tail?: number;
    readonly after?: string;
    readonly metadataOnly?: boolean;
    readonly subagentsOnly?: boolean;
  } = {},
): Promise<OpenCodeHistorySnapshot> {
  const after = cursor(options.after);
  const tail = options.tail ?? after?.tail ?? 50;
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > 500)
    throw new AgentSessionRequestError("tail must be an integer from 1 to 500");
  SessionId.parse(source.sessionId);
  if (
    source.kind !== "opencode-sqlite" ||
    source.machineId !== "local" ||
    source.version !== "1.18.18" ||
    !/^profile-[A-Za-z0-9]+$/u.test(source.profileId) ||
    !profileRoot.endsWith(`/${source.profileId}`)
  )
    refuse("unsupported native source");
  const before = await files(source.database, profileRoot);
  if (before.database !== source.databaseIdentity) refuse("registered database replaced");
  const db = new DatabaseSync(source.database, {
    readOnly: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  let result: OpenCodeHistorySnapshot;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250; BEGIN");
    const revision = schema(db);
    const size = db
      .prepare(
        "SELECT length(CAST(directory AS BLOB))+length(CAST(title AS BLOB))+length(CAST(version AS BLOB))+coalesce(length(CAST(revert AS BLOB)),0) AS bytes FROM session WHERE id=?",
      )
      .get(source.sessionId);
    if (!size) throw new AgentSessionRequestError("Native session row unavailable", 404);
    if (typeof size.bytes !== "number" || size.bytes > 64 * 1024)
      refuse("native session metadata exceeds bound");
    const session = z
      .object({
        id: SessionId,
        directory: z.string().max(4096),
        title: z.string().max(16_384),
        version: z.literal("1.18.18"),
        time_updated: Time,
        revert: z.string().nullable(),
      })
      .parse(
        db
          .prepare("SELECT id,directory,title,version,time_updated,revert FROM session WHERE id=?")
          .get(source.sessionId),
      );
    if (
      session.id !== source.sessionId ||
      session.directory !== source.workingDirectory ||
      !session.directory.startsWith("/") ||
      session.directory.includes("\0")
    )
      refuse("native session directory mismatch");
    const revert =
      session.revert === null ? null : z.record(z.string(), z.unknown()).parse(decode(session.revert));
    const binding = digest([source, before.profile, revision]);
    if (after && (after.binding !== binding || after.tail !== tail))
      throw new AgentSessionRequestError("Native history cursor belongs to another source or page", 409);
    let bytes = size.bytes;
    const rows = options.metadataOnly
      ? []
      : db
          .prepare(
            "SELECT CASE WHEN length(id)<=160 THEN id ELSE NULL END AS id,time_created,length(CAST(data AS BLOB)) AS bytes FROM message INDEXED BY message_session_time_created_id_idx WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT ?",
          )
          .all(source.sessionId, tail + 1);
    const truncated = rows.length > tail;
    const selected = rows.slice(0, tail).reverse();
    if (
      !options.metadataOnly &&
      selected.length === 0 &&
      db
        .prepare(
          "SELECT 1 FROM session_message INDEXED BY session_message_session_seq_idx WHERE session_id=? LIMIT 1",
        )
        .get(source.sessionId)
    )
      refuse("native v2-only history is unsupported");
    const messages: unknown[] = [];
    const taskMessages: unknown[] = [];
    let partsCount = 0;
    for (const metadata of selected) {
      const messageId = RowId.parse(metadata.id);
      Time.parse(metadata.time_created);
      if (typeof metadata.bytes !== "number" || metadata.bytes < 2 || (bytes += metadata.bytes) > MAX_BYTES)
        refuse("native history payload exceeds 4 MiB");
      const partMetadata = db
        .prepare(
          "SELECT CASE WHEN length(id)<=160 THEN id ELSE NULL END AS id,CASE WHEN length(session_id)<=160 THEN session_id ELSE NULL END AS session_id,time_created,length(CAST(data AS BLOB)) AS bytes FROM part INDEXED BY part_message_id_id_idx WHERE message_id=? ORDER BY id LIMIT ?",
        )
        .all(messageId, MAX_PARTS - partsCount + 1);
      partsCount += partMetadata.length;
      if (partsCount > MAX_PARTS) refuse("native history part count exceeds bound");
      for (const part of partMetadata) {
        RowId.parse(part.id);
        if (
          part.session_id !== source.sessionId ||
          typeof part.bytes !== "number" ||
          part.bytes < 2 ||
          (bytes += part.bytes) > MAX_BYTES
        )
          refuse("invalid or oversized native part");
      }
      const infoRow = db
        .prepare("SELECT data FROM message WHERE id=? AND session_id=?")
        .get(messageId, source.sessionId);
      if (typeof infoRow?.data !== "string") refuse("invalid native message JSON");
      const info = z
        .object({
          role: z.enum(["user", "assistant"]),
          time: z.object({ created: Time, completed: Time.optional() }),
        })
        .passthrough()
        .parse(decode(infoRow.data));
      const taskParts: unknown[] = [];
      const parts = partMetadata.map((metadata) => {
        const row = db
          .prepare("SELECT data FROM part WHERE id=? AND message_id=? AND session_id=?")
          .get(String(metadata.id), messageId, source.sessionId);
        if (typeof row?.data !== "string") refuse("invalid native part JSON");
        const part = z
          .object({
            type: z.enum([
              "text",
              "reasoning",
              "file",
              "agent",
              "subtask",
              "retry",
              "step-start",
              "step-finish",
              "snapshot",
              "patch",
              "compaction",
              "tool",
            ]),
          })
          .passthrough()
          .parse(decode(row.data));
        if (options.subagentsOnly)
          taskParts.push({
            ...part,
            sessionID: source.sessionId,
            createdAt: Time.parse(metadata.time_created),
          });
        if (part.type === "text") {
          const value = z.object({ text: z.string(), synthetic: z.boolean().optional() }).parse(part);
          // Redact the entire native field before projection chunks/truncates it.
          part.text = redactSensitiveText(value.text.replace(/\r\n?/gu, "\n").trim());
        }
        if (part.type === "tool") {
          const fields = {
            output: z.string().max(MAX_BYTES).optional(),
            error: z.string().max(MAX_BYTES).optional(),
          };
          const value = z
            .object({
              callID: z.string().trim().min(1).max(OPERATOR_CONVERSATION_REF_MAX),
              tool: z.string().trim().min(1).max(OPERATOR_CONVERSATION_CODE_MAX),
              state: z.discriminatedUnion("status", [
                z.object({ status: z.literal("pending"), ...fields }),
                z.object({ status: z.literal("running"), ...fields }),
                z.object({ status: z.literal("completed"), ...fields, output: z.string().max(MAX_BYTES) }),
                z.object({ status: z.literal("error"), ...fields, error: z.string().max(MAX_BYTES) }),
              ]),
            })
            .parse(part);
          part.callID = value.callID;
          part.tool = value.tool;
          part.state = {
            ...value.state,
            ...(value.state.output === undefined
              ? {}
              : { output: redactSensitiveText(value.state.output.replace(/\r\n?/gu, "\n").trim()) }),
            ...(value.state.error === undefined
              ? {}
              : { error: redactSensitiveText(value.state.error.replace(/\r\n?/gu, "\n").trim()) }),
          };
        }
        return { ...part, id: metadata.id, messageID: messageId, sessionID: source.sessionId };
      });
      messages.push({ info: { ...info, id: messageId, sessionID: source.sessionId }, parts });
      if (options.subagentsOnly)
        taskMessages.push({ info: { ...info, sessionID: source.sessionId }, parts: taskParts });
    }
    const content = digest([session, messages, truncated]);
    const entries: AgentSessionEntry[] =
      options.subagentsOnly || after?.content === content
        ? []
        : (projectMessages(source.sessionId, messages) as unknown[]).map((value) =>
            SeatTranscriptUploadSchema.shape.entries.element.parse(value),
          );
    if (Buffer.byteLength(JSON.stringify(entries)) > MAX_BYTES)
      refuse("projected native history exceeds bound");
    result = {
      ...(options.subagentsOnly
        ? {
            subagents: projectOpenCodeSubagents(source.sessionId, taskMessages, (id) => {
              SessionId.parse(id);
              const child = db
                .prepare("SELECT 1 FROM session WHERE id=? AND parent_id=? AND directory=? AND version=?")
                .get(id, source.sessionId, source.workingDirectory, source.version);
              return child !== undefined;
            }),
          }
        : {}),
      source,
      title: session.title,
      modifiedAt: new Date(session.time_updated).toISOString(),
      entries,
      cursor: Buffer.from(JSON.stringify({ version: 1, binding, content, tail })).toString("base64url"),
      projectionBytes: bytes,
      scope: "stored-v1-export",
      stagedRevert: revert !== null,
      ...(after && after.content !== content ? { reset: true as const } : {}),
      ...(truncated ? { truncated: true as const } : {}),
    };
    if (schema(db) !== revision) refuse("native schema changed during read");
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const final = await files(source.database, profileRoot);
  // New regular WAL/SHM files are permitted native reader coordination. An
  // original file disappearing/replacing, or the DB/profile changing, refuses.
  if (
    final.profile !== before.profile ||
    final.database !== before.database ||
    Object.entries(before.sidecars).some(([name, id]) => final.sidecars[name] !== id)
  )
    refuse("native database/profile/sidecar replaced during read");
  return result;
}

/** Used only for a newly bound controller's exact DB, never caller-provided discovery. */
export async function openCodeDatabaseIdentity(database: string, profileRoot: string): Promise<string> {
  return (await files(database, profileRoot)).database;
}
