import { randomUUID } from "node:crypto";
import {
  ActivityShareFrameSchema,
  ActivityShareScopeSchema,
  ActivityShareSessionSchema,
  ActivityShareSourceSchema,
  type ActivityShareFrame,
  type ActivityShareScope,
  type ActivityShareSession,
  type ActivityShareSource,
} from "@clankie/interactive-environment";
import {
  createActivityShareClient,
  createActivityShareFrameSink,
  type ActivityFrameSink,
  type ActivityShareSink,
} from "@clankie/rendered-surface-client";
import { z } from "zod";
import type { DeliveredFileStore } from "./delivered-files.ts";

import { ActivitySharingRequestSchema } from "@clankie/protocol/activity-sharing";
export { ActivitySharingRequestSchema } from "@clankie/protocol/activity-sharing";

export const ActivitySharingReceiptSchema = z
  .object({
    outcome: z.enum(["confirmed", "refused", "uncertain"]),
    receiptId: z.string().uuid(),
    session: ActivityShareSessionSchema,
    inviteUrl: z
      .string()
      .regex(/^https:\/\/discord\.gg\/[A-Za-z0-9-]+$/u)
      .optional(),
  })
  .strict();
export type ActivitySharingReceipt = z.infer<typeof ActivitySharingReceiptSchema>;

export interface ActivitySharingSource {
  source: ActivityShareSource;
  /** Attach an existing authorized producer; return its detach callback promptly. */
  attach(
    sink: ActivityFrameSink,
    scopedSink: ActivityShareSink,
  ): Promise<(() => void) | void> | (() => void) | void;
}
export interface ActivitySharingOptions {
  files: Pick<DeliveredFileStore, "read">;
  token: () => Promise<string | undefined>;
  url: string;
  tenantId?: string;
  installationId?: string;
  fetch?: typeof fetch;
  sources?: { resolve(sourceId: string): Promise<ActivitySharingSource | undefined> };
  authorizeDestination?: (scope: ActivityShareScope) => Promise<boolean>;
  launch?: (session: ActivityShareSession, requestId: string) => Promise<ActivitySharingReceipt>;
  stop?: (session: ActivityShareSession, requestId: string) => Promise<ActivitySharingReceipt>;
  onBusyChange?: (active: boolean) => void;
}
interface ActiveShare {
  session: ActivityShareSession;
  sink: ActivityShareSink;
  detach?: () => void;
}

/** Supplied authority selects existing media; source IDs never grant capture permissions. */
export class ActivitySharing {
  private readonly installationId: string;
  private readonly tenantId: string;
  private readonly active = new Map<string, ActiveShare>();
  private client: ReturnType<typeof createActivityShareClient> | undefined;
  private closed = false;
  private busy = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingRequests = 0;
  private readonly options: ActivitySharingOptions;

  public constructor(options: ActivitySharingOptions) {
    if (options.tenantId !== undefined && options.installationId === undefined)
      throw new Error("Scoped tenants require the current installation identity");
    if (options.tenantId !== undefined && options.authorizeDestination === undefined)
      throw new Error("Scoped tenants require live destination authorization");
    this.options = options;
    this.tenantId = options.tenantId ?? "local";
    this.installationId = options.installationId ?? randomUUID();
    ActivityShareScopeSchema.parse({
      tenantId: this.tenantId,
      installationId: this.installationId,
      guildId: "1",
      channelId: "1",
    });
  }

  public request(
    input: z.infer<typeof ActivitySharingRequestSchema>,
    authorize: () => Promise<boolean>,
  ): Promise<unknown> {
    const parsed = ActivitySharingRequestSchema.parse(input);
    if (this.pendingRequests >= 16) return Promise.reject(new Error("activity_share_busy"));
    this.pendingRequests += 1;
    const operation = this.chain
      .then(() => this.execute(parsed, authorize))
      .finally(() => {
        this.pendingRequests -= 1;
      });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  /** Only the verified audience adapter supplies authority to open this media-only stream. */
  public async openViewer(
    input: ActivityShareSession,
    authorize: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const expected = ActivityShareSessionSchema.parse(input);
    if (expected.scope.tenantId !== this.tenantId || expected.scope.installationId !== this.installationId)
      throw new Error("activity_destination_refused");
    await this.admit(expected.scope, authorize);
    const current = await this.current(expected.shareId, expected.generation, authorize);
    if (JSON.stringify(expected) !== JSON.stringify(current)) throw new Error("activity_destination_refused");
    await this.admit(current.scope, authorize);
    const client = await this.getClient();
    await this.admit(current.scope, authorize);
    const response = await client.openAuthorizedViewer(current, signal);
    try {
      await this.admit(current.scope, authorize);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  }

  public close(): void {
    this.closed = true;
    const active = [...this.active.values()];
    this.active.clear();
    for (const share of active) this.release(share);
    this.client?.close();
    this.notifyBusy();
  }

  private async getClient() {
    if (this.client === undefined) {
      const token = await this.options.token();
      if (token === undefined || this.closed) throw new Error("activity_sharing_unavailable");
      this.client = createActivityShareClient({
        url: this.options.url,
        token,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        onSessionEnded: (session) => this.endLocal(session),
      });
    }
    return this.client;
  }

  private async admit(scope: ActivityShareScope, authorize: () => Promise<boolean>) {
    if (this.closed || !(await authorize())) throw new Error("operator_authentication_required");
    if (this.options.authorizeDestination !== undefined && !(await this.options.authorizeDestination(scope)))
      throw new Error("activity_destination_refused");
    if (this.closed || !(await authorize())) throw new Error("operator_authentication_required");
  }

  private async sessions(authorize: () => Promise<boolean>): Promise<ActivityShareSession[]> {
    const sessions = await (await this.getClient()).status();
    if (this.closed || !(await authorize())) throw new Error("operator_authentication_required");
    const scoped: ActivityShareSession[] = [];
    for (const session of sessions) {
      if (session.scope.tenantId !== this.tenantId || session.scope.installationId !== this.installationId)
        continue;
      try {
        await this.admit(session.scope, authorize);
      } catch (error) {
        if (error instanceof Error && error.message === "activity_destination_refused") continue;
        throw error;
      }
      scoped.push(session);
    }
    return scoped;
  }

  private async current(id: string, generation: number, authorize: () => Promise<boolean>) {
    const current = (await this.sessions(authorize)).find((session) => session.shareId === id);
    if (current === undefined) throw new Error("activity_share_gone");
    if (current.generation !== generation) throw new Error("activity_share_generation_conflict");
    return current;
  }

  private async execute(
    input: z.infer<typeof ActivitySharingRequestSchema>,
    authorize: () => Promise<boolean>,
  ): Promise<unknown> {
    if (this.closed) throw new Error("activity_sharing_unavailable");
    if (!(await authorize())) throw new Error("operator_authentication_required");
    if (input.action === "list") return { sessions: await this.sessions(authorize) };
    const client = await this.getClient();
    if (input.action === "image" || input.action === "start" || input.action === "switch") {
      let producer: ActivitySharingSource;
      let imageFrame: ActivityShareFrame | undefined;
      if (input.action === "start" || (input.action === "switch" && input.sourceId !== undefined)) {
        const resolved = await this.options.sources?.resolve(input.sourceId!);
        if (resolved === undefined) throw new Error("activity_source_unavailable");
        producer = resolved;
      } else {
        const found = await this.options.files.read(input.conversationId!, input.artifactId!);
        if (found === undefined || found.file.mediaType !== "image/png")
          throw new Error("activity_artifact_unavailable");
        imageFrame = ActivityShareFrameSchema.parse({
          schemaVersion: 2,
          sequence: 1,
          encoding: "png",
          width: found.data.length >= 24 ? found.data.readUInt32BE(16) : 0,
          height: found.data.length >= 24 ? found.data.readUInt32BE(20) : 0,
          data: found.data.toString("base64"),
          byteLength: found.data.length,
          sha256: found.file.sha256,
          capturedAt: new Date().toISOString(),
        });
        producer = {
          source: { kind: "image", id: input.artifactId!, title: found.file.filename },
          attach: () => undefined,
        };
      }
      const source = ActivityShareSourceSchema.parse(producer.source);
      const previous =
        input.action === "switch"
          ? await this.current(input.shareId, input.generation, authorize)
          : undefined;
      const scope = previous?.scope ?? {
        tenantId: this.tenantId,
        installationId: this.installationId,
        guildId: input.action === "switch" ? "" : input.guildId,
        channelId: input.action === "switch" ? "" : input.channelId,
      };
      await this.admit(scope, authorize);
      const session =
        previous === undefined
          ? await client.start({
              scope,
              source,
              ...(input.action !== "switch" && input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
            })
          : await client.switchSource(previous, source);
      const sink = client.sink(session);
      const old = this.active.get(session.shareId);
      if (old !== undefined) {
        this.active.delete(session.shareId);
        this.release(old);
      }
      const active: ActiveShare = { session, sink };
      this.active.set(session.shareId, active);
      const deadline = Date.now() + 3_000;
      while (!sink.connected && !this.closed && Date.now() < deadline)
        await new Promise<void>((done) => setTimeout(done, 10));
      try {
        if (!sink.connected) throw new Error("activity_producer_unavailable");
        await this.admit(session.scope, authorize);
        const detach = await producer.attach(createActivityShareFrameSink(sink), sink);
        if (detach !== undefined) active.detach = detach;
        if (this.active.get(session.shareId) !== active || !sink.connected) {
          this.release(active);
          throw new Error("activity_producer_unavailable");
        }
        await this.admit(session.scope, authorize);
        if (imageFrame !== undefined) sink.publishFrame(imageFrame);
        this.notifyBusy();
        const receipt = await this.effect(this.options.launch, session);
        if (receipt?.outcome === "refused") sink.close();
        return { session, ...(receipt === undefined ? {} : { receipt }) };
      } catch (error) {
        sink.close();
        throw error;
      }
    }
    const session = await this.current(input.shareId, input.generation, authorize);
    await this.admit(session.scope, authorize);
    if (input.action === "grant") return client.grant(session);
    await client.stop(session);
    this.endLocal(session);
    await this.admit(session.scope, authorize);
    const receipt = await this.effect(this.options.stop, session);
    return { stopped: true, ...(receipt === undefined ? {} : { receipt }) };
  }

  private async effect(
    hook: ActivitySharingOptions["launch"],
    session: ActivityShareSession,
  ): Promise<ActivitySharingReceipt | undefined> {
    if (hook === undefined) return undefined;
    const requestId = randomUUID();
    try {
      const receipt = ActivitySharingReceiptSchema.parse(await hook(structuredClone(session), requestId));
      if (receipt.receiptId !== requestId || JSON.stringify(receipt.session) !== JSON.stringify(session))
        throw new Error("Activity receipt does not match the dispatched effect");
      return receipt;
    } catch {
      return { outcome: "uncertain", receiptId: requestId, session: structuredClone(session) };
    }
  }

  private endLocal(session: ActivityShareSession) {
    const active = this.active.get(session.shareId);
    if (active?.session.generation !== session.generation) return;
    this.active.delete(session.shareId);
    this.release(active);
    this.notifyBusy();
  }

  private release(active: ActiveShare) {
    const detach = active.detach;
    delete active.detach;
    try {
      detach?.();
    } finally {
      active.sink.close();
    }
  }

  private notifyBusy() {
    const busy = this.active.size > 0;
    if (busy === this.busy) return;
    this.busy = busy;
    this.options.onBusyChange?.(busy);
  }
}
