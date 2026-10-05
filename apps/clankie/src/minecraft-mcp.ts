import {
  MinecraftActionIdSchema,
  MinecraftActionRequestSchema,
  MinecraftActionStatusSchema,
  MinecraftJoinRequestSchema,
  MinecraftObservationSchema,
  MinecraftServerProfileSchema,
  MinecraftSessionRefSchema,
  MinecraftSessionStatusSchema,
  MinecraftStatusSchema,
  type MinecraftActionRequest,
  type MinecraftJoinRequest,
  type MinecraftServerProfile,
  type MinecraftSessionRef,
} from "@clankie/protocol";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { MINECRAFT_BODY_ACCESS, type McpHost } from "./mcp-host.ts";
import {
  MinecraftEventsSchema,
  MinecraftViewerStatusSchema,
  sameMinecraftSession,
  type MinecraftGuard,
  type MinecraftPort,
} from "./minecraft-port.ts";

/** Owner-only resolved endpoint, supplied after DNS/SRV destination policy. */
export interface MinecraftEndpoint {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly username: string;
  readonly auth: "offline";
}

/** The transport holds no authority itself; every protected call retains the service's final fence. */
export class MinecraftMcpPort implements MinecraftPort {
  private joined:
    | { profileId: string; session: MinecraftSessionRef; endpoint: MinecraftEndpoint }
    | undefined;
  private readonly options: {
    host: Pick<McpHost, "call">;
    profiles(): Promise<readonly MinecraftServerProfile[]>;
    resolveProfile(profileId: string): Promise<MinecraftEndpoint>;
  };
  public constructor(options: MinecraftMcpPort["options"]) {
    this.options = options;
  }

  public async profiles(): Promise<readonly MinecraftServerProfile[]> {
    return z.array(MinecraftServerProfileSchema).parse(await this.options.profiles());
  }

  public async join(input: MinecraftJoinRequest, guard?: MinecraftGuard) {
    const request = MinecraftJoinRequestSchema.parse(input);
    if (!(await this.profiles()).some((profile) => profile.id === request.profileId))
      throw new Error("minecraft_profile_unknown");
    const endpoint = await this.options.resolveProfile(request.profileId);
    const result = this.sessionReply(
      request.session,
      await this.call("join", { ...request, endpoint }, MinecraftSessionStatusSchema, async () => {
        if (!isDeepStrictEqual(endpoint, await this.options.resolveProfile(request.profileId)))
          throw new Error("minecraft_profile_changed");
        return this.requireGuard(guard)();
      }),
    );
    this.joined = { profileId: request.profileId, session: request.session, endpoint };
    return result;
  }

  public async status() {
    return this.call("status", {}, MinecraftStatusSchema);
  }

  public async observe(session: MinecraftSessionRef, guard?: MinecraftGuard) {
    const result = await this.call(
      "observe",
      { session: MinecraftSessionRefSchema.parse(session) },
      MinecraftObservationSchema,
      this.requireGuard(guard),
    );
    this.requireSession(session, result.session);
    return result;
  }

  public async act(input: MinecraftActionRequest, guard?: MinecraftGuard) {
    const request = MinecraftActionRequestSchema.parse(input);
    const result = await this.call(
      "act",
      request,
      MinecraftActionStatusSchema,
      this.profileFence(request.session, this.requireGuard(guard)),
    );
    this.requireSession(request.session, result.session);
    if (result.actionId !== request.actionId || !isDeepStrictEqual(result.requested, request.action))
      throw new Error("minecraft_motor_action_mismatch");
    return result;
  }

  public async actionStatus(session: MinecraftSessionRef, actionId: string, guard?: MinecraftGuard) {
    const result = await this.call(
      "action_status",
      {
        session: MinecraftSessionRefSchema.parse(session),
        actionId: MinecraftActionIdSchema.parse(actionId),
      },
      MinecraftActionStatusSchema.nullable(),
      this.requireGuard(guard),
    );
    if (result !== null) {
      this.requireSession(session, result.session);
      if (result.actionId !== actionId) throw new Error("minecraft_motor_action_mismatch");
    }
    return result;
  }

  public async cancel(session: MinecraftSessionRef, actionId: string, guard?: MinecraftGuard) {
    const result = await this.call(
      "cancel_action",
      {
        session: MinecraftSessionRefSchema.parse(session),
        actionId: MinecraftActionIdSchema.parse(actionId),
      },
      MinecraftActionStatusSchema,
      this.requireGuard(guard),
    );
    this.requireSession(session, result.session);
    if (result.actionId !== actionId) throw new Error("minecraft_motor_action_mismatch");
    return result;
  }

  public async pause(session: MinecraftSessionRef, guard?: MinecraftGuard) {
    return this.sessionCall("pause", session, guard);
  }

  public async resume(session: MinecraftSessionRef, guard?: MinecraftGuard) {
    return this.sessionCall("resume", session, this.profileFence(session, this.requireGuard(guard)));
  }

  public async leave(session: MinecraftSessionRef, guard?: MinecraftGuard) {
    return this.sessionCall("leave", session, guard);
  }

  public async pollEvents(session: MinecraftSessionRef, afterSequence: number, guard?: MinecraftGuard) {
    const result = await this.call(
      "poll_events",
      { session: MinecraftSessionRefSchema.parse(session), afterSequence, limit: 64 },
      MinecraftEventsSchema,
      this.requireGuard(guard),
    );
    this.requireSession(session, result.session);
    return result;
  }

  public async viewerStatus(session: MinecraftSessionRef) {
    const result = await this.call(
      "viewer_status",
      { session: MinecraftSessionRefSchema.parse(session) },
      MinecraftViewerStatusSchema,
    );
    this.requireSession(session, result.session);
    return result;
  }

  public async approved(session: MinecraftSessionRef): Promise<boolean> {
    const joined = this.joined;
    if (joined === undefined || !sameMinecraftSession(joined.session, session)) return false;
    try {
      return isDeepStrictEqual(joined.endpoint, await this.options.resolveProfile(joined.profileId));
    } catch {
      return false;
    }
  }

  private async sessionCall(tool: string, session: MinecraftSessionRef, guard?: MinecraftGuard) {
    return this.sessionReply(
      session,
      await this.call(
        tool,
        { session: MinecraftSessionRefSchema.parse(session) },
        MinecraftSessionStatusSchema,
        this.requireGuard(guard),
      ),
    );
  }

  private sessionReply(session: MinecraftSessionRef, result: z.infer<typeof MinecraftSessionStatusSchema>) {
    this.requireSession(session, result.session);
    return result;
  }

  private requireSession(expected: MinecraftSessionRef, actual: MinecraftSessionRef) {
    if (!sameMinecraftSession(expected, actual)) throw new Error("minecraft_motor_session_mismatch");
  }

  private requireGuard(guard: MinecraftGuard | undefined): MinecraftGuard {
    if (guard === undefined) throw new Error("minecraft_body_guard_required");
    return guard;
  }

  private profileFence(session: MinecraftSessionRef, guard: MinecraftGuard): MinecraftGuard {
    return async () => {
      if (!(await this.approved(session))) throw new Error("minecraft_profile_revoked");
      return guard();
    };
  }

  private async call<T>(
    tool: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
    fence?: MinecraftGuard,
  ): Promise<T> {
    const result = await this.options.host.call({
      lane: "operator",
      server: "minecraft",
      tool,
      arguments: args,
      resultMode: "data",
      bodyAccess: MINECRAFT_BODY_ACCESS,
      ...(fence === undefined ? {} : { fence }),
    });
    // Provider/transport diagnostics may contain endpoints or account material. Keep them out of model results.
    if (result.outcome !== "ok" || result.isError) throw new Error("minecraft_motor_unavailable");
    try {
      return schema.parse(JSON.parse(result.content));
    } catch {
      throw new Error("minecraft_motor_invalid_reply");
    }
  }
}
