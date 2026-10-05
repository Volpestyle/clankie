import {
  ActivityShareScopeSchema,
  ActivityShareSourceSchema,
  type ActivityShareProducerMessage,
  type ActivityShareScope,
  type ActivityShareSession,
  type ActivityShareSource,
} from "@clankie/interactive-environment";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ReadableStream } from "node:stream/web";
import { ActivityShareHub, type RenderedSurfaceHubOptions, type RenderedSurfaceViewer } from "./frame-hub.ts";

export interface ActivityShareRegistryOptions {
  maxShares?: number;
  maxGuildBindings?: number;
  maxGrantsPerShare?: number;
  shareTtlMs?: number;
  maxShareTtlMs?: number;
  grantTtlMs?: number;
  maxGrantTtlMs?: number;
  hubOptions?: RenderedSurfaceHubOptions;
  now?: () => number;
}

export class ActivityShareError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

interface ShareRecord {
  session: ActivityShareSession;
  producerToken: string;
  producer: ActivityShareProducer | null;
  hub: ActivityShareHub;
  grants: Map<string, { generation: number; expiresAt: number }>;
  viewers: Map<
    RenderedSurfaceViewer,
    {
      grant: string | undefined;
      expiresAt: number;
      wrapper: RenderedSurfaceViewer;
      expiry: ReturnType<typeof setTimeout>;
    }
  >;
  expiry: ReturnType<typeof setTimeout>;
}

export interface ActivityShareProducer {
  close(): void;
}

export interface ActivityShareProducerLease {
  publish(message: ActivityShareProducerMessage): void;
  disconnect(): void;
}

/**
 * Ephemeral media authority, owned by the private control listener. Scope is
 * supplied by its authenticated host, never by a viewer. Tokens cannot restore
 * a stopped share; each new share has a fresh, unguessable identity.
 */
export class ActivityShareRegistry {
  private readonly shares = new Map<string, ShareRecord>();
  private readonly guildBindings = new Map<string, { tenantId: string; installationId: string }>();
  private readonly maxShares: number;
  private readonly maxGuildBindings: number;
  private readonly maxGrantsPerShare: number;
  private readonly shareTtlMs: number;
  private readonly maxShareTtlMs: number;
  private readonly grantTtlMs: number;
  private readonly maxGrantTtlMs: number;
  private readonly now: () => number;
  private readonly hubOptions: RenderedSurfaceHubOptions;

  public constructor(options: ActivityShareRegistryOptions = {}) {
    this.maxShares = positiveLimit(options.maxShares ?? 8, 8);
    this.maxGuildBindings = positiveLimit(options.maxGuildBindings ?? 256, 256);
    this.maxGrantsPerShare = positiveLimit(options.maxGrantsPerShare ?? 64, 64);
    this.maxShareTtlMs = positiveLimit(options.maxShareTtlMs ?? 7_200_000, 7_200_000);
    this.shareTtlMs = positiveLimit(options.shareTtlMs ?? 1_800_000, this.maxShareTtlMs);
    this.maxGrantTtlMs = positiveLimit(options.maxGrantTtlMs ?? 300_000, 300_000);
    this.grantTtlMs = positiveLimit(options.grantTtlMs ?? 300_000, this.maxGrantTtlMs);
    this.now = options.now ?? Date.now;
    this.hubOptions = options.hubOptions ?? {};
  }

  public create(
    scope: ActivityShareScope,
    source: ActivityShareSource,
    ttlMs?: number,
  ): {
    session: ActivityShareSession;
    producerToken: string;
  } {
    const parsedScope = ActivityShareScopeSchema.safeParse(scope);
    const parsedSource = ActivityShareSourceSchema.safeParse(source);
    if (!parsedScope.success || !parsedSource.success) throw new ActivityShareError("invalid_share", 400);
    const lifetime = positiveLimit(ttlMs ?? this.shareTtlMs, this.maxShareTtlMs);
    this.expire();
    const binding = this.guildBindings.get(scope.guildId);
    if (binding !== undefined && binding.tenantId !== scope.tenantId) {
      throw new ActivityShareError("guild_tenant_conflict", 409);
    }
    if (binding === undefined && this.guildBindings.size >= this.maxGuildBindings) {
      throw new ActivityShareError("guild_binding_limit", 409);
    }
    if (binding !== undefined && binding.installationId !== scope.installationId) {
      // A new installation invalidates every old producer, admission, and
      // viewer for this guild before the replacement becomes visible.
      for (const record of this.shares.values()) {
        if (record.session.scope.guildId === scope.guildId) this.end(record, "session_ended");
      }
    }
    if (this.shares.size >= this.maxShares) throw new ActivityShareError("share_limit", 409);
    this.guildBindings.set(scope.guildId, {
      tenantId: scope.tenantId,
      installationId: scope.installationId,
    });
    const session: ActivityShareSession = {
      shareId: randomUUID(),
      generation: 1,
      scope: parsedScope.data,
      source: parsedSource.data,
      expiresAt: new Date(this.now() + lifetime).toISOString(),
    };
    const record: ShareRecord = {
      session,
      producerToken: secret(),
      producer: null,
      hub: new ActivityShareHub(session, this.hubOptions),
      grants: new Map(),
      viewers: new Map(),
      expiry: setTimeout(() => this.end(record, "expired"), lifetime),
    };
    record.expiry.unref();
    this.shares.set(session.shareId, record);
    return { session: structuredClone(session), producerToken: record.producerToken };
  }

  public list(): { sessions: ActivityShareSession[] } {
    this.expire();
    return { sessions: [...this.shares.values()].map((record) => structuredClone(record.session)) };
  }

  public stats(): Array<{
    shareId: string;
    generation: number;
    viewerCount: number;
    droppedFrameCount: number;
    droppedAudioPacketCount: number;
    droppedUpdateCount: number;
  }> {
    this.expire();
    return [...this.shares.values()].map((record) => ({
      shareId: record.session.shareId,
      generation: record.session.generation,
      ...record.hub.stats(),
    }));
  }

  public switch(
    shareId: string,
    generation: number,
    source: ActivityShareSource,
  ): {
    session: ActivityShareSession;
    producerToken: string;
  } {
    const parsed = ActivityShareSourceSchema.safeParse(source);
    if (!parsed.success) throw new ActivityShareError("invalid_source", 400);
    const record = this.current(shareId, generation);
    if (!Number.isSafeInteger(generation + 1)) throw new ActivityShareError("generation_limit", 409);
    const previous = record.producer;
    record.producer = null;
    record.producerToken = secret();
    record.grants.clear();
    record.session = { ...record.session, generation: generation + 1, source: parsed.data };
    record.hub.reset(record.session);
    previous?.close();
    return { session: structuredClone(record.session), producerToken: record.producerToken };
  }

  public grant(
    shareId: string,
    generation: number,
    ttlMs?: number,
  ): {
    grant: string;
    expiresAt: string;
  } {
    const lifetime = positiveLimit(ttlMs ?? this.grantTtlMs, this.maxGrantTtlMs);
    const record = this.current(shareId, generation);
    for (const [key, value] of record.grants) {
      if (value.expiresAt <= this.now()) record.grants.delete(key);
    }
    if (record.grants.size >= this.maxGrantsPerShare) throw new ActivityShareError("grant_limit", 409);
    const grant = secret();
    const expiresAt = Math.min(this.now() + lifetime, Date.parse(record.session.expiresAt));
    record.grants.set(grant, { generation, expiresAt });
    return { grant, expiresAt: new Date(expiresAt).toISOString() };
  }

  public stop(shareId: string, generation: number): { stopped: true } {
    this.end(this.current(shareId, generation), "operator_stop");
    return { stopped: true };
  }

  public admit(shareId: string, grant: string, viewer: RenderedSurfaceViewer): boolean {
    this.expire();
    const record = this.shares.get(shareId);
    if (record === undefined || record.viewers.has(viewer)) return false;
    // Never use a browser-provided scope or a control bearer as admission.
    // Iterate the bounded grant set and compare secrets without prefix leaks.
    let admitted = false;
    for (const [secretGrant, value] of record.grants) {
      if (
        sameSecret(secretGrant, grant) &&
        value.generation === record.session.generation &&
        value.expiresAt > this.now()
      ) {
        admitted = true;
        break;
      }
    }
    if (!admitted) return false;
    const admission = record.grants.get(grant)!;
    return this.admitUntil(record, viewer, admission.expiresAt, grant);
  }

  private admitUntil(
    record: ShareRecord,
    viewer: RenderedSurfaceViewer,
    expiresAt: number,
    grant?: string,
  ): boolean {
    if (record.viewers.has(viewer)) return false;
    const shareId = record.session.shareId;
    const close = () => {
      this.removeViewer(shareId, viewer);
      viewer.close();
    };
    const wrapper: RenderedSurfaceViewer = {
      send: (payload) => {
        if (expiresAt <= this.now()) close();
        else viewer.send(payload);
      },
      get bufferedAmount() {
        return viewer.bufferedAmount;
      },
      close,
    };
    const expiry = setTimeout(close, expiresAt - this.now());
    expiry.unref();
    record.viewers.set(viewer, { grant, expiresAt, wrapper, expiry });
    if (record.hub.addViewer(wrapper)) return true;
    this.removeViewer(shareId, viewer);
    return false;
  }

  public removeViewer(shareId: string, viewer: RenderedSurfaceViewer): void {
    const record = this.shares.get(shareId);
    const admission = record?.viewers.get(viewer);
    if (record === undefined || admission === undefined) return;
    clearTimeout(admission.expiry);
    record.viewers.delete(viewer);
    record.hub.removeViewer(admission.wrapper);
  }

  /** Trusted audience revocation also terminates sockets already using the grant. */
  public revokeGrant(shareId: string, grant: string): void {
    const record = this.shares.get(shareId);
    if (record === undefined) return;
    record.grants.delete(grant);
    for (const [viewer, admission] of record.viewers) {
      if (admission.grant === undefined || !sameSecret(admission.grant, grant)) continue;
      this.removeViewer(shareId, viewer);
      viewer.close();
    }
  }

  /** Private, bounded media projection; cancellation releases the audience slot. */
  public openViewer(shareId: string, generation: number, grant: string): ReadableStream<Uint8Array> {
    this.current(shareId, generation);
    return this.viewerStream(shareId, (viewer) => this.admit(shareId, grant, viewer));
  }

  /** Controller bearer is checked by the private listener; caller enforces live audience authority. */
  public openViewerFromController(shareId: string, generation: number): ReadableStream<Uint8Array> {
    const record = this.current(shareId, generation);
    return this.viewerStream(shareId, (viewer) =>
      this.admitUntil(record, viewer, Date.parse(record.session.expiresAt)),
    );
  }

  private viewerStream(
    shareId: string,
    admit: (viewer: RenderedSurfaceViewer) => boolean,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let viewer: RenderedSurfaceViewer;
    let closed = false;
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          viewer = {
            send: (payload) => {
              if (!closed) controller.enqueue(encoder.encode(`${payload}\n`));
            },
            get bufferedAmount() {
              return Math.max(0, 512 * 1024 - (controller.desiredSize ?? 0));
            },
            close: () => {
              if (closed) return;
              closed = true;
              this.removeViewer(shareId, viewer);
              controller.close();
            },
          };
          if (!admit(viewer)) {
            closed = true;
            throw new ActivityShareError("admission_denied", 403);
          }
        },
        cancel: () => {
          closed = true;
          this.removeViewer(shareId, viewer);
        },
      },
      { highWaterMark: 512 * 1024, size: (chunk) => chunk.byteLength },
    );
  }

  public acquireProducer(
    shareId: string,
    token: string,
    producer: ActivityShareProducer,
  ): ActivityShareProducerLease {
    this.expire();
    const record = this.shares.get(shareId);
    if (record === undefined || !sameSecret(record.producerToken, token)) {
      throw new ActivityShareError("producer_denied", 403);
    }
    // A generation is never reattached: reconnecting an uncertain producer
    // must not replay queued old media or restart its sequence counters.
    if (record.producer !== null) throw new ActivityShareError("producer_already_attached", 409);
    record.producer = producer;
    const generation = record.session.generation;
    const owns = () => {
      // Enforce the deadline even if the event loop has not dispatched its
      // expiry callback yet (or a test clock has advanced independently).
      this.expire();
      return (
        this.shares.get(shareId) === record &&
        record.producer === producer &&
        record.session.generation === generation
      );
    };
    return {
      publish: (message) => {
        if (!owns()) return;
        if (message.shareId !== shareId || message.generation !== generation) return;
        if (message.kind === "stopped") this.end(record, message.reason);
        else record.hub.publish(message);
      },
      disconnect: () => {
        if (owns()) this.end(record, "session_ended");
      },
    };
  }

  public close(): void {
    for (const record of this.shares.values()) this.end(record, "session_ended");
    this.guildBindings.clear();
  }

  public expire(): void {
    for (const record of this.shares.values()) {
      if (Date.parse(record.session.expiresAt) <= this.now()) this.end(record, "expired");
      else
        for (const [viewer, admission] of record.viewers) {
          if (admission.expiresAt > this.now()) continue;
          this.removeViewer(record.session.shareId, viewer);
          viewer.close();
        }
    }
  }

  private current(shareId: string, generation: number): ShareRecord {
    this.expire();
    const record = this.shares.get(shareId);
    if (record === undefined) throw new ActivityShareError("share_gone", 404);
    if (!Number.isSafeInteger(generation) || record.session.generation !== generation) {
      throw new ActivityShareError("generation_conflict", 409);
    }
    return record;
  }

  private end(record: ShareRecord, reason: "operator_stop" | "session_ended" | "expired"): void {
    if (this.shares.get(record.session.shareId) !== record) return;
    this.shares.delete(record.session.shareId);
    clearTimeout(record.expiry);
    record.grants.clear();
    record.hub.stop(reason);
    for (const admission of record.viewers.values()) clearTimeout(admission.expiry);
    record.viewers.clear();
    const producer = record.producer;
    record.producer = null;
    producer?.close();
  }
}

function positiveLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ActivityShareError("invalid_limit", 400);
  }
  return value;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function sameSecret(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
}
