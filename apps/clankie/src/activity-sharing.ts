import { randomUUID } from "node:crypto";
import { ActivityShareFrameSchema, type ActivityShareSession } from "@clankie/interactive-environment";
import { createActivityShareClient, type ActivityShareSink } from "@clankie/rendered-surface-client";
import { z } from "zod";
import type { DeliveredFileStore } from "./delivered-files.ts";

const artifact = {
  conversationId: z.string().min(1).max(256),
  artifactId: z.string().regex(/^[a-f0-9]{48}$/u),
};
const reference = { shareId: z.string().uuid(), generation: z.number().int().positive() };
interface ActivitySharingOptions {
  files: Pick<DeliveredFileStore, "read">;
  token: () => Promise<string | undefined>;
  url: string;
  tenantId?: string;
}
export const ActivitySharingRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("image"),
      ...artifact,
      guildId: z.string().regex(/^[0-9]{1,32}$/u),
      channelId: z.string().regex(/^[0-9]{1,32}$/u),
      ttlMs: z.number().int().positive().max(7_200_000).optional(),
    })
    .strict(),
  z.object({ action: z.literal("switch"), ...reference, ...artifact }).strict(),
  z.object({ action: z.literal("stop"), ...reference }).strict(),
  z.object({ action: z.literal("grant"), ...reference }).strict(),
]);

/** Owner-only media projection. An artifact ID is resolved in its exact conversation. */
export class ActivitySharing {
  private readonly installationId = randomUUID();
  private readonly active = new Map<string, { session: ActivityShareSession; sink: ActivityShareSink }>();
  private client: ReturnType<typeof createActivityShareClient> | undefined;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingRequests = 0;
  private readonly options: ActivitySharingOptions;

  public constructor(options: ActivitySharingOptions) {
    this.options = options;
  }

  public request(
    input: z.infer<typeof ActivitySharingRequestSchema>,
    authorize: () => Promise<boolean>,
  ): Promise<unknown> {
    if (this.pendingRequests >= 16) return Promise.reject(new Error("activity_share_busy"));
    this.pendingRequests += 1;
    const operation = this.chain
      .then(() => this.execute(input, authorize))
      .finally(() => {
        this.pendingRequests -= 1;
      });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  public close(): void {
    this.closed = true;
    for (const { sink } of this.active.values()) sink.close();
    this.active.clear();
    this.client?.close();
  }

  private async execute(
    input: z.infer<typeof ActivitySharingRequestSchema>,
    authorize: () => Promise<boolean>,
  ): Promise<unknown> {
    if (this.closed) throw new Error("activity_sharing_unavailable");
    if (!(await authorize())) throw new Error("operator_authentication_required");
    for (const [id, value] of this.active) {
      if (Date.parse(value.session.expiresAt) <= Date.now() || !value.sink.connected) {
        value.sink.close();
        this.active.delete(id);
      }
    }
    if (input.action === "list") return { sessions: [...this.active.values()].map(({ session }) => session) };
    if (this.client === undefined) {
      const token = await this.options.token();
      if (token === undefined) throw new Error("activity_sharing_unavailable");
      this.client = createActivityShareClient({ url: this.options.url, token });
    }
    const client = this.client;
    if (input.action === "image" || input.action === "switch") {
      // No browser-supplied URL/path or capture permission crosses this seam.
      const found = await this.options.files.read(input.conversationId, input.artifactId);
      if (found === undefined || found.file.mediaType !== "image/png")
        throw new Error("activity_artifact_unavailable");
      const frame = ActivityShareFrameSchema.parse({
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
      if (!(await authorize()) || this.closed) throw new Error("operator_authentication_required");
      const source = { kind: "image" as const, id: input.artifactId, title: found.file.filename };
      let session: ActivityShareSession;
      if (input.action === "image") {
        if (this.active.size >= 8) throw new Error("activity_share_capacity");
        session = await client.start({
          scope: {
            tenantId: this.options.tenantId ?? "local",
            installationId: this.installationId,
            guildId: input.guildId,
            channelId: input.channelId,
          },
          source,
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        });
      } else {
        const current = this.current(input.shareId, input.generation);
        session = await client.switchSource(current.session, source);
        current.sink.close();
      }
      const sink = client.sink(session);
      this.active.set(session.shareId, { session, sink });
      const deadline = Date.now() + 3_000;
      while (!sink.connected && !this.closed && Date.now() < deadline)
        await new Promise<void>((done) => setTimeout(done, 10));
      if (!sink.connected || this.closed || !(await authorize())) {
        sink.close();
        this.active.delete(session.shareId);
        throw new Error("activity_producer_unavailable");
      }
      sink.publishFrame(frame);
      return { session };
    }
    const current = this.current(input.shareId, input.generation);
    if (!(await authorize()) || this.closed) throw new Error("operator_authentication_required");
    if (input.action === "grant") return client.grant(current.session);
    await client.stop(current.session);
    current.sink.close();
    this.active.delete(input.shareId);
    return { stopped: true };
  }

  private current(id: string, generation: number) {
    const current = this.active.get(id);
    if (current === undefined) throw new Error("activity_share_gone");
    if (current.session.generation !== generation) throw new Error("activity_share_generation_conflict");
    return current;
  }
}
