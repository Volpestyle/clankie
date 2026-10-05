import { DatabaseSync } from "node:sqlite";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HostedComposerRefusedError } from "./hosted-body.ts";
import {
  COMPOSER_TRANSCRIPTION_ROOT,
  COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX,
  COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX,
  COMPOSER_TRANSCRIPTION_DURATION_MS_MAX,
  ComposerTranscriptionBeginSchema,
  ComposerTranscriptionChunkSchema,
  ComposerTranscriptionRequestSchema,
  ComposerTranscriptionReceiptSchema,
  ComposerTranscriptionStatusSchema,
  parseComposerWav,
  type ComposerTranscriptionDevice,
  type ComposerTranscriptionReceipt,
  type ComposerTranscriptionStatus,
  type HostedComposerTranscription,
  type HostedComposerReceipt,
} from "@clankie/protocol/composer-transcription";

export interface ComposerDeviceAuthority {
  deviceId: string;
  sessionExpiresAtMs: number;
  authKeyId?: string;
  current(): boolean;
  authorize(): Promise<boolean>;
}
export interface ComposerTranscriptionCloud {
  status(device: ComposerTranscriptionDevice): Promise<ComposerTranscriptionStatus>;
  transcribe(input: HostedComposerTranscription, signal: AbortSignal): Promise<ComposerTranscriptionReceipt>;
  receipt(input: HostedComposerReceipt): Promise<ComposerTranscriptionReceipt>;
}
class Refusal extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503;
  readonly code: string;
  constructor(status: Refusal["status"], code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
interface Record {
  id: string;
  device: string;
  bytes: number;
  received: number;
  expires: number;
  state: ComposerTranscriptionReceipt["state"];
}
const TTL_MS = 10 * 60_000;

/** SQLite retains small request tombstones; neither audio nor draft text is persisted in receipts. */
export class ComposerTranscriptions {
  private readonly db: DatabaseSync;
  private readonly audioRoot: string;
  private readonly live = new Map<
    string,
    {
      controller: AbortController;
      text?: string | undefined;
      error?: ComposerTranscriptionReceipt["error"];
    }
  >();
  private readonly starts = new Map<string, number[]>();
  private readonly options: {
    root: string;
    installationId?: string;
    cloud?: ComposerTranscriptionCloud;
    clock?: () => number;
  };
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(options: ComposerTranscriptions["options"]) {
    this.options = options;
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.audioRoot = join(options.root, "audio");
    mkdirSync(this.audioRoot, { recursive: true, mode: 0o700 });
    const database = join(options.root, "requests.sqlite");
    this.db = new DatabaseSync(database);
    chmodSync(database, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, device TEXT NOT NULL, bytes INTEGER NOT NULL, received INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL)",
    );
    this.db.exec(
      "UPDATE requests SET state='uncertain' WHERE state IN ('transcribing','complete'); UPDATE requests SET state='cancelled' WHERE state='uploading'",
    );
    for (const name of readdirSync(this.audioRoot))
      if (/^[a-f0-9-]{36}\.wav$/iu.test(name)) unlinkSync(join(this.audioRoot, name));
    this.timer = setInterval(() => this.expire(), 30_000);
    this.timer.unref();
  }
  private now() {
    return this.options.clock?.() ?? Date.now();
  }
  private file(id: string) {
    return join(this.audioRoot, `${id}.wav`);
  }
  private removeAudio(id: string) {
    try {
      unlinkSync(this.file(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private find(id: string, owner: ComposerDeviceAuthority): Record {
    if (this.closed) throw new Refusal(503, "unavailable");
    this.expire();
    const row = this.db.prepare("SELECT * FROM requests WHERE id=?").get(id) as Record | undefined;
    if (!row || row.device !== owner.deviceId) throw new Refusal(404, "not_found");
    return row;
  }
  private state(id: string, state: Record["state"]) {
    this.db.prepare("UPDATE requests SET state=? WHERE id=?").run(state, id);
  }
  private result(row: Record): ComposerTranscriptionReceipt {
    const text = this.live.get(row.id)?.text;
    const state = row.state === "complete" && text === undefined ? "uncertain" : row.state;
    return ComposerTranscriptionReceiptSchema.parse({
      schemaVersion: 1,
      requestId: row.id,
      state,
      ...(state === "complete" ? { text } : {}),
      ...(state === "uploading" ? { receivedBytes: row.received } : {}),
      ...(["failed", "uncertain"].includes(state) && this.live.get(row.id)?.error !== undefined
        ? { error: this.live.get(row.id)!.error }
        : {}),
    });
  }
  private async guard(owner: ComposerDeviceAuthority) {
    if (!owner.current() || !(await owner.authorize()) || !owner.current())
      throw new Refusal(403, "forbidden");
  }
  private device(owner: ComposerDeviceAuthority): ComposerTranscriptionDevice {
    if (!this.options.installationId || !owner.authKeyId) throw new Refusal(503, "unavailable");
    return {
      installationId: this.options.installationId,
      deviceId: owner.deviceId,
      authKeyId: owner.authKeyId,
      sessionExpiresAtMs: owner.sessionExpiresAtMs,
      chat: true,
      support: false,
    };
  }
  async status(owner: ComposerDeviceAuthority): Promise<ComposerTranscriptionStatus> {
    await this.guard(owner);
    const status = this.options.cloud
      ? await this.options.cloud.status(this.device(owner))
      : {
          schemaVersion: 1,
          mode: "local",
          state: "ineligible",
          maxDurationMs: COMPOSER_TRANSCRIPTION_DURATION_MS_MAX,
          maxAudioBytes: COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX,
          maxChunkBytes: COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX,
        };
    await this.guard(owner);
    return ComposerTranscriptionStatusSchema.parse(status);
  }
  async begin(owner: ComposerDeviceAuthority, input: { requestId: string; audioBytes: number }) {
    await this.guard(owner);
    this.expire();
    const existing = this.db.prepare("SELECT * FROM requests WHERE id=?").get(input.requestId) as
      | Record
      | undefined;
    if (existing) {
      if (existing.device !== owner.deviceId || existing.bytes !== input.audioBytes)
        throw new Refusal(409, "conflict");
      return this.result(existing);
    }
    const status = await this.status(owner);
    if (status.state !== "available" || status.mode !== "managed")
      throw new Refusal(403, status.state === "allowance_exhausted" ? status.state : "ineligible");
    if (input.audioBytes > status.maxAudioBytes) throw new Refusal(400, "invalid_audio");
    await this.guard(owner);
    const repeated = this.db.prepare("SELECT * FROM requests WHERE id=?").get(input.requestId) as
      | Record
      | undefined;
    if (repeated) {
      if (repeated.device !== owner.deviceId || repeated.bytes !== input.audioBytes)
        throw new Refusal(409, "conflict");
      return this.result(repeated);
    }
    const active = this.db
      .prepare("SELECT device FROM requests WHERE state IN ('uploading','transcribing')")
      .all();
    if (active.length >= 8 || active.filter((row) => row.device === owner.deviceId).length >= 2)
      throw new Refusal(429, "capacity");
    if (Number(this.db.prepare("SELECT count(*) AS total FROM requests").get()?.total) >= 100_000)
      throw new Refusal(429, "capacity");
    const now = this.now();
    for (const [device, times] of this.starts)
      if ((times.at(-1) ?? 0) <= now - 60_000) this.starts.delete(device);
    const recent = (this.starts.get(owner.deviceId) ?? []).filter((time) => time > now - 60_000);
    if (recent.length >= 6 || (this.starts.size >= 128 && !this.starts.has(owner.deviceId)))
      throw new Refusal(429, "capacity");
    this.starts.set(owner.deviceId, [...recent, now]);
    this.db
      .prepare("INSERT INTO requests VALUES(?,?,?,?,?,?)")
      .run(input.requestId, owner.deviceId, input.audioBytes, 0, this.now() + TTL_MS, "uploading");
    try {
      writeFileSync(this.file(input.requestId), new Uint8Array(), { flag: "wx", mode: 0o600 });
    } catch {
      this.state(input.requestId, "failed");
      throw new Refusal(503, "unavailable");
    }
    this.live.set(input.requestId, { controller: new AbortController() });
    return this.result(this.find(input.requestId, owner));
  }
  async chunk(
    owner: ComposerDeviceAuthority,
    input: { requestId: string; offset: number; dataBase64: string },
  ) {
    await this.guard(owner);
    const row = this.find(input.requestId, owner);
    if (row.state !== "uploading") throw new Refusal(409, "conflict");
    const data = Buffer.from(input.dataBase64, "base64");
    if (
      !data.length ||
      data.length > COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX ||
      data.toString("base64") !== input.dataBase64 ||
      input.offset + data.length > row.bytes
    )
      throw new Refusal(400, "invalid_request");
    if (
      input.offset < row.received &&
      input.offset + data.length <= row.received &&
      readFileSync(this.file(row.id))
        .subarray(input.offset, input.offset + data.length)
        .equals(data)
    )
      return this.result(row);
    if (input.offset !== row.received) throw new Refusal(409, "conflict");
    appendFileSync(this.file(row.id), data);
    this.db.prepare("UPDATE requests SET received=? WHERE id=?").run(row.received + data.length, row.id);
    return this.result(this.find(row.id, owner));
  }
  async commit(owner: ComposerDeviceAuthority, requestId: string): Promise<ComposerTranscriptionReceipt> {
    await this.guard(owner);
    const row = this.find(requestId, owner);
    if (row.state !== "uploading") return this.result(row);
    if (row.received !== row.bytes) throw new Refusal(409, "conflict");
    const audio = readFileSync(this.file(requestId));
    try {
      parseComposerWav(audio);
    } catch {
      this.state(requestId, "failed");
      this.removeAudio(requestId);
      throw new Refusal(400, "invalid_audio");
    }
    if (!this.options.cloud) throw new Refusal(503, "unavailable");
    await this.guard(owner);
    const current = this.find(requestId, owner);
    if (current.state !== "uploading") return this.result(current);
    // Admit durably before dispatch. A restart or uncertain network result never resends audio.
    this.state(requestId, "transcribing");
    const live = this.live.get(requestId)!;
    const timeout = setTimeout(() => live.controller.abort(), 90_000);
    timeout.unref();
    try {
      const receipt = ComposerTranscriptionReceiptSchema.parse(
        await this.options.cloud.transcribe(
          {
            ...this.device(owner),
            requestId,
            sha256: createHash("sha256").update(audio).digest("hex"),
            audioBase64: audio.toString("base64"),
          },
          live.controller.signal,
        ),
      );
      await this.guard(owner);
      if (this.find(requestId, owner).state === "cancelled") return this.result(this.find(requestId, owner));
      if (live.controller.signal.aborted) {
        this.state(requestId, "uncertain");
        return this.result(this.find(requestId, owner));
      }
      if (receipt.requestId !== requestId || !["complete", "failed", "uncertain"].includes(receipt.state))
        throw new Error("invalid_receipt");
      if (receipt.state === "complete") live.text = receipt.text;
      live.error = receipt.error;
      this.state(requestId, receipt.state);
    } catch (error) {
      if (!this.closed && this.find(requestId, owner).state !== "cancelled") {
        if (error instanceof HostedComposerRefusedError) {
          live.error = error.code;
          this.state(requestId, "failed");
        } else this.state(requestId, "uncertain");
      }
    } finally {
      clearTimeout(timeout);
      this.removeAudio(requestId);
    }
    if (this.closed) return { schemaVersion: 1, requestId, state: "cancelled" };
    await this.guard(owner);
    return this.result(this.find(requestId, owner));
  }
  async cancel(owner: ComposerDeviceAuthority, requestId: string) {
    await this.guard(owner);
    const row = this.find(requestId, owner);
    this.state(requestId, "cancelled");
    this.live.get(requestId)?.controller.abort();
    this.live.delete(requestId);
    this.removeAudio(row.id);
    return this.result(this.find(requestId, owner));
  }
  async receipt(owner: ComposerDeviceAuthority, requestId: string) {
    await this.guard(owner);
    const row = this.find(requestId, owner);
    if (row.state === "uncertain" && this.options.cloud) {
      try {
        const answer = ComposerTranscriptionReceiptSchema.parse(
          await this.options.cloud.receipt({ ...this.device(owner), requestId }),
        );
        await this.guard(owner);
        if (
          answer.requestId === requestId &&
          this.find(requestId, owner).state === "uncertain" &&
          answer.state === "complete"
        ) {
          this.live.set(requestId, { controller: new AbortController(), text: answer.text });
          this.state(requestId, "complete");
        }
      } catch {
        /* Read-only recovery cannot authorize a second transcription. */
      }
    }
    await this.guard(owner);
    return this.result(this.find(requestId, owner));
  }
  private expire() {
    const expired = this.db
      .prepare("SELECT id FROM requests WHERE expires<=? AND state!='cancelled'")
      .all(this.now());
    for (const entry of expired) {
      const id = String(entry.id);
      this.state(id, "cancelled");
      this.live.get(id)?.controller.abort();
      this.live.delete(id);
      this.removeAudio(id);
    }
  }
  close() {
    if (this.closed) return;
    clearInterval(this.timer);
    for (const [id, entry] of this.live) {
      entry.controller.abort();
      this.removeAudio(id);
    }
    this.live.clear();
    this.db.exec(
      "UPDATE requests SET state='uncertain' WHERE state IN ('transcribing','complete'); UPDATE requests SET state='cancelled' WHERE state='uploading'",
    );
    this.closed = true;
    this.db.close();
  }
}

export function createComposerTranscriptionRoutes(
  service: ComposerTranscriptions | undefined,
  authorize: (request: Request) => Promise<ComposerDeviceAuthority | undefined>,
) {
  const app = new Hono();
  app.use(`${COMPOSER_TRANSCRIPTION_ROOT}/*`, bodyLimit({ maxSize: 400 * 1024 }));
  app.all(`${COMPOSER_TRANSCRIPTION_ROOT}/:action`, async (context) => {
    context.header("cache-control", "no-store");
    try {
      const owner = await authorize(context.req.raw);
      if (!owner) throw new Refusal(401, "authentication_required");
      const action = context.req.param("action");
      if (service === undefined) {
        if (!owner.current() || !(await owner.authorize()) || !owner.current())
          throw new Refusal(403, "forbidden");
        if (action !== "status" || context.req.method !== "GET") throw new Refusal(403, "ineligible");
        return context.json({
          schemaVersion: 1,
          mode: "local",
          state: "ineligible",
          maxDurationMs: COMPOSER_TRANSCRIPTION_DURATION_MS_MAX,
          maxAudioBytes: COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX,
          maxChunkBytes: COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX,
        });
      }
      if (action === "status" && context.req.method === "GET")
        return context.json(await service.status(owner));
      if (context.req.method !== "POST") throw new Refusal(400, "invalid_request");
      const body: unknown = await context.req.json();
      if (action === "begin")
        return context.json(await service.begin(owner, ComposerTranscriptionBeginSchema.parse(body)));
      if (action === "chunk")
        return context.json(await service.chunk(owner, ComposerTranscriptionChunkSchema.parse(body)));
      const { requestId } = ComposerTranscriptionRequestSchema.parse(body);
      if (action === "commit") return context.json(await service.commit(owner, requestId));
      if (action === "cancel") return context.json(await service.cancel(owner, requestId));
      if (action === "receipt") return context.json(await service.receipt(owner, requestId));
      throw new Refusal(400, "invalid_request");
    } catch (error) {
      if (error instanceof Refusal) return context.json({ error: error.code }, error.status);
      return context.json(
        {
          error:
            error instanceof z.ZodError || error instanceof SyntaxError ? "invalid_request" : "unavailable",
        },
        error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503,
      );
    }
  });
  return app;
}
