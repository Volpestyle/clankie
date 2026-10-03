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
import type { BodyLeaseResult, EmbodimentIntent, EmbodimentSubmitResult } from "@clankie/protocol";
import { z } from "zod";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import type { BodyLeaseStore } from "./body-leases.ts";
import type { EmbodimentManager } from "./embodiment.ts";
import {
  WorldPlayerClient,
  WorldPlayerPersistedSessionSchema,
  type WorldPlayerPersistedSession,
  type WorldPlayerTransport,
} from "@pokeagents/world-protocol/ipc";
import { isRefusal } from "@pokeagents/world-protocol";

type Ref = NonNullable<ReturnType<BodyLeaseStore["recoveryReference"]>>;
const RefSchema = z.strictObject({
  resource: z.literal("play"),
  conversationId: z.string().min(1),
  token: z.uuid(),
});
const RecordSchema = z.strictObject({
  reference: RefSchema,
  operationId: z.uuid(),
  finished: z.boolean(),
  world: z.strictObject({ target: z.string().min(1), state: WorldPlayerPersistedSessionSchema }).optional(),
});
const StateSchema = z.strictObject({ sessions: z.record(z.string(), RecordSchema) });
type Refusal = Extract<BodyLeaseResult, { outcome: "rejected" | "busy" }>;

class PlayLeaseDenied extends Error {
  public readonly result: Refusal;
  public constructor(result: Refusal) {
    super("Play body authority is unavailable");
    this.result = result;
  }
}

/** The host owns termination evidence. Session reports and deadlines never free the controls. */
export class BodyPlaySessions {
  private state: z.infer<typeof StateSchema> = { sessions: {} };
  private unavailable = false;
  private readonly authority = new Map<string, BodyConversationIdentity["authorize"]>();
  private readonly restartClaims = new Map<string, Ref>();
  private readonly store: BodyLeaseStore;
  private readonly path: string;
  public constructor(store: BodyLeaseStore, path: string) {
    this.store = store;
    this.path = path;
    try {
      if (existsSync(path)) this.state = StateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      const claim = store.recoveryReference("play");
      for (const [sessionId, record] of Object.entries(this.state.sessions)) {
        if (!record.finished && claim?.conversationId === record.reference.conversationId)
          this.restartClaims.set(sessionId, claim);
      }
    } catch {
      this.unavailable = true;
    }
  }

  public async submit(
    intent: EmbodimentIntent,
    identity: BodyConversationIdentity | undefined,
    manager: EmbodimentManager,
  ): Promise<EmbodimentSubmitResult> {
    try {
      await this.admit(identity);
      const owner = identity!;
      return await manager.submit(intent, {
        guard: async () => {
          await this.admit(owner);
          if (intent.kind === "stop") await this.guardOwner(owner, intent.sessionId);
        },
        beforeStart: async (sessionId) => {
          await this.admit(owner);
          const existing = this.state.sessions[sessionId];
          if (existing !== undefined) {
            await this.guardOwner(owner, sessionId);
            return;
          }
          const acquired = this.store.acquire("play", owner.conversationId, 30_000, owner.route);
          if (acquired.outcome === "busy")
            throw new PlayLeaseDenied({ ...acquired, actions: ["queue", "ask"] });
          if (acquired.outcome !== "acquired") throw new PlayLeaseDenied(acquired);
          const begun = this.store.begin(acquired.lease);
          if (begun.outcome !== "admitted") throw new PlayLeaseDenied(begun);
          this.state.sessions[sessionId] = {
            reference: acquired.lease as Ref & { resource: "play" },
            operationId: begun.operationId,
            finished: false,
          };
          this.save(); // Before the durable requested session becomes claimable.
          this.authority.set(sessionId, owner.authorize);
          try {
            await this.admit(owner);
          } catch (error) {
            this.settle(sessionId, true);
            throw error;
          }
        },
      });
    } catch (error) {
      if (!(error instanceof PlayLeaseDenied)) throw error;
      return {
        outcome: "refused",
        reason: error.result.outcome === "busy" ? "play_session_active" : "policy",
        ...(intent.kind === "stop" ? { sessionId: intent.sessionId } : {}),
        bodyLease: error.result,
      };
    }
  }

  /** Ongoing execution retains the original grant, independent of the next turn's capture. */
  public async guard(sessionId: string): Promise<void> {
    if (this.unavailable) throw new PlayLeaseDenied({ outcome: "rejected", reason: "store_unavailable" });
    const record = this.state.sessions[sessionId];
    const authorize = this.authority.get(sessionId);
    if (record === undefined || record.finished || authorize === undefined)
      throw new PlayLeaseDenied({ outcome: "rejected", reason: "identity_required" });
    if (!(await this.allowed(authorize)))
      throw new PlayLeaseDenied({ outcome: "rejected", reason: "not_authorized" });
    const valid = this.store.validate(record.reference, record.operationId);
    if (valid.outcome !== "valid") throw new PlayLeaseDenied(valid);
    const renewed = this.store.renew(record.reference, 30_000);
    if (renewed.outcome !== "renewed") throw new PlayLeaseDenied(renewed);
  }

  public async guardOwner(identity: BodyConversationIdentity | undefined, sessionId?: string): Promise<void> {
    await this.admit(identity);
    const claim = this.store.recoveryReference("play");
    const selected =
      sessionId ??
      Object.entries(this.state.sessions).find(
        ([, record]) => !record.finished && record.reference.token === claim?.token,
      )?.[0];
    const record = selected === undefined ? undefined : this.state.sessions[selected];
    if (
      record === undefined ||
      record.finished ||
      record.reference.conversationId !== identity!.conversationId
    )
      throw new PlayLeaseDenied(
        claim === undefined
          ? { outcome: "rejected", reason: "stale_lease" }
          : { outcome: "busy", lease: this.store.status("play")!, actions: ["queue", "ask"] },
      );
    await this.guard(selected!);
    await this.admit(identity);
  }

  /** Called only after the actual executor has settled, with its observed cleanup evidence. */
  public settle(sessionId: string, confirmed: boolean): void {
    const record = this.state.sessions[sessionId];
    if (this.unavailable || record === undefined || record.finished) return;
    const expected = this.restartClaims.get(sessionId) ?? record.reference;
    const current = this.store.recoveryReference("play");
    if (current?.token !== expected.token || current.conversationId !== expected.conversationId) return;
    if (!confirmed) {
      this.store.finish(current, record.operationId, "uncertain");
      return;
    }
    record.finished = true;
    delete record.world;
    this.save(); // The observed stop is durable before ownership is released.
    if (current.token === record.reference.token) this.store.finish(current, record.operationId, "settled");
    this.store.reconcileStopped(current); // An enclosing recovery pin may still hold it.
    this.authority.delete(sessionId);
  }

  public uncertain(sessionId: string): void {
    const record = this.state.sessions[sessionId];
    if (!this.unavailable && record !== undefined && !record.finished)
      this.store.finish(record.reference, record.operationId, "uncertain");
  }

  public stopped(): boolean {
    return !this.unavailable && Object.values(this.state.sessions).every((record) => record.finished);
  }

  /** Private native client state, bound before the joined session can perform an action. */
  public rememberWorldSession(
    sessionId: string,
    target: string,
    state: WorldPlayerPersistedSession | undefined,
  ): void {
    if (state === undefined) return; // Losing authentication is not proof that the remote session ended.
    const record = this.state.sessions[sessionId];
    if (this.unavailable || record === undefined || record.finished)
      throw new Error("Play session ownership is unavailable");
    const valid = this.store.validate(record.reference, record.operationId);
    if (valid.outcome !== "valid") throw new Error("Play session incarnation changed");
    record.world = { target, state: WorldPlayerPersistedSessionSchema.parse(state) };
    this.save();
  }

  /** The caller first settles the local executor. Only exact session-bound world replies reconcile a restart. */
  public async recover(guard: () => Promise<void>, transport?: WorldPlayerTransport): Promise<boolean> {
    if (this.unavailable) return false;
    for (const [sessionId, record] of Object.entries(this.state.sessions)) {
      if (record.finished) continue;
      const world = record.world;
      if (world === undefined) return false; // A lost join receipt remains uncertain.
      const expected = this.restartClaims.get(sessionId) ?? record.reference;
      await guard();
      const current = this.store.recoveryReference("play");
      if (current?.token !== expected.token || current.conversationId !== expected.conversationId)
        return false;
      const client = new WorldPlayerClient({
        target: world.target,
        sessionPersistence: { load: () => world.state },
        ...(transport === undefined ? {} : { transport }),
      });
      try {
        const reply = await client.call("world.leave", {});
        if (
          isRefusal(reply)
            ? !["session_ended", "not_your_session"].includes(reply.code)
            : reply.sessionId !== world.state.session.sessionId
        )
          return false;
        await guard();
        this.settle(sessionId, true);
      } catch {
        return false;
      }
    }
    return this.stopped();
  }

  private async admit(identity: BodyConversationIdentity | undefined): Promise<void> {
    if (this.unavailable) throw new PlayLeaseDenied({ outcome: "rejected", reason: "store_unavailable" });
    if (identity === undefined || !identity.current())
      throw new PlayLeaseDenied({ outcome: "rejected", reason: "identity_required" });
    if (!(await this.allowed(identity.authorize)))
      throw new PlayLeaseDenied({ outcome: "rejected", reason: "not_authorized" });
    if (!identity.current()) throw new PlayLeaseDenied({ outcome: "rejected", reason: "identity_required" });
  }

  private async allowed(authorize: BodyConversationIdentity["authorize"]): Promise<boolean> {
    try {
      return await authorize("play", "effect");
    } catch {
      return false;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(file, JSON.stringify(this.state));
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, this.path);
      const directory = openSync(dirname(this.path), "r");
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
}
