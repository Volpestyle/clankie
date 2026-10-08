import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { Hono } from "hono";
import {
  rivalsExtension,
  rivalsStopped,
  type RivalsReceipt,
  type RivalsStart,
  type RivalsExtensionHost,
} from "@clankie/rivals";
import { RivalsCommandSchema, RivalsStatusSchema, type RivalsCommand } from "@clankie/protocol";
import type { GameExtensionRuntime } from "@clankie/game-extension";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import type { BodyLeaseStore } from "./body-leases.ts";
import type { InstalledGameExtensions, GameExtensionProjection } from "./game-extension-projection.ts";
import { createRivalsClient, type RivalsClient } from "./rivals.ts";
import { rivalsTools } from "./captain/rivals-tools.ts";

const RecordSchema = z.object({
  localId: z.string(),
  logicalRequestId: z.string(),
  nativeRequestId: z.string(),
  origin: z.url(),
  reference: z.object({ resource: z.literal("play"), conversationId: z.string(), token: z.uuid() }),
  receipt: z
    .object({
      id: z.string(),
      requestId: z.string(),
      startedAt: z.number(),
      execution: z.enum(["live", "replay"]),
    })
    .optional(),
  confirmed: z.boolean(),
});
type SessionRecord = z.infer<typeof RecordSchema>;
type Options = Parameters<typeof createRivalsClient>[0] & {
  store: BodyLeaseStore;
  path: string;
  registry: InstalledGameExtensions;
};

/** Core supplies authenticated authority and the one durable play ledger. */
export class RivalsService implements RivalsClient {
  private record: SessionRecord | undefined;
  private unavailable = false;
  private active: Promise<void> | undefined;
  private runtime: GameExtensionRuntime<RivalsStart, void>;
  private readonly options: Options;
  private readonly client: ReturnType<typeof createRivalsClient>;
  private registrationGuard: () => void = () => {};
  private guard: () => Promise<void> = async () => {
    throw new Error("identity_required");
  };
  private continuing = false;
  private admitted: (result: Record<string, unknown>) => void = () => {};
  constructor(options: Options) {
    this.options = options;
    this.client = createRivalsClient(options);
    try {
      if (existsSync(options.path)) {
        const saved: unknown = JSON.parse(readFileSync(options.path, "utf8"));
        if (saved !== null) {
          this.record = RecordSchema.parse(saved);
        }
      }
    } catch {
      this.unavailable = true;
    }
    this.runtime = options.registry.register(
      {
        ...rivalsExtension,
        create: (host: RivalsExtensionHost) => {
          const native = rivalsExtension.create(host);
          return {
            ...native,
            bindRegistrationGuard: (guard) => {
              native.bindRegistrationGuard?.(guard);
              this.registrationGuard = guard;
            },
            status: () =>
              this.unavailable
                ? { state: "uncertain" as const, sessionId: "unavailable" }
                : this.ownsPlay() && !this.active
                  ? { state: "uncertain" as const, sessionId: this.record!.localId }
                  : native.status(),
            health: () =>
              this.unavailable || (this.ownsPlay() && !this.active)
                ? { state: "degraded" as const, reason: "termination_unconfirmed" }
                : native.health(),
          };
        },
      },
      {
        call: (command, guard) => this.client.call(command, guard, this.record!.origin),
        remember: (receipt) => {
          this.record!.receipt = receipt;
          this.save();
          this.continuing = true;
        },
        admitted: (result) => this.admitted(result),
      },
      () => this.projection(),
    );
  }

  ownsPlay(): boolean {
    return this.unavailable || (this.record !== undefined && !this.record.confirmed);
  }

  async call(input: RivalsCommand, identity?: BodyConversationIdentity): Promise<Record<string, unknown>> {
    const parsed = RivalsCommandSchema.safeParse(input);
    if (!parsed.success) return this.refused("invalid_request");
    const command = parsed.data;
    if (this.unavailable) return this.refused("store_unavailable");
    if (command.action === "status") {
      // Discovery never clears ownership, sends a stop or replays a start.
      return this.client.call(command, undefined, this.ownsPlay() ? this.record!.origin : undefined);
    }
    try {
      this.registrationGuard();
      await this.authorize(identity);
      if (command.action === "start") {
        if (this.ownsPlay()) {
          if (
            this.record!.reference.conversationId === identity!.conversationId &&
            this.record!.logicalRequestId === command.requestId &&
            this.active
          )
            return this.client.call({ action: "status" }, undefined, this.record!.origin);
          return this.refused("play_session_active");
        }
        const origin = (await this.options.settings.load()).gameplay.rivalsUrl;
        if (!origin) return this.refused("rivals_not_configured");
        await this.authorize(identity);
        this.registrationGuard();
        const acquired = this.options.store.acquire(
          "play",
          identity!.conversationId,
          30_000,
          identity!.route,
        );
        if (acquired.outcome !== "acquired")
          return { ...this.refused("play_session_active"), bodyLease: acquired };
        const begun = this.options.store.begin(acquired.lease);
        if (begun.outcome !== "admitted") return this.refused("recovery_required");
        this.record = {
          localId: randomUUID().replaceAll("-", ""),
          logicalRequestId: command.requestId,
          nativeRequestId: randomUUID(),
          origin,
          reference: acquired.lease as SessionRecord["reference"],
          confirmed: false,
        };
        this.save(); // Persist the nonce/origin and lease before any connector dispatch.
        const record = this.record;
        this.continuing = false;
        const authorize = identity!.authorize;
        this.guard = async () => {
          this.registrationGuard();
          if (this.continuing) {
            // The sitting retains its captured grant after its admitting turn settles.
            if (!(await authorize("play", "effect"))) throw new Error("not_authorized");
          } else await this.authorize(identity);
          this.registrationGuard();
          if (
            this.record !== record ||
            this.options.store.validate(acquired.lease, begun.operationId).outcome !== "valid"
          )
            throw new Error("stale_lease");
          if (this.options.store.renew(acquired.lease, 30_000).outcome !== "renewed")
            throw new Error("recovery_required");
        };
        const admission = new Promise<Record<string, unknown>>((resolve) => {
          this.admitted = resolve;
        });
        // Reserve local admission synchronously before the registry's first awaited read.
        this.active = Promise.resolve();
        this.active = this.runtime
          .start(
            { ...command, requestId: record.nativeRequestId, sessionId: record.localId },
            {
              guard: this.guard,
              stopRequested: () => false,
              confirmStopped: () => {
                record.confirmed = true;
                this.save();
              },
            },
            async () => {
              await this.guard();
            },
          )
          .catch(() => {})
          .finally(() => {
            this.admitted(this.refused("rivals_start_unconfirmed"));
            this.options.store.finish(
              acquired.lease,
              begun.operationId,
              record.confirmed ? "settled" : "uncertain",
            );
            if (record.confirmed) this.options.store.reconcileStopped(acquired.lease);
            this.active = undefined;
          });
        return await admission;
      }
      const record = this.record;
      if (
        !record ||
        record.confirmed ||
        record.reference.conversationId !== identity!.conversationId ||
        record.receipt?.id !== command.sessionId
      )
        return this.refused("not_authorized");
      if (!this.active) return this.refused("recovery_required");
      if (command.action === "stop") {
        // The runtime's original guarded loop performs this exact scoped stop.
        return { outcome: "ok", sessionId: command.sessionId, stop: this.runtime.stop(record.localId) };
      }
      return await this.client.call(
        command,
        async () => {
          await this.authorize(identity);
          await this.guard();
        },
        record.origin,
      );
    } catch {
      return this.refused("rivals_authority_unavailable");
    }
  }

  /** Called inside BodyLeaseRouter's incarnation-fenced recovery pin. Never follows a replacement. */
  async recover(guard: () => Promise<void>): Promise<boolean> {
    if (this.unavailable || this.active) return false;
    const record = this.record;
    if (!record || record.confirmed) return true;
    const ref = this.options.store.recoveryReference("play");
    if (!ref || ref.conversationId !== record.reference.conversationId) return false;
    const fenced = async () => {
      await guard();
      if (this.record !== record || this.options.store.recoveryReference("play")?.token !== ref.token)
        throw new Error("stale_lease");
    };
    try {
      await fenced();
      let status = RivalsStatusSchema.safeParse(
        await this.client.call({ action: "status" }, fenced, record.origin),
      );
      if (!status.success || !status.data.session) return false;
      // A lost start reply may be resolved only by its persisted unguessable original nonce.
      if (!record.receipt) {
        if (status.data.session.requestId !== record.nativeRequestId) return false;
        record.receipt = {
          id: status.data.session.id,
          requestId: record.nativeRequestId,
          startedAt: status.data.session.startedAt,
          execution: status.data.execution,
        };
        this.save();
      }
      const receipt: RivalsReceipt = record.receipt;
      if (!rivalsStopped(status.data, receipt)) {
        if (
          status.data.session.id !== receipt.id ||
          status.data.session.requestId !== receipt.requestId ||
          status.data.session.startedAt !== receipt.startedAt ||
          status.data.execution !== receipt.execution
        )
          return false;
        status = RivalsStatusSchema.safeParse(
          await this.client.call({ action: "stop", sessionId: receipt.id }, fenced, record.origin),
        );
        if (!status.success || !rivalsStopped(status.data, receipt)) return false;
      }
      await fenced();
      const cleared = await this.options.registry.reconcileStopped("rivals", async () => {
        await fenced();
        return true;
      });
      if (!cleared) return false;
      record.confirmed = true;
      this.save();
      return true; // Only the outer host recovery operation releases the ledger claim.
    } catch {
      return false;
    }
  }

  async settled(): Promise<void> {
    await this.active;
  }

  async close(): Promise<void> {
    if (this.active && this.record) this.runtime.stop(this.record.localId);
    // A shutdown deadline is not cleanup evidence; the persisted claim survives it.
    await Promise.race([this.settled(), setTimeout(12_000, undefined, { ref: false })]);
  }

  private async authorize(identity: BodyConversationIdentity | undefined): Promise<void> {
    if (!identity?.current() || !(await identity.authorize("play", "effect")) || !identity.current())
      throw new Error("identity_required");
  }
  private refused(reason: string): Record<string, unknown> {
    return { outcome: "refused", reason };
  }
  private save(): void {
    try {
      mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.options.path}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(this.record ?? null));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.options.path);
      const directory = openSync(dirname(this.options.path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      this.unavailable = true;
      throw error;
    }
  }
  private projection(): GameExtensionProjection {
    return {
      tools: (turn) => rivalsTools(this, turn.bodyIdentity),
      paths: ["/v1/rivals"],
      routes: ({ authorize }) => {
        const app = new Hono();
        app.post("/v1/rivals", async (context) => {
          const identity = await authorize(context.req.raw);
          if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
          const parsed = RivalsCommandSchema.safeParse(await context.req.json().catch(() => undefined));
          if (!parsed.success) return context.json({ error: "invalid_rivals_command" }, 400);
          return context.json(await this.call(parsed.data, identity));
        });
        return app;
      },
    };
  }
}
