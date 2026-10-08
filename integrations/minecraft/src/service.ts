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
import {
  MinecraftActionIdSchema,
  MinecraftActionSchema,
  MinecraftServerProfileIdSchema,
  MinecraftSessionStatusSchema,
  type BodyLeaseResult,
  type MinecraftAction,
  type MinecraftActionStatus,
  type MinecraftActionRequest,
  type MinecraftSessionRef,
  type MinecraftSessionStatus,
  type MinecraftStatus,
} from "@clankie/protocol";
import { z } from "zod";
import { MinecraftSettingsSchema, type SettingsStore } from "@clankie/settings";
import type { GameExtensionStatus } from "@clankie/game-extension";
import type {
  MinecraftIdentity as BodyConversationIdentity,
  MinecraftLeaseAuthority as BodyLeaseStore,
  MinecraftOwnerRoute as BodyOwnerRoute,
} from "./authority.ts";
import {
  sameMinecraftSession,
  type MinecraftEvents,
  type MinecraftGuard,
  type MinecraftPort,
} from "./port.ts";

type LeaseRef = NonNullable<ReturnType<BodyLeaseStore["recoveryReference"]>>;
type LeaseRefusal = Extract<BodyLeaseResult, { outcome: "rejected" | "busy" }>;
const RecordSchema = z.strictObject({
  reference: z.strictObject({
    resource: z.literal("play"),
    conversationId: z.string().min(1),
    token: z.uuid(),
  }),
  operationId: z.uuid(),
  finished: z.boolean(),
  status: MinecraftSessionStatusSchema,
  sequence: z.number().int().nonnegative(),
});
type SessionRecord = z.infer<typeof RecordSchema>;
export type MinecraftDriver = { kind: "mind" | "owner" } | { kind: "worker"; principalId: string };
export interface MinecraftWorkerDriver {
  readonly principalId: string;
  /** The admitted fleet channel supplies this fence, never tool arguments. */
  readonly guard: MinecraftGuard;
}

export class MinecraftServiceError extends Error {
  public readonly code: string;
  public readonly bodyLease: LeaseRefusal | undefined;
  public constructor(code: string, bodyLease?: LeaseRefusal) {
    super(code);
    this.code = code;
    this.bodyLease = bodyLease;
  }
}

export interface MinecraftEventWake {
  readonly conversationId: string;
  readonly route?: BodyOwnerRoute;
  readonly session: MinecraftSessionRef;
  /** Untrusted world content. The wake must preserve this distinction in its prompt. */
  readonly events: MinecraftEvents["events"];
  readonly droppedBeforeSequence: number;
}

/** One external Minecraft stay pins the shared play lease from persisted join through exact disconnect. */
export class MinecraftService {
  private joining: { sessionId: string; cancelled: boolean } | undefined;
  private registeredStop: string | undefined;
  private record: SessionRecord | null = null;
  private unavailable = false;
  private authority: BodyConversationIdentity["authorize"] | undefined;
  private route: BodyOwnerRoute | undefined;
  private restartReference: LeaseRef | undefined;
  private pumping = false;
  private suspended = false;
  private readonly now: () => number;
  private driver: MinecraftDriver = { kind: "owner" };
  private driverGeneration = 0;
  private switchingDriver = false;

  private readonly options: {
    port: MinecraftPort;
    store: BodyLeaseStore;
    path: string;
    now?: () => number;
    onDisconnect?: (session: MinecraftSessionRef) => void;
    automaticPlay?: boolean;
    guardRegistration?: () => void;
    configuration?: {
      settings: Pick<SettingsStore, "load" | "update">;
      guard(identity: BodyConversationIdentity | undefined): Promise<() => void>;
    };
  };
  public constructor(options: MinecraftService["options"]) {
    this.options = options;
    this.now = options.now ?? Date.now;
    try {
      if (existsSync(options.path))
        this.record = RecordSchema.nullable().parse(JSON.parse(readFileSync(options.path, "utf8")));
      if (this.record !== null && !this.record.finished) {
        const current = options.store.recoveryReference("play");
        if (current?.conversationId === this.record.reference.conversationId) this.restartReference = current;
      }
    } catch {
      this.unavailable = true;
    }
  }

  public async profiles() {
    return this.options.port.profiles();
  }
  public async configuration(identity?: BodyConversationIdentity) {
    const port = this.options.configuration;
    if (!port) throw new MinecraftServiceError("minecraft_configuration_unavailable");
    const current = await port.guard(identity);
    const settings = await port.settings.load();
    current();
    return settings.minecraft;
  }

  public async configure(input: unknown, identity?: BodyConversationIdentity) {
    const port = this.options.configuration;
    if (!port) throw new MinecraftServiceError("minecraft_configuration_unavailable");
    const current = await port.guard(identity);
    const settings = MinecraftSettingsSchema.parse(input);
    current();
    const updated = await port.settings.update(
      (existing) => ({ ...existing, minecraft: settings }),
      async () => {
        (await port.guard(identity))();
      },
    );
    current();
    return updated.minecraft;
  }

  public ownsPlay(): boolean {
    return this.unavailable || (this.record !== null && !this.record.finished);
  }

  /** Local discovery never dials MCP or projects another owner's action text. */
  public lifecycleStatus(): GameExtensionStatus {
    if (this.unavailable) return { state: "uncertain", sessionId: "unavailable" };
    const record = this.record;
    if (record === null || record.finished)
      return this.joining === undefined
        ? { state: "idle" }
        : { state: this.joining.cancelled ? "stopping" : "starting", sessionId: this.joining.sessionId };
    const state =
      this.restartReference !== undefined || record.status.termination.state === "uncertain"
        ? "uncertain"
        : record.status.termination.state !== "not_requested" ||
            this.registeredStop === record.status.session.sessionId
          ? "stopping"
          : record.status.phase === "connecting"
            ? "starting"
            : "running";
    return { state, sessionId: record.status.session.sessionId };
  }

  /** Internal extension stop of a legacy API stay, using its captured fresh authority. */
  public async stopRegistered(sessionId: string): Promise<boolean> {
    const record = this.record;
    const authority = this.authority;
    if ((record === null || record.finished) && this.joining?.sessionId === sessionId) {
      this.joining.cancelled = true;
      return true;
    }
    if (
      record === null ||
      record.finished ||
      record.status.session.sessionId !== sessionId ||
      authority === undefined
    )
      return false;
    this.registeredStop = sessionId;
    this.requireAvailable();
    if (!(await this.allowed(authority))) throw new MinecraftServiceError("minecraft_not_authorized");
    return this.recover(async () => {
      this.requireAvailable();
      if (this.record !== record || this.authority !== authority || !(await this.allowed(authority)))
        throw new MinecraftServiceError("minecraft_not_authorized");
      this.requireAvailable();
      if (this.record !== record || this.authority !== authority)
        throw new MinecraftServiceError("minecraft_stale_session");
    });
  }

  /** Service teardown is a host stop; retain ownership whenever the exact motor cannot confirm end. */
  public async close(): Promise<boolean> {
    const record = this.record;
    const deadline = Date.now() + 2_000;
    do {
      if (await this.recover(async () => {})) return true;
      if (this.record !== record || record === null || this.unavailable) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    // Deadline is uncertainty, never disconnect proof. Remove the local pin while preserving recovery ownership.
    if (this.record === record && record !== null && !record.finished) {
      record.status = this.uncertainStatus(record);
      this.save();
      this.options.store.finish(record.reference, record.operationId, "uncertain");
    }
    return false;
  }

  /** Public status contains no other conversation's action/chat text. Owners can inspect their handles. */
  public async status(identity?: BodyConversationIdentity): Promise<MinecraftStatus> {
    this.requireAvailable();
    const record = this.record;
    const status = await this.options.port.status();
    if (record === null || record.finished) return { session: status.session, actions: [] };
    if (status.session === null || !sameMinecraftSession(record.status.session, status.session.session))
      return { session: this.uncertainStatus(record), actions: [] };
    this.acceptStatus(record, status.session);
    if (record.finished || identity?.conversationId !== record.reference.conversationId)
      return { session: status.session, actions: [] };
    await this.guardOwner(identity, record);
    return status;
  }

  public async join(
    profileId: string,
    identity?: BodyConversationIdentity,
    sessionId?: string,
  ): Promise<MinecraftSessionStatus> {
    if (this.joining !== undefined && (this.record === null || this.record.finished))
      throw new MinecraftServiceError("minecraft_session_active");
    const reservation = { sessionId: sessionId ?? randomUUID(), cancelled: false };
    if (this.joining === undefined) this.joining = reservation;
    try {
      return await this.joinOwned(profileId, identity, reservation.sessionId);
    } finally {
      if (this.joining === reservation) this.joining = undefined;
    }
  }

  private async joinOwned(
    profileId: string,
    identity: BodyConversationIdentity | undefined,
    sessionId: string,
  ): Promise<MinecraftSessionStatus> {
    MinecraftServerProfileIdSchema.parse(profileId);
    await this.admit(identity);
    if (this.joining?.sessionId === sessionId && this.joining.cancelled)
      throw new MinecraftServiceError("minecraft_stop_requested");
    if (!(await this.profiles()).some((profile) => profile.id === profileId))
      throw new MinecraftServiceError("unknown_profile");
    await this.admit(identity);
    if (this.joining?.sessionId === sessionId && this.joining.cancelled)
      throw new MinecraftServiceError("minecraft_stop_requested");
    const existing = this.record;
    if (existing !== null && !existing.finished) {
      await this.guardOwner(identity, existing);
      if (existing.status.profileId !== profileId)
        throw new MinecraftServiceError("minecraft_session_active");
      return (await this.status(identity)).session!;
    }
    const acquired = this.options.store.acquire("play", identity!.conversationId, 30_000, identity!.route);
    if (acquired.outcome !== "acquired") this.denyLease(acquired);
    const begun = this.options.store.begin(acquired.lease);
    if (begun.outcome !== "admitted") this.denyLease(begun);
    const record: SessionRecord = {
      reference: acquired.lease as SessionRecord["reference"],
      operationId: begun.operationId,
      finished: false,
      status: {
        session: { sessionId, connectionGeneration: 1 },
        profileId,
        phase: "connecting",
        termination: { state: "not_requested" },
      },
      sequence: 0,
    };
    this.record = record;
    this.registeredStop = undefined;
    this.authority = identity!.authorize;
    this.route = identity!.route;
    this.restartReference = undefined;
    this.suspended = false;
    this.driver = { kind: this.options.automaticPlay ? "mind" : "owner" };
    this.driverGeneration++;
    this.save(); // Identity and lease are durable before the first possible bot effect.
    let dispatched = false;
    try {
      await this.guardOwner(identity, record);
      const result = await this.options.port.join({ profileId, session: record.status.session }, async () => {
        const current = await this.guardOwner(identity, record);
        dispatched = true;
        return current;
      });
      this.acceptStatus(record, result);
      return result;
    } catch (error) {
      // Only a refusal before the adapter's final dispatch fence proves it never dialed.
      if (!dispatched)
        this.acceptStatus(record, {
          ...record.status,
          phase: "disconnected",
          termination: { state: "confirmed", confirmedAt: this.now(), source: "not_connected" },
        });
      else {
        record.status = this.uncertainStatus(record);
        this.save();
      }
      throw this.safeError(error);
    }
  }

  public async observe(identity?: BodyConversationIdentity) {
    const record = await this.owned(identity);
    return this.options.port.observe(record.status.session, () => this.guardOwner(identity, record));
  }

  public async act(
    action: MinecraftAction,
    identity?: BodyConversationIdentity,
    actionId: string = randomUUID(),
  ): Promise<MinecraftActionStatus> {
    const request = MinecraftActionSchema.parse(action);
    const id = MinecraftActionIdSchema.parse(actionId);
    const record = await this.owned(identity);
    if (this.driver.kind !== "owner" || this.switchingDriver)
      throw new MinecraftServiceError("minecraft_driver_busy");
    const generation = this.driverGeneration;
    await this.requireSettledMotor(record, () => this.guardOwnerDriver(identity, record, generation), id);
    return this.options.port.act({ session: record.status.session, actionId: id, action: request }, () =>
      this.guardOwnerDriver(identity, record, generation),
    );
  }

  /** Change only the driver of this same owned stay; the conversation's play lease never transfers. */
  public async setDriver(driver: MinecraftDriver, identity?: BodyConversationIdentity) {
    const record = await this.owned(identity, true);
    if (
      driver.kind === "worker" &&
      !/^fleet:[a-z][a-z0-9-]*:pane:(?!unverified$)\S{1,128}$/u.test(driver.principalId)
    )
      throw new MinecraftServiceError("minecraft_driver_identity_invalid");
    if (this.switchingDriver) throw new MinecraftServiceError("minecraft_driver_changing");
    this.switchingDriver = true;
    this.driverGeneration++; // Invalidate every queued decision before awaiting motor quiescence.
    this.driver = { kind: "owner" };
    try {
      await this.guardOwner(identity, record, true);
      const status = await this.options.port.status();
      const unsettled = status.actions.filter((action) =>
        ["running", "cancel_requested", "uncertain"].includes(action.state),
      );
      for (const action of unsettled) {
        await this.options.port.cancel(record.status.session, action.actionId, () =>
          this.guardOwner(identity, record, true),
        );
      }
      const deadline = this.now() + 2_000;
      while (unsettled.length > 0) {
        await this.guardOwner(identity, record, true);
        const current = await this.options.port.status();
        if (
          !current.actions.some((action) =>
            ["running", "cancel_requested", "uncertain"].includes(action.state),
          )
        )
          break;
        if (this.now() >= deadline) throw new MinecraftServiceError("minecraft_driver_motor_unsettled");
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      await this.guardOwner(identity, record);
      this.driver = driver;
      return { driver: this.driver, generation: this.driverGeneration };
    } finally {
      this.switchingDriver = false;
    }
  }

  public async driverStatus(identity?: BodyConversationIdentity) {
    await this.owned(identity, true);
    return { driver: this.driver, generation: this.driverGeneration, changing: this.switchingDriver };
  }

  /** Host-only view of the existing play claim/guard/stop seam; no new authority. */
  public mindContext() {
    const record = this.record;
    if (
      !record ||
      record.finished ||
      this.authority === undefined ||
      this.driver.kind !== "mind" ||
      this.switchingDriver
    )
      return undefined;
    const generation = this.driverGeneration;
    const current = () =>
      this.record === record &&
      !record.finished &&
      this.driver.kind === "mind" &&
      this.driverGeneration === generation &&
      !this.switchingDriver;
    const guard = async () => {
      if (!current()) throw new MinecraftServiceError("minecraft_driver_changed");
      const held = await this.guardRecord(record);
      if (!current()) throw new MinecraftServiceError("minecraft_driver_changed");
      return () => {
        held();
        if (!current()) throw new MinecraftServiceError("minecraft_driver_changed");
      };
    };
    return {
      session: record.status.session,
      profileId: record.status.profileId,
      conversationId: record.reference.conversationId,
      route: this.route,
      generation,
      current,
      guard,
      observe: async () => this.options.port.observe(record.status.session, guard),
      mode: async () => {
        await guard();
        const status = await this.options.port.status();
        await guard();
        if (!status.session || !sameMinecraftSession(record.status.session, status.session.session))
          return "world_ended";
        this.acceptStatus(record, status.session);
        return status.session.phase;
      },
      act: async (request: MinecraftActionRequest) => {
        await guard();
        if (!sameMinecraftSession(record.status.session, request.session))
          throw new MinecraftServiceError("minecraft_stale_session");
        await this.requireSettledMotor(record, guard, request.actionId);
        return this.options.port.act(request, guard);
      },
      actionStatus: async (actionId: string) =>
        this.options.port.actionStatus(record.status.session, actionId, guard),
      cancel: async (actionId: string) =>
        this.options.port.cancel(record.status.session, actionId, async () => {
          if (this.record !== record || record.finished)
            throw new MinecraftServiceError("minecraft_stale_session");
          return this.guardRecord(record, true);
        }),
      leave: async () => {
        await guard();
        const status = await this.options.port.leave(record.status.session, guard);
        this.acceptStatus(record, status);
        return status;
      },
    };
  }

  public async workerCommand(
    command: {
      action: "observe" | "status" | "cancel" | "act";
      request?: MinecraftAction | undefined;
      actionId?: string | undefined;
    },
    worker: MinecraftWorkerDriver,
  ) {
    const record = this.record;
    const generation = this.driverGeneration;
    const guard = async () => {
      await worker.guard();
      if (
        !record ||
        this.record !== record ||
        record.finished ||
        this.switchingDriver ||
        this.driver.kind !== "worker" ||
        this.driver.principalId !== worker.principalId ||
        this.driverGeneration !== generation
      )
        throw new MinecraftServiceError("minecraft_driver_not_selected");
      const held = await this.guardRecord(record, command.action === "cancel");
      const admitted = await worker.guard();
      if (this.driverGeneration !== generation) throw new MinecraftServiceError("minecraft_driver_changed");
      return () => {
        admitted?.();
        held();
        if (
          this.switchingDriver ||
          this.driver.kind !== "worker" ||
          this.driver.principalId !== worker.principalId ||
          this.driverGeneration !== generation
        )
          throw new MinecraftServiceError("minecraft_driver_changed");
      };
    };
    await guard();
    const session = record!.status.session;
    switch (command.action) {
      case "observe":
        return this.options.port.observe(session, guard);
      case "status": {
        if (command.actionId)
          return this.options.port.actionStatus(
            session,
            MinecraftActionIdSchema.parse(command.actionId),
            guard,
          );
        const status = await this.options.port.status();
        await guard();
        return status;
      }
      case "act": {
        await this.requireSettledMotor(record!, guard, command.actionId);
        return this.options.port.act(
          {
            session,
            actionId: MinecraftActionIdSchema.parse(command.actionId ?? randomUUID()),
            action: MinecraftActionSchema.parse(command.request),
          },
          guard,
        );
      }
      case "cancel": {
        const status = await this.options.port.status();
        await guard();
        const id =
          command.actionId ??
          status.actions.find((action) => ["running", "cancel_requested", "uncertain"].includes(action.state))
            ?.actionId;
        return id === undefined
          ? null
          : this.options.port.cancel(session, MinecraftActionIdSchema.parse(id), guard);
      }
    }
  }

  private async guardOwnerDriver(
    identity: BodyConversationIdentity | undefined,
    record: SessionRecord,
    generation: number,
  ) {
    const held = await this.guardOwner(identity, record);
    if (this.driver.kind !== "owner" || this.driverGeneration !== generation || this.switchingDriver)
      throw new MinecraftServiceError("minecraft_driver_changed");
    return () => {
      held();
      if (this.driver.kind !== "owner" || this.driverGeneration !== generation || this.switchingDriver)
        throw new MinecraftServiceError("minecraft_driver_changed");
    };
  }

  private async requireSettledMotor(record: SessionRecord, guard: MinecraftGuard, replayId?: string) {
    const status = await this.options.port.status();
    await guard();
    if (!status.session || !sameMinecraftSession(record.status.session, status.session.session))
      throw new MinecraftServiceError("minecraft_stale_session");
    if (
      status.actions.some(
        (action) =>
          action.actionId !== replayId && ["running", "cancel_requested", "uncertain"].includes(action.state),
      )
    )
      throw new MinecraftServiceError("minecraft_motor_unsettled");
  }

  public async chat(text: string, identity?: BodyConversationIdentity) {
    return this.act({ type: "chat", text }, identity);
  }

  public async actionStatus(actionId: string, identity?: BodyConversationIdentity) {
    const record = await this.owned(identity);
    return this.options.port.actionStatus(
      record.status.session,
      MinecraftActionIdSchema.parse(actionId),
      () => this.guardOwner(identity, record),
    );
  }

  public async cancel(actionId?: string, identity?: BodyConversationIdentity) {
    const record = await this.owned(identity, true);
    const id =
      actionId ??
      (await this.options.port.status()).actions.find((action) =>
        ["running", "cancel_requested", "uncertain"].includes(action.state),
      )?.actionId;
    if (id === undefined) return null;
    await this.guardOwner(identity, record, true);
    return this.options.port.cancel(record.status.session, MinecraftActionIdSchema.parse(id), () =>
      this.guardOwner(identity, record, true),
    );
  }

  public async pause(identity?: BodyConversationIdentity) {
    return this.sessionOperation("pause", identity);
  }
  public async resume(identity?: BodyConversationIdentity) {
    return this.sessionOperation("resume", identity);
  }
  public async leave(identity?: BodyConversationIdentity) {
    return this.sessionOperation("leave", identity);
  }

  /** Read-only host renderer plumbing; raw loopback URLs never enter captain results. */
  public async viewerStatus(session: MinecraftSessionRef) {
    const record = this.record;
    if (
      record === null ||
      record.finished ||
      !sameMinecraftSession(record.status.session, session) ||
      this.options.port.viewerStatus === undefined
    )
      throw new MinecraftServiceError("minecraft_viewer_unavailable");
    const { frameUrl, ...result } = await this.options.port.viewerStatus(session);
    return { ...result, ...(frameUrl === undefined ? {} : { frameUrl }) };
  }

  /** Existing body-router recovery supplies current recover authority and the exact recovery incarnation. */
  public async recover(guard: MinecraftGuard): Promise<boolean> {
    if (this.unavailable) return false;
    const record = this.record;
    if (record === null || record.finished) return true;
    const expected = this.restartReference ?? record.reference;
    const recoveryFence = async () => {
      const admitted = await guard();
      const assertCurrent = () => {
        admitted?.();
        const current = this.options.store.recoveryReference("play");
        if (
          this.record !== record ||
          current?.token !== expected.token ||
          current.conversationId !== expected.conversationId
        )
          throw new MinecraftServiceError("minecraft_stale_session");
      };
      assertCurrent();
      return assertCurrent;
    };
    try {
      await recoveryFence();
      const status = await this.options.port.status();
      await recoveryFence();
      // A replacement adapter having no bot says nothing about the original external connection.
      if (status.session === null || !sameMinecraftSession(record.status.session, status.session.session))
        return false;
      const stopped =
        status.session.termination.state === "confirmed"
          ? status.session
          : await this.options.port.leave(record.status.session, recoveryFence);
      await recoveryFence();
      if (
        !sameMinecraftSession(record.status.session, stopped.session) ||
        stopped.termination.state !== "confirmed"
      )
        return false;
      this.acceptStatus(record, stopped);
      return record.finished;
    } catch {
      return false;
    }
  }

  /** One bounded poll/wake at a time, addressed only to the stored owner under its original live grant. */
  public async pumpEvents(
    wake: (input: MinecraftEventWake, guard: MinecraftGuard) => Promise<boolean>,
  ): Promise<void> {
    const record = this.record;
    if (
      this.pumping ||
      this.unavailable ||
      record === null ||
      record.finished ||
      this.options.port.pollEvents === undefined ||
      this.authority === undefined ||
      this.suspended
    )
      return;
    this.pumping = true;
    try {
      await this.guardRecord(record);
      const batch = await this.options.port.pollEvents(record.status.session, record.sequence, () =>
        this.guardRecord(record),
      );
      await this.guardRecord(record);
      if (!sameMinecraftSession(record.status.session, batch.session))
        throw new MinecraftServiceError("minecraft_stale_session");
      const events = batch.events.filter((event) => event.sequence > record.sequence);
      if (events.length > 0) {
        // Persist consumed sequence before delivery: an uncertain wake is never replayed into another turn.
        record.sequence = events.at(-1)!.sequence;
        this.save();
        await wake(
          {
            conversationId: record.reference.conversationId,
            ...(this.route === undefined ? {} : { route: this.route }),
            session: record.status.session,
            events,
            droppedBeforeSequence: batch.droppedBeforeSequence,
          },
          () => this.guardRecord(record),
        );
      }
      const status = await this.options.port.status();
      if (status.session !== null && sameMinecraftSession(record.status.session, status.session.session))
        this.acceptStatus(record, status.session);
    } catch (error) {
      if (error instanceof MinecraftServiceError && error.code === "minecraft_not_authorized") {
        // Revocation quiesces already-admitted work; this host stop grants no new motor action.
        const result = await this.options.port.pause(record.status.session, () =>
          this.guardRecord(record, true),
        );
        this.acceptStatus(record, result);
        this.suspended = true;
      } else throw error;
    } finally {
      this.pumping = false;
    }
  }

  private async sessionOperation(method: "pause" | "resume" | "leave", identity?: BodyConversationIdentity) {
    const stopping = method !== "resume";
    const record = await this.owned(identity, stopping);
    this.driverGeneration++; // Stop queued decisions and give resume a fresh driver incarnation.
    const result = await this.options.port[method](record.status.session, () =>
      this.guardOwner(identity, record, stopping),
    );
    this.acceptStatus(record, result);
    if (method === "resume") this.suspended = false;
    return result;
  }

  private async owned(
    identity: BodyConversationIdentity | undefined,
    stopping = false,
  ): Promise<SessionRecord> {
    await this.admit(identity);
    const record = this.record;
    if (record === null || record.finished) throw new MinecraftServiceError("minecraft_not_joined");
    await this.guardOwner(identity, record, stopping);
    return record;
  }

  private async guardOwner(
    identity: BodyConversationIdentity | undefined,
    record: SessionRecord,
    stopping = false,
  ) {
    await this.admit(identity);
    if (identity!.conversationId !== record.reference.conversationId) {
      const lease = this.options.store.status("play");
      if (lease !== undefined) this.denyLease({ outcome: "busy", lease });
      throw new MinecraftServiceError("minecraft_stale_session");
    }
    const held = await this.guardRecord(record, stopping);
    await this.admit(identity);
    return () => {
      held();
      if (!identity!.current() || identity!.conversationId !== record.reference.conversationId)
        throw new MinecraftServiceError("minecraft_identity_required");
    };
  }

  private async guardRecord(record: SessionRecord, stopping = false) {
    this.requireAvailable();
    if (this.record !== record || record.finished || this.authority === undefined)
      throw new MinecraftServiceError("minecraft_recovery_required");
    if (
      !stopping &&
      (!(await this.allowed(this.authority)) ||
        (record.status.phase !== "connecting" &&
          this.options.port.approved !== undefined &&
          !(await this.options.port.approved(record.status.session))))
    )
      throw new MinecraftServiceError("minecraft_not_authorized");
    if (this.record !== record || record.finished) throw new MinecraftServiceError("minecraft_stale_session");
    const valid = this.options.store.validate(record.reference, record.operationId);
    if (valid.outcome !== "valid") this.denyLease(valid);
    const renewed = this.options.store.renew(record.reference, 30_000);
    if (renewed.outcome !== "renewed") this.denyLease(renewed);
    return () => {
      this.requireAvailable();
      if (this.record !== record || record.finished || this.authority === undefined)
        throw new MinecraftServiceError("minecraft_stale_session");
      const valid = this.options.store.validate(record.reference, record.operationId);
      if (valid.outcome !== "valid") this.denyLease(valid);
    };
  }

  private async admit(identity: BodyConversationIdentity | undefined) {
    this.requireAvailable();
    if (identity === undefined || !identity.current())
      throw new MinecraftServiceError("minecraft_identity_required");
    if (!(await this.allowed(identity.authorize)))
      throw new MinecraftServiceError("minecraft_not_authorized");
    this.requireAvailable();
    if (!identity.current()) throw new MinecraftServiceError("minecraft_identity_required");
  }

  private async allowed(authorize: BodyConversationIdentity["authorize"]) {
    try {
      return await authorize("play", "effect");
    } catch {
      return false;
    }
  }
  private requireAvailable() {
    this.options.guardRegistration?.();
    if (this.unavailable) throw new MinecraftServiceError("minecraft_store_unavailable");
  }
  private denyLease(result: Exclude<ReturnType<BodyLeaseStore["acquire"]>, { outcome: "acquired" }>): never {
    throw new MinecraftServiceError(
      result.outcome === "busy" ? "minecraft_play_busy" : `minecraft_${result.reason}`,
      result.outcome === "busy" ? { ...result, actions: ["queue", "ask"] } : result,
    );
  }
  private uncertainStatus(record: SessionRecord): MinecraftSessionStatus {
    return {
      ...record.status,
      phase: "uncertain",
      termination: { state: "uncertain", requestedAt: this.now(), code: "adapter_lost" },
    };
  }
  private safeError(error: unknown): Error {
    if (error instanceof MinecraftServiceError) return error;
    const code = (error as { code?: unknown })?.code;
    if (
      typeof code === "string" &&
      ["unknown_profile", "destination_unapproved", "destination_unavailable"].includes(code)
    )
      return new MinecraftServiceError(code);
    return new MinecraftServiceError("minecraft_motor_unavailable");
  }

  private acceptStatus(record: SessionRecord, status: MinecraftSessionStatus) {
    if (this.record !== record || !sameMinecraftSession(record.status.session, status.session))
      throw new MinecraftServiceError("minecraft_stale_session");
    if (record.status.profileId !== status.profileId)
      throw new MinecraftServiceError("minecraft_profile_mismatch");
    record.status = status;
    if (status.termination.state !== "confirmed") {
      this.save();
      return;
    }
    const expected = this.restartReference ?? record.reference;
    const current = this.options.store.recoveryReference("play");
    if (current?.token !== expected.token || current.conversationId !== expected.conversationId) return;
    record.finished = true;
    this.save(); // Termination evidence is durable before the shared controls become available.
    if (current.token === record.reference.token)
      this.options.store.finish(current, record.operationId, "settled");
    this.options.store.reconcileStopped(current); // A router recovery pin is removed by its enclosing recovery.
    this.authority = undefined;
    this.options.onDisconnect?.(status.session);
  }

  private save() {
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      const temporary = `${this.options.path}.${randomUUID()}.tmp`;
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(file, JSON.stringify(this.record));
        fsyncSync(file);
      } finally {
        closeSync(file);
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
}
