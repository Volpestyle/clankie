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
 * Where Clankie's own bot launched the Activity, and the play share each such
 * channel watches. Admission grants only these destinations: a participant in
 * an instance someone else started elsewhere gets nothing. A share is opened on
 * the first admission while play is running, so `/activity` may come before or
 * after play starts, and a later play session gets a fresh share.
 */
export function createActivityLaunches(sharing: DestinationSharing) {
  // One object per launch. Stop or relaunch replaces it, so an admission that
  // began under an older launch can tell, after any await, that it lost its
  // authority (VUH-2833 review).
  const launched = new Map<string, object>();
  const opening = new Map<string, { launch: object; done: Promise<unknown> }>();
  const key = (guildId: string, channelId: string) => `${guildId}:${channelId}`;
  const allow = async () => true;
  const stopDestination = async (guildId: string, channelId: string) => {
    const listed = (await sharing.request({ action: "list" }, allow)) as {
      sessions: ActivityShareSession[];
    };
    for (const session of listed.sessions)
      if (session.scope.guildId === guildId && session.scope.channelId === channelId)
        await sharing
          .request({ action: "stop", shareId: session.shareId, generation: session.generation }, allow)
          // allow-swallowed-rejection -- the launch is already forgotten, so no new viewer is admitted, and a share that cannot be stopped still ends at its own expiry
          .catch(() => undefined);
  };
  return {
    launched(guildId: string, channelId: string) {
      launched.set(key(guildId, channelId), {});
    },
    async stopped(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      launched.delete(destination);
      // A share an in-flight admission is still opening must exist before the
      // listing below, or it would outlive this stop.
      // allow-swallowed-rejection -- the admission that started this opening reports its failure; stop only needs it settled
      await opening.get(destination)?.done.catch(() => undefined);
      await stopDestination(guildId, channelId);
    },
    async grant(guildId: string, channelId: string) {
      const destination = key(guildId, channelId);
      const launch = launched.get(destination);
      const current = () => launch !== undefined && launched.get(destination) === launch;
      const refused = () => new Error("activity_destination_refused");
      if (!current()) throw refused();
      let granted: Awaited<ReturnType<DestinationSharing["grantForDestination"]>> | undefined;
      try {
        granted = await sharing.grantForDestination(guildId, channelId);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "activity_share_gone") throw error;
      }
      if (!current()) throw refused();
      if (granted !== undefined) return granted;
      let open = opening.get(destination);
      if (open === undefined || open.launch !== launch) {
        const done = sharing.request({ action: "start", sourceId: "play", guildId, channelId }, allow);
        const entry = { launch: launch!, done };
        opening.set(destination, entry);
        void done.then(
          () => {
            if (opening.get(destination) === entry) opening.delete(destination);
          },
          () => {
            if (opening.get(destination) === entry) opening.delete(destination);
          },
        );
        open = entry;
      }
      await open.done;
      if (!current()) {
        // Stopped while this share opened: end it rather than leave it running.
        await stopDestination(guildId, channelId);
        throw refused();
      }
      granted = await sharing.grantForDestination(guildId, channelId);
      if (!current()) throw refused();
      return granted;
    },
  };
}
