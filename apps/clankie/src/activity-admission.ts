import { ActivityAdmitRequestSchema } from "@clankie/protocol/activity-sharing";
import type { ActivityShareSession } from "@clankie/interactive-environment";
import { z } from "zod";
import type { ActivitySharing } from "./activity-sharing.ts";

const SnowflakeSchema = z.string().regex(/^[0-9]{1,32}$/u);
const TokenSchema = z
  .object({
    access_token: z.string().min(1).max(8192),
    token_type: z.literal("Bearer"),
    scope: z.string().max(1024),
  })
  .passthrough();
const InstanceSchema = z
  .object({
    application_id: SnowflakeSchema,
    instance_id: z.string().min(1).max(256),
    location: z
      .object({ guild_id: SnowflakeSchema.nullable().optional(), channel_id: SnowflakeSchema })
      .passthrough(),
    users: z.array(SnowflakeSchema).max(1000),
  })
  .passthrough();

export interface SelfHostedActivityAdmissionOptions {
  applicationId: string;
  /** Broker-held; undefined fails closed. */
  clientSecret: () => Promise<string | undefined>;
  botToken: () => Promise<string | undefined>;
  grant: (
    guildId: string,
    channelId: string,
  ) => Promise<{ session: ActivityShareSession; grant: string; expiresAt: string }>;
  fetch?: typeof fetch;
  /** Discord's API origin; a fixture in tests. */
  discordApi?: string;
}

export interface SelfHostedActivityAdmission {
  session: ActivityShareSession;
  grant: string;
  expiresAt: string;
  mediaPath: string;
  accessToken: string;
}

export class ActivityAdmissionError extends Error {
  public readonly status: 403 | 503;
  /** Operator-facing reason; never a credential. */
  public readonly detail: string | undefined;

  public constructor(
    message: "activity_admission_unavailable" | "activity_admission_denied",
    status: 403 | 503,
    detail?: string,
  ) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Discord's supported Activity handshake for a self-hosted official bot. The
 * viewer's OAuth code proves who they are; the bot's read of the Activity
 * instance proves they are in it and where it runs. SDK guild and channel
 * claims never select the destination (VUH-2833).
 */
export function createSelfHostedActivityAdmission(options: SelfHostedActivityAdmissionOptions) {
  const applicationId = SnowflakeSchema.parse(options.applicationId);
  const fetcher = options.fetch ?? fetch;
  const api = (options.discordApi ?? "https://discord.com/api/v10").replace(/\/$/u, "");
  const denied = () => new ActivityAdmissionError("activity_admission_denied", 403);
  const call = async (path: string, init: RequestInit) => {
    let response: Response, text: string;
    try {
      response = await fetcher(`${api}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      text = await response.text();
    } catch {
      throw new ActivityAdmissionError("activity_admission_unavailable", 503);
    }
    if (!response.ok || text.length > 64 * 1024) throw denied();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw denied();
    }
  };
  return {
    applicationId,
    async admit(input: unknown): Promise<SelfHostedActivityAdmission> {
      const request = ActivityAdmitRequestSchema.safeParse(input);
      if (!request.success) throw denied();
      const [clientSecret, botToken] = await Promise.all([options.clientSecret(), options.botToken()]);
      if (!clientSecret)
        throw new ActivityAdmissionError(
          "activity_admission_unavailable",
          503,
          "Activity admission needs the client secret (store it in the console: /discord → Tokens → Activity client secret)",
        );
      if (!botToken)
        throw new ActivityAdmissionError(
          "activity_admission_unavailable",
          503,
          "Activity admission needs the bot token (store it in the console: /discord → Tokens → Bot token)",
        );
      const token = TokenSchema.safeParse(
        await call("/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: applicationId,
            client_secret: clientSecret,
            grant_type: "authorization_code",
            code: request.data.code,
          }),
        }),
      );
      if (!token.success || !token.data.scope.split(" ").includes("identify")) throw denied();
      const user = z
        .object({ id: SnowflakeSchema })
        .passthrough()
        .safeParse(
          await call("/users/@me", { headers: { authorization: `Bearer ${token.data.access_token}` } }),
        );
      if (!user.success) throw denied();
      const instance = InstanceSchema.safeParse(
        await call(
          `/applications/${applicationId}/activity-instances/${encodeURIComponent(request.data.instanceId)}`,
          { headers: { authorization: `Bot ${botToken}` } },
        ),
      );
      if (
        !instance.success ||
        instance.data.application_id !== applicationId ||
        instance.data.instance_id !== request.data.instanceId ||
        !instance.data.location.guild_id ||
        !instance.data.users.includes(user.data.id)
      )
        throw denied();
      let granted;
      try {
        granted = await options.grant(instance.data.location.guild_id, instance.data.location.channel_id);
      } catch {
        throw denied();
      }
      return {
        ...granted,
        mediaPath: `/.proxy/activity/shares/${granted.session.shareId}/frames`,
        accessToken: token.data.access_token,
      };
    },
  };
}

type DestinationSharing = Pick<ActivitySharing, "grantForDestination" | "request">;

/**
 * Where Clankie's own bot launched the Activity, and the play shares each
 * launch opened. Admission grants only these destinations: a participant in an
 * instance someone else started elsewhere gets nothing. A share is opened on the
 * first admission while play is running, so `/activity` may come before or
 * after play starts, and a later play session gets a fresh share.
 *
 * Each launch is its own incarnation and owns the shares it opened or claimed.
 * Stop or relaunch retires it at once. Admissions and stop cleanup run one
 * at a time, so selecting, claiming and granting a share never
 * interleaves with cleanup ending it; an admission still rechecks its launch
 * after every await and refuses, ending only what it took, once that launch is
 * retired (VUH-2833 review).
 */
export function createActivityLaunches(
  sharing: DestinationSharing,
  { lockTimeoutMs = 10_000 }: { lockTimeoutMs?: number } = {},
) {
  interface Launch {
    shares: Set<string>;
  }
  const launched = new Map<string, Launch>();
  const retired = new Map<string, Set<Launch>>();
  // Room launch call ids per destination, and those a stop revoked. Call ids
  // are unique per tool call, so the revoked set only grows by stopped launches.
  const reserved = new Map<string, Set<string>>();
  const revoked = new Set<string>();
  // Accepted room launch writes still running in the presence route, and the
  // revoked call ids a stop must wait for, per destination.
  const inFlight = new Map<string, Promise<void>>();
  // Every activity_start the route is running, per destination, room or not.
  const startsInFlight = new Map<string, Set<string>>();
  const revokedAt = new Map<string, Set<string>>();
  const launchCall = (idempotencyKey: string) => /^captain:(.+):watch_start$/u.exec(idempotencyKey)?.[1];
  // One queue for every destination: they share one producer client whose
  // status listing reconciles all of its shares, so admissions and cleanup in
  // different channels must not interleave either. They are rare and
  // human-paced.
  let queue: Promise<unknown> = Promise.resolve();
  const key = (guildId: string, channelId: string) => `${guildId}:${channelId}`;
  const allow = async () => true;
  // A slow producer call must not leave callers waiting forever. Each caller
  // stops waiting after the timeout and is refused (fail closed), and its work
  // is marked abandoned so it takes nothing when it resumes. The channel itself
  // stays held until that work settles: releasing it early would let a stale
  // producer response race the next admission. Every producer request carries
  // its own timeout, so the hold is bounded.
  const exclusive = <T>(work: (abandoned: () => boolean) => Promise<T>): Promise<T> => {
    const previous = queue;
    let abandoned = false;
    const run = previous
      // allow-swallowed-rejection -- the earlier operation's own caller receives its failure; this one only waits its turn
      .catch(() => undefined)
      .then(() => work(() => abandoned));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    queue = settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        reject(new Error("activity_admission_timeout"));
      }, lockTimeoutMs);
    });
    return Promise.race([run, timedOut]).finally(() => clearTimeout(timer));
  };
  const owned = (destination: string, shareId: string) =>
    launched.get(destination)?.shares.has(shareId) === true ||
    [...(retired.get(destination) ?? [])].some((launch) => launch.shares.has(shareId));
  const stopShares = async (ids: ReadonlySet<string>) => {
    if (ids.size === 0) return;
    const listed = (await sharing.request({ action: "list" }, allow)) as {
      sessions: ActivityShareSession[];
    };
    for (const session of listed.sessions)
      if (ids.has(session.shareId))
        await sharing
          .request({ action: "stop", shareId: session.shareId, generation: session.generation }, allow)
          // allow-swallowed-rejection -- its launch is retired, so no new viewer is admitted, and a share that cannot be stopped still ends at its own expiry
          .catch(() => undefined);
  };
  const retire = (destination: string) => {
    const launch = launched.get(destination);
    if (launch === undefined) return;
    launched.delete(destination);
    const set = retired.get(destination) ?? new Set<Launch>();
    set.add(launch);
    retired.set(destination, set);
  };
  return {
    /** A room launch about to call its body (VUH-2835); see `allowsLaunch`. */
    reserveLaunch(callId: string, guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      const set = reserved.get(destination) ?? new Set<string>();
      set.add(callId);
      reserved.set(destination, set);
    },
    /**
     * A confirmed room stop revokes every launch reserved here before it, so a
     * body call that outlived its caller's timeout cannot land afterwards.
     */
    revokeLaunches(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      const stopped = revokedAt.get(destination) ?? new Set<string>();
      for (const callId of reserved.get(destination) ?? []) {
        revoked.add(callId);
        stopped.add(callId);
      }
      revokedAt.set(destination, stopped);
      reserved.delete(destination);
    },
    /** False for the presence write of a revoked room launch: it must not post or register. */
    allowsLaunch(idempotencyKey: string) {
      const callId = launchCall(idempotencyKey);
      return callId === undefined || !revoked.has(callId);
    },
    /** The presence route marks an accepted room launch write until its handling ends. */
    beginLaunch(idempotencyKey: string, guildId: string, channelId: string): () => void {
      const destination = key(guildId, channelId);
      const starts = startsInFlight.get(destination) ?? new Set<string>();
      starts.add(idempotencyKey);
      startsInFlight.set(destination, starts);
      const callId = launchCall(idempotencyKey);
      let done: (() => void) | undefined;
      if (callId !== undefined) inFlight.set(callId, new Promise<void>((resolve) => (done = resolve)));
      return () => {
        starts.delete(idempotencyKey);
        if (starts.size === 0) startsInFlight.delete(destination);
        if (callId !== undefined) inFlight.delete(callId);
        done?.();
      };
    },
    /**
     * Waits, at most `timeoutMs`, for revoked launches in this channel that the
     * route already accepted, including their cleanup. False while any still runs.
     */
    async settleRevoked(guildId: string, channelId: string, timeoutMs: number): Promise<boolean> {
      const pending = [...(revokedAt.get(key(guildId, channelId)) ?? [])].flatMap((callId) => {
        const running = inFlight.get(callId);
        return running === undefined ? [] : [running];
      });
      if (pending.length === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.all(pending).then(() => true),
        new Promise<boolean>((done) => (timer = setTimeout(() => done(false), timeoutMs))),
      ]);
      clearTimeout(timer);
      return settled;
    },
    /**
     * A current launch, a room launch reserved since the last stop, or another
     * unrevoked start already running holds this channel. `except` is the
     * asking launch's own write.
     */
    hasNewerLaunch(guildId: string, channelId: string, except: string) {
      const destination = key(guildId, channelId);
      return (
        launched.has(destination) ||
        (reserved.get(destination)?.size ?? 0) > 0 ||
        [...(startsInFlight.get(destination) ?? [])].some(
          (other) => other !== except && !revoked.has(launchCall(other) ?? ""),
        )
      );
    },
    launched(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      retire(destination);
      launched.set(destination, { shares: new Set() });
    },
    async stopped(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      retire(destination);
      // Cleanup always finishes, even after its caller stopped waiting.
      await exclusive(async () => {
        for (const launch of retired.get(destination) ?? []) {
          await stopShares(launch.shares);
          retired.get(destination)?.delete(launch);
        }
      });
    },
    grant(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      const launch = launched.get(destination);
      if (launch === undefined) return Promise.reject(new Error("activity_destination_refused"));
      return exclusive(async (abandoned) => {
        const current = () => !abandoned() && launched.get(destination) === launch;
        // What this admission took: ended again if its launch retires meanwhile.
        const taken = new Set<string>();
        const refuse = async (): Promise<never> => {
          await stopShares(taken);
          throw new Error("activity_destination_refused");
        };
        if (!current()) return refuse();
        let granted: Awaited<ReturnType<DestinationSharing["grantForDestination"]>> | undefined;
        try {
          // This launch's share, or one nobody owns (an owner's share in the
          // channel), which this launch then owns.
          granted = await sharing.grantForDestination(
            guildId,
            channelId,
            (shareId) => launch.shares.has(shareId) || !owned(destination, shareId),
          );
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "activity_share_gone") throw error;
        }
        if (granted === undefined) {
          if (!current()) return refuse();
          const opened = (await sharing.request(
            { action: "start", sourceId: "play", guildId, channelId },
            allow,
          )) as { session: ActivityShareSession };
          taken.add(opened.session.shareId);
          launch.shares.add(opened.session.shareId);
          if (!current()) return refuse();
          granted = await sharing.grantForDestination(
            guildId,
            channelId,
            (shareId) => shareId === opened.session.shareId,
          );
        } else if (!launch.shares.has(granted.session.shareId)) {
          taken.add(granted.session.shareId);
          launch.shares.add(granted.session.shareId);
        }
        if (!current()) return refuse();
        return granted;
      });
    },
  };
}
