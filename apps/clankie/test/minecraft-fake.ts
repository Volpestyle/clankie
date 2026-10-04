import {
  MinecraftActionRequestSchema,
  MinecraftActionStatusSchema,
  MinecraftJoinRequestSchema,
  MinecraftObservationSchema,
  MinecraftServerProfileSchema,
  type MinecraftActionId,
  type MinecraftActionRequest,
  type MinecraftActionStatus,
  type MinecraftEffectEvidence,
  type MinecraftJoinRequest,
  type MinecraftObservation,
  type MinecraftServerProfile,
  type MinecraftSessionRef,
  type MinecraftSessionStatus,
  type MinecraftStatus,
  type MinecraftTermination,
} from "@clankie/protocol";
import { sameMinecraftSession, type MinecraftPort } from "../src/minecraft-port.ts";

/** Controllable test double only: no networking, world simulation, lease or authority policy. */
export class FakeMinecraftPort implements MinecraftPort {
  private current: MinecraftSessionStatus | null = null;
  private readonly actions = new Map<MinecraftActionId, MinecraftActionStatus>();
  private observation: MinecraftObservation | null = null;
  private readonly configured: MinecraftServerProfile[];
  private readonly now: () => number;
  public readonly dispatched: MinecraftActionRequest[] = [];

  public constructor(profiles: MinecraftServerProfile[], now: () => number = () => 1_000) {
    this.now = now;
    this.configured = profiles.map((profile) => MinecraftServerProfileSchema.parse(profile));
  }

  public async profiles(): Promise<readonly MinecraftServerProfile[]> {
    return structuredClone(this.configured);
  }

  public async join(input: MinecraftJoinRequest): Promise<MinecraftSessionStatus> {
    const request = MinecraftJoinRequestSchema.parse(input);
    if (!this.configured.some((profile) => profile.id === request.profileId))
      throw new Error("profile_unknown");
    if (this.current !== null) {
      if (sameMinecraftSession(this.current.session, request.session)) {
        if (this.current.profileId !== request.profileId) throw new Error("session_conflict");
        return structuredClone(this.current);
      }
      if (this.current.termination.state !== "confirmed") throw new Error("termination_unconfirmed");
      if (
        this.current.session.sessionId === request.session.sessionId &&
        request.session.connectionGeneration <= this.current.session.connectionGeneration
      ) {
        throw new Error("stale_session");
      }
    }
    this.current = {
      session: request.session,
      profileId: request.profileId,
      phase: "connecting",
      termination: { state: "not_requested" },
    };
    this.actions.clear();
    this.observation = null;
    return structuredClone(this.current);
  }

  public async status(): Promise<MinecraftStatus> {
    return structuredClone({ session: this.current, actions: [...this.actions.values()] });
  }

  public async observe(session: MinecraftSessionRef): Promise<MinecraftObservation> {
    this.requireSession(session);
    return structuredClone(this.observation ?? { session, observedAt: this.now(), facts: [] });
  }

  public async act(input: MinecraftActionRequest): Promise<MinecraftActionStatus> {
    const request = MinecraftActionRequestSchema.parse(input);
    const current = this.requireSession(request.session);
    const previous = this.actions.get(request.actionId);
    if (previous !== undefined) {
      if (JSON.stringify(previous.requested) !== JSON.stringify(request.action))
        throw new Error("action_id_conflict");
      return structuredClone(previous);
    }
    if (current.phase !== "active") throw new Error("session_not_active");
    if (
      [...this.actions.values()].some(
        (action) =>
          action.state === "running" || action.state === "cancel_requested" || action.state === "uncertain",
      )
    ) {
      throw new Error("action_unsettled");
    }
    if (this.actions.size >= 64) throw new Error("action_history_full");
    const action: MinecraftActionStatus = {
      session: request.session,
      actionId: request.actionId,
      requested: request.action,
      state: "running",
      requestedAt: this.now(),
      updatedAt: this.now(),
      evidence: { outcome: "unknown", reason: "not_observed" },
    };
    this.actions.set(action.actionId, action);
    this.dispatched.push(structuredClone(request));
    return structuredClone(action);
  }

  public async actionStatus(
    session: MinecraftSessionRef,
    actionId: MinecraftActionId,
  ): Promise<MinecraftActionStatus | null> {
    this.requireSession(session);
    return structuredClone(this.actions.get(actionId) ?? null);
  }

  public async pause(session: MinecraftSessionRef): Promise<MinecraftSessionStatus> {
    const current = this.requireSession(session);
    if (current.phase !== "active" && current.phase !== "pausing" && current.phase !== "paused") {
      throw new Error("session_not_active");
    }
    if (current.phase === "active") {
      current.phase = "pausing";
      this.requestCancellations();
    }
    return structuredClone(current);
  }

  public async resume(session: MinecraftSessionRef): Promise<MinecraftSessionStatus> {
    const current = this.requireSession(session);
    if (current.phase !== "paused") throw new Error("pause_unconfirmed");
    current.phase = "active";
    return structuredClone(current);
  }

  public async cancel(
    session: MinecraftSessionRef,
    actionId: MinecraftActionId,
  ): Promise<MinecraftActionStatus> {
    this.requireSession(session);
    const action = this.actions.get(actionId);
    if (action === undefined) throw new Error("action_unknown");
    if (action.state === "running") {
      action.state = "cancel_requested";
      action.updatedAt = this.now();
    }
    return structuredClone(action);
  }

  public async leave(session: MinecraftSessionRef): Promise<MinecraftSessionStatus> {
    const current = this.requireSession(session);
    if (current.termination.state === "not_requested") {
      current.phase = "stopping";
      current.termination = { state: "pending", requestedAt: this.now() };
      this.requestCancellations();
    }
    return structuredClone(current);
  }

  public confirmJoined(session: MinecraftSessionRef): boolean {
    if (!this.isCurrent(session) || this.current?.phase !== "connecting") return false;
    this.current.phase = "active";
    return true;
  }

  public setObservation(observation: MinecraftObservation): boolean {
    const value = MinecraftObservationSchema.parse(observation);
    if (!this.isCurrent(value.session) || this.current?.phase === "disconnected") return false;
    this.observation = value;
    return true;
  }

  /** A normal late completion cannot overwrite a cancellation request or terminal action. */
  public completeAction(
    session: MinecraftSessionRef,
    actionId: MinecraftActionId,
    evidence: MinecraftEffectEvidence,
  ): boolean {
    const action = this.callbackAction(session, actionId);
    if (action?.state !== "running" || this.current?.phase !== "active") return false;
    this.actions.set(
      actionId,
      MinecraftActionStatusSchema.parse({
        ...action,
        state: "completed",
        evidence,
        updatedAt: this.now(),
      }),
    );
    return true;
  }

  public confirmCancelled(
    session: MinecraftSessionRef,
    actionId: MinecraftActionId,
    evidence: MinecraftEffectEvidence = { outcome: "unknown", reason: "interrupted" },
  ): boolean {
    const action = this.callbackAction(session, actionId);
    if (action?.state !== "cancel_requested" && action?.state !== "uncertain") return false;
    this.actions.set(
      actionId,
      MinecraftActionStatusSchema.parse({
        ...action,
        state: "cancelled",
        evidence,
        updatedAt: this.now(),
      }),
    );
    return true;
  }

  public markActionUncertain(session: MinecraftSessionRef, actionId: MinecraftActionId): boolean {
    const action = this.callbackAction(session, actionId);
    if (action?.state !== "running" && action?.state !== "cancel_requested") return false;
    action.state = "uncertain";
    action.updatedAt = this.now();
    action.evidence = { outcome: "unknown", reason: "connection_lost" };
    return true;
  }

  public confirmPaused(session: MinecraftSessionRef): boolean {
    if (!this.isCurrent(session) || this.current?.phase !== "pausing") return false;
    if (
      [...this.actions.values()].some(
        (action) =>
          action.state === "running" || action.state === "cancel_requested" || action.state === "uncertain",
      )
    )
      return false;
    this.current.phase = "paused";
    return true;
  }

  public markTerminationUncertain(
    session: MinecraftSessionRef,
    code: "timeout" | "connection_lost" | "adapter_lost",
  ): boolean {
    if (!this.isCurrent(session) || this.current?.termination.state !== "pending") return false;
    this.current.termination = { ...this.current.termination, state: "uncertain", code };
    this.current.phase = "uncertain";
    return true;
  }

  public confirmDisconnected(
    session: MinecraftSessionRef,
    source: Extract<MinecraftTermination, { state: "confirmed" }>["source"] = "connection_end",
  ): boolean {
    if (!this.isCurrent(session) || this.current === null || this.current.phase === "disconnected")
      return false;
    this.current.phase = "disconnected";
    this.current.termination = { state: "confirmed", confirmedAt: this.now(), source };
    for (const action of this.actions.values()) {
      if (action.state === "running" || action.state === "cancel_requested" || action.state === "uncertain") {
        action.state = "cancelled";
        action.updatedAt = this.now();
        action.evidence = { outcome: "unknown", reason: "connection_lost" };
      }
    }
    return true;
  }

  private requireSession(session: MinecraftSessionRef): MinecraftSessionStatus {
    if (!this.isCurrent(session) || this.current === null) throw new Error("stale_session");
    return this.current;
  }

  private isCurrent(session: MinecraftSessionRef): boolean {
    return this.current !== null && sameMinecraftSession(this.current.session, session);
  }

  private callbackAction(
    session: MinecraftSessionRef,
    actionId: MinecraftActionId,
  ): MinecraftActionStatus | undefined {
    return this.isCurrent(session) ? this.actions.get(actionId) : undefined;
  }

  private requestCancellations(): void {
    for (const action of this.actions.values()) {
      if (action.state === "running") {
        action.state = "cancel_requested";
        action.updatedAt = this.now();
      }
    }
  }
}
