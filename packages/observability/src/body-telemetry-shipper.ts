/**
 * Ships a body's telemetry spool to CloudWatch Logs.
 *
 * Runs on the tenant host, not in the body: the host runs the pinned image's
 * `clankie telemetry ship` with host networking, the spool mounted read-only
 * and a host-owned cursor directory. It takes the tenant and instance ids from
 * the instance metadata service, never from the spool, so a body cannot write
 * into another tenant's stream. Every line is parsed against the event schema
 * again; anything else is counted and dropped.
 */
import { createHash, createHmac, type Hash, type Hmac } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SignatureV4 } from "@smithy/signature-v4";
import { z } from "zod";
import { parseBodyTelemetryLine, type BodyTelemetryEvent } from "./body-telemetry.ts";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiresAtMs?: number;
}

export interface BodyIdentity {
  readonly region: string;
  readonly instanceId: string;
  readonly tenantId: string;
}

/** One shipped line: the spool event plus the ids only the host can vouch for. */
export type ShippedEvent = BodyTelemetryEvent & { readonly tenantId: string; readonly instanceId: string };

export interface LogSink {
  put(stream: string, events: readonly ShippedEvent[]): Promise<void>;
}

export interface ShipResult {
  readonly shipped: number;
  readonly dropped: number;
  readonly files: number;
}

const CursorSchema = z.object({ files: z.record(z.string(), z.number().int().nonnegative()) }).strict();
type Cursor = z.infer<typeof CursorSchema>;

/** CloudWatch refuses events older than 14 days or 2 hours in the future. */
const MAX_AGE_MS = 13 * 24 * 3_600_000;
const MAX_FUTURE_MS = 60 * 60_000;
/** Stay well inside PutLogEvents' 10 000 events / 1 MiB and 24-hour-span limits. */
const BATCH_EVENTS_MAX = 1_000;
const BATCH_BYTES_MAX = 512 * 1024;
const BATCH_SPAN_MS = 12 * 3_600_000;
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Reads new lines from every spool file past its cursor, ships the valid ones
 * and advances the cursor only after the sink accepted them.
 */
export async function shipSpool(input: {
  readonly spoolDir: string;
  readonly cursorPath: string;
  readonly identity: BodyIdentity;
  readonly sink: LogSink;
  readonly now?: () => number;
}): Promise<ShipResult> {
  const now = (input.now ?? Date.now)();
  const cursor = readCursor(input.cursorPath);
  const names = readdirSync(input.spoolDir)
    .filter((name) => /^\d{10}-[a-z0-9-]{1,32}\.jsonl$/u.test(name))
    .sort();
  const next: Cursor = { files: {} };
  const events: ShippedEvent[] = [];
  let dropped = 0;
  for (const name of names) {
    const path = join(input.spoolDir, name);
    const size = statSync(path).size;
    let offset = cursor.files[name] ?? 0;
    // A file never shrinks; if it did, it was replaced, so read it again.
    if (offset > size) offset = 0;
    if (offset < size) {
      const text = readFileSync(path).subarray(offset).toString("utf8");
      // Only whole lines: a writer may be mid-append.
      const complete = text.lastIndexOf("\n") + 1;
      for (const line of text.slice(0, complete).split("\n")) {
        if (line.length === 0) continue;
        const event = parseBodyTelemetryLine(line);
        if (event === undefined || event.atMs < now - MAX_AGE_MS || event.atMs > now + MAX_FUTURE_MS) {
          dropped += 1;
          continue;
        }
        events.push({ ...event, tenantId: input.identity.tenantId, instanceId: input.identity.instanceId });
      }
      offset += Buffer.byteLength(text.slice(0, complete));
    }
    next.files[name] = offset;
  }
  events.sort((a, b) => a.atMs - b.atMs);
  const stream = `${input.identity.tenantId}/${input.identity.instanceId}`;
  for (const batch of batches(events)) await input.sink.put(stream, batch);
  // Files pruned from the spool drop out of the cursor with it.
  writeCursor(input.cursorPath, next);
  return { shipped: events.length, dropped, files: names.length };
}

function* batches(events: readonly ShippedEvent[]): Generator<ShippedEvent[]> {
  let batch: ShippedEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 26;
    const first = batch[0];
    if (
      first !== undefined &&
      (batch.length >= BATCH_EVENTS_MAX ||
        bytes + size > BATCH_BYTES_MAX ||
        event.atMs - first.atMs > BATCH_SPAN_MS)
    ) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}

function readCursor(path: string): Cursor {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : { files: {} };
  } catch {
    return { files: {} };
  }
}

function writeCursor(path: string, cursor: Cursor): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(cursor), { mode: 0o600 });
  renameSync(temporary, path);
}

// ---------------------------------------------------------------- AWS access

const IMDS = "http://169.254.169.254";

/** IMDSv2: this instance's region, id, `clankie:tenant-id` tag and role credentials. */
export function createInstanceMetadata(fetchImpl: typeof fetch = fetch) {
  const token = async () => {
    const response = await fetchImpl(`${IMDS}/latest/api/token`, {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": "300" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`instance metadata token: HTTP ${response.status}`);
    return response.text();
  };
  const get = async (path: string, session: string) => {
    const response = await fetchImpl(`${IMDS}/latest/${path}`, {
      headers: { "x-aws-ec2-metadata-token": session },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`instance metadata ${path}: HTTP ${response.status}`);
    return (await response.text()).trim();
  };
  return {
    async identity(): Promise<BodyIdentity> {
      const session = await token();
      const tenantId = await get("meta-data/tags/instance/clankie:tenant-id", session);
      if (!TENANT_ID.test(tenantId)) throw new Error("instance has no valid clankie:tenant-id tag");
      return {
        region: await get("meta-data/placement/region", session),
        instanceId: await get("meta-data/instance-id", session),
        tenantId,
      };
    },
    async credentials(): Promise<AwsCredentials> {
      const session = await token();
      const role = (await get("meta-data/iam/security-credentials/", session)).split("\n")[0] ?? "";
      if (role.length === 0) throw new Error("instance has no role");
      const raw = JSON.parse(await get(`meta-data/iam/security-credentials/${role}`, session)) as Record<
        string,
        unknown
      >;
      if (typeof raw.AccessKeyId !== "string" || typeof raw.SecretAccessKey !== "string") {
        throw new Error("instance role returned no credentials");
      }
      return {
        accessKeyId: raw.AccessKeyId,
        secretAccessKey: raw.SecretAccessKey,
        ...(typeof raw.Token === "string" ? { sessionToken: raw.Token } : {}),
        ...(typeof raw.Expiration === "string" ? { expiresAtMs: Date.parse(raw.Expiration) } : {}),
      };
    },
  };
}

type SourceData = string | ArrayBuffer | ArrayBufferView;
const bytesOf = (data: SourceData): string | Uint8Array =>
  typeof data === "string"
    ? data
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

/** The signer's hash, on node:crypto. */
class Sha256 {
  private readonly secret: string | Uint8Array | undefined;
  private hash: Hash | Hmac;
  public constructor(secret?: SourceData) {
    this.secret = secret === undefined ? undefined : bytesOf(secret);
    this.hash = this.fresh();
  }
  public update(chunk: SourceData): void {
    this.hash.update(bytesOf(chunk));
  }
  public digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }
  public reset(): void {
    this.hash = this.fresh();
  }
  private fresh(): Hash | Hmac {
    return this.secret === undefined ? createHash("sha256") : createHmac("sha256", this.secret);
  }
}

/** CloudWatch Logs `CreateLogStream` + `PutLogEvents`, signed with SigV4. */
export function createCloudWatchLogSink(input: {
  readonly region: string;
  readonly logGroup: string;
  readonly credentials: () => Promise<AwsCredentials>;
  readonly fetch?: typeof fetch;
}): LogSink {
  const fetchImpl = input.fetch ?? fetch;
  const hostname = `logs.${input.region}.amazonaws.com`;
  const signer = new SignatureV4({
    service: "logs",
    region: input.region,
    credentials: input.credentials,
    sha256: Sha256,
  });
  const created = new Set<string>();
  const call = async (target: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname,
      path: "/",
      query: {},
      headers: {
        host: hostname,
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `Logs_20140328.${target}`,
      },
      body,
    });
    const response = await fetchImpl(`https://${hostname}/`, {
      method: "POST",
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return undefined;
    const error = (await response.json().catch(() => ({}))) as { __type?: unknown };
    return typeof error.__type === "string" ? error.__type.split("#").pop() : `HTTP ${response.status}`;
  };
  return {
    async put(stream, events) {
      if (!created.has(stream)) {
        const error = await call("CreateLogStream", { logGroupName: input.logGroup, logStreamName: stream });
        if (error !== undefined && error !== "ResourceAlreadyExistsException")
          throw new Error(`CreateLogStream: ${error}`);
        created.add(stream);
      }
      const error = await call("PutLogEvents", {
        logGroupName: input.logGroup,
        logStreamName: stream,
        logEvents: events.map((event) => ({ timestamp: event.atMs, message: JSON.stringify(event) })),
      });
      if (error !== undefined) throw new Error(`PutLogEvents: ${error}`);
    },
  };
}
