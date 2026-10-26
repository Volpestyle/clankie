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
 * Each launch is its own incarnation and owns the shares it opened. Stop or
 * relaunch retires it; an admission that began under a retired launch is
 * refused after any await, and cleanup ends only retired launches' shares, so
 * neither a stale admission nor its cleanup touches a replacement's media
 * (VUH-2833 review).
 */
export function createActivityLaunches(sharing: DestinationSharing) {
  interface Launch {
    shares: Set<string>;
    opening?: Promise<string>;
  }
  const launched = new Map<string, Launch>();
  const retired = new Map<string, Set<Launch>>();
  const key = (guildId: string, channelId: string) => `${guildId}:${channelId}`;
  const allow = async () => true;
  const owner = (destination: string, shareId: string): Launch | undefined => {
    const current = launched.get(destination);
    if (current?.shares.has(shareId)) return current;
    for (const launch of retired.get(destination) ?? []) if (launch.shares.has(shareId)) return launch;
    return undefined;
  };
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
    launched(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      retire(destination);
      launched.set(destination, { shares: new Set() });
    },
    async stopped(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      retire(destination);
      for (const launch of retired.get(destination) ?? []) {
        // A share a retired launch is still opening must exist before it is ended.
        // allow-swallowed-rejection -- the admission that started this opening reports its failure; stop only needs it settled
        await launch.opening?.catch(() => undefined);
        await stopShares(launch.shares);
        retired.get(destination)?.delete(launch);
      }
    },
    async grant(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      const launch = launched.get(destination);
      if (launch === undefined) throw new Error("activity_destination_refused");
      const current = () => launched.get(destination) === launch;
      const refused = () => new Error("activity_destination_refused");
      // Reuse this launch's share, or claim one nobody owns yet: a share a
      // retired launch is still opening becomes this launch's, and that
      // retired launch's cleanup then no longer reaches it.
      const reusable = (shareId: string) => {
        const by = owner(destination, shareId);
        return by === undefined || by === launch;
      };
      const claim = (granted: Awaited<ReturnType<DestinationSharing["grantForDestination"]>>) => {
        if (!current()) throw refused();
        launch.shares.add(granted.session.shareId);
        return granted;
      };
      try {
        return claim(await sharing.grantForDestination(guildId, channelId, reusable));
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "activity_share_gone") throw error;
      }
      if (!current()) throw refused();
      if (launch.opening === undefined) {
        const opening = sharing
          .request({ action: "start", sourceId: "play", guildId, channelId }, allow)
          .then((result) => {
            const shareId = (result as { session: ActivityShareSession }).session.shareId;
            // A replacement may already have claimed it.
            if (owner(destination, shareId) === undefined) launch.shares.add(shareId);
            return shareId;
          });
        launch.opening = opening;
        void opening.then(
          () => {
            if (launch.opening === opening) delete launch.opening;
          },
          () => {
            if (launch.opening === opening) delete launch.opening;
          },
        );
      }
      const shareId = await launch.opening;
      if (!current()) {
        // Retired while this share opened: end it unless a replacement claimed it.
        if (launch.shares.has(shareId)) await stopShares(new Set([shareId]));
        throw refused();
      }
      return claim(await sharing.grantForDestination(guildId, channelId, (id) => id === shareId));
    },
  };
}
