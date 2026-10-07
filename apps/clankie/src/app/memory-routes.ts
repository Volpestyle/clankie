import {
  CaptainEpisodeEditSchema,
  CaptainEpisodeSchema,
  CaptainSessionLaneV2Schema,
  DiscordPersonIdentitySchema,
  DiscordPersonMemoryEditSchema,
  DiscordPersonMemoryFactSchema,
  type DiscordPersonIdentity,
  type DiscordPersonMemoryFact,
  type DomainEvent,
} from "@clankie/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { MemoryConflictError } from "../memory.ts";
import { authenticateCaptain, authenticateOperator, readJson } from "./http-auth.ts";
import { type ClankieAppDependencies } from "./types.ts";
const DiscordPersonMemoryProposalRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().min(1).max(256),
    fact: DiscordPersonMemoryFactSchema,
  })
  .strict();

const DiscordPersonMemoryReadQuerySchema = z
  .object({
    channelId: z.string().min(1).max(64).optional(),
    query: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

/** Episodes are the captain's own, so they share one stream. */
const CAPTAIN_EPISODE_STREAM_ID = "captain:episodes";

function discordPersonMemoryEventStreamId(identity: DiscordPersonIdentity): string {
  const subject = DiscordPersonIdentitySchema.parse(identity);
  return `discord-person:${subject.guildId}:${subject.userId}`;
}
export interface RegisterMemoryRoutesContext {
  readonly app: Hono;
  readonly dependencies: ClankieAppDependencies;
  readonly recordEvent: (
    type: string,
    streamId: string,
    occurredAt: string,
    data: Record<string, unknown>,
    envelope?: { correlationId?: string },
  ) => DomainEvent;
  readonly clock: () => Date;
  readonly idFactory: () => string;
}

export function registerMemoryRoutes(ctx: RegisterMemoryRoutesContext) {
  /**
   * Discord person memory. The approval ceremony left with the governance
   * machinery: a proposal from an authenticated Discord captain applies
   * directly, upserted by factId.
   */
  ctx.app.get("/v1/memory", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    return context.json(ctx.dependencies.memory.catalog());
  });

  ctx.app.post("/v1/memory/discord-people/proposals", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "memory_proposal_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "memory_proposal_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const parsed = DiscordPersonMemoryProposalRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_person_memory_proposal" }, 400);
    const fact = ctx.dependencies.memory.storeDiscordPersonFact(parsed.data.fact);
    ctx.recordEvent(
      "discord.person-memory.committed",
      discordPersonMemoryEventStreamId(fact.subject),
      ctx.clock().toISOString(),
      { proposalId: parsed.data.proposalId, factId: fact.factId },
      { correlationId: fact.provenance.correlationId },
    );
    return context.json({ schemaVersion: 1, proposalId: parsed.data.proposalId, fact }, 201);
  });

  ctx.app.get("/v1/memory/discord-people/:guildId/:userId/export", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    if (!identity.success) return context.json({ error: "invalid_discord_person_identity" }, 400);
    const exported = ctx.dependencies.memory.exportDiscordPerson(identity.data, ctx.clock());
    ctx.recordEvent(
      "discord.person-memory.exported",
      discordPersonMemoryEventStreamId(identity.data),
      ctx.clock().toISOString(),
      { factCount: exported.facts.length, operatorId: operator.operatorId },
    );
    return context.json(exported);
  });

  ctx.app.delete("/v1/memory/discord-people/:guildId/:userId", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    if (!identity.success) return context.json({ error: "invalid_discord_person_identity" }, 400);
    const deletedFactIds = ctx.dependencies.memory.deleteDiscordPerson(identity.data);
    ctx.recordEvent(
      "discord.person-memory.deleted",
      discordPersonMemoryEventStreamId(identity.data),
      ctx.clock().toISOString(),
      { deletedFactIds, operatorId: operator.operatorId },
    );
    return context.json({ schemaVersion: 1, subject: identity.data, deletedFactIds });
  });

  ctx.app.patch("/v1/memory/discord-people/:guildId/:userId/:factId", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    const factId = z.string().trim().min(1).max(256).safeParse(context.req.param("factId"));
    const edit = DiscordPersonMemoryEditSchema.safeParse(await readJson(context.req.raw));
    if (!identity.success || !factId.success || !edit.success) {
      return context.json({ error: "invalid_discord_person_memory_edit" }, 400);
    }
    let fact: DiscordPersonMemoryFact | undefined;
    try {
      fact = ctx.dependencies.memory.updateDiscordPersonFact(identity.data, factId.data, edit.data);
    } catch {
      return context.json({ error: "invalid_discord_person_memory_edit" }, 400);
    }
    if (fact === undefined) return context.json({ error: "discord_person_memory_fact_not_found" }, 404);
    ctx.recordEvent(
      "discord.person-memory.edited",
      discordPersonMemoryEventStreamId(identity.data),
      ctx.clock().toISOString(),
      { factId: fact.factId, operatorId: operator.operatorId },
    );
    return context.json(fact);
  });

  ctx.app.delete("/v1/memory/discord-people/:guildId/:userId/:factId", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    const factId = z.string().trim().min(1).max(256).safeParse(context.req.param("factId"));
    if (!identity.success || !factId.success) {
      return context.json({ error: "invalid_discord_person_memory_identity" }, 400);
    }
    if (!ctx.dependencies.memory.deleteDiscordPersonFact(identity.data, factId.data)) {
      return context.json({ error: "discord_person_memory_fact_not_found" }, 404);
    }
    ctx.recordEvent(
      "discord.person-memory.fact-deleted",
      discordPersonMemoryEventStreamId(identity.data),
      ctx.clock().toISOString(),
      { factId: factId.data, operatorId: operator.operatorId },
    );
    return context.body(null, 204);
  });

  ctx.app.get("/v1/memory/discord-people/:guildId/:userId", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "memory_recall_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "memory_recall_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    const query = DiscordPersonMemoryReadQuerySchema.safeParse(context.req.query());
    if (!identity.success || !query.success) {
      return context.json({ error: "invalid_discord_person_memory_recall" }, 400);
    }
    const options = {
      ...(query.data.channelId === undefined ? {} : { channelId: query.data.channelId }),
      now: ctx.clock(),
    };
    const facts = ctx.dependencies.memory.listDiscordPerson(identity.data, options);
    const recallCard =
      query.data.query === undefined
        ? undefined
        : ctx.dependencies.memory.recallDiscordPersonCard(identity.data, {
            ...options,
            query: query.data.query,
          });
    ctx.recordEvent(
      "discord.person-memory.recalled",
      discordPersonMemoryEventStreamId(identity.data),
      ctx.clock().toISOString(),
      { factCount: facts.length, querySupplied: query.data.query !== undefined },
      { correlationId: `discord-person-memory:recall:${ctx.idFactory()}` },
    );
    return context.json({
      schemaVersion: 1,
      subject: identity.data,
      facts,
      ...(recallCard === undefined ? {} : { recallCard }),
    });
  });

  ctx.app.post("/v1/memory/captain-episodes", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "episode_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "episode_authentication_required" }, 401);
    const episode = CaptainEpisodeSchema.safeParse(await readJson(context.req.raw));
    if (!episode.success) return context.json({ error: "invalid_captain_episode" }, 400);
    // A Discord bearer writes the room it serves and nothing else. The body
    // names its own lane, so without this a bridge could author an operator or
    // gameplay memory — the same elevation `authenticateLane` exists to stop on
    // the read side.
    const bearerLane =
      captain.steerSourceLane === "discord_text"
        ? "discord_presence"
        : captain.steerSourceLane === "discord_voice"
          ? "discord_voice"
          : undefined;
    if (bearerLane !== undefined && episode.data.lane !== bearerLane) {
      return context.json({ error: "captain_episode_lane_forbidden" }, 403);
    }
    const source = captain.episodeSource;
    if (source === undefined) return context.json({ error: "captain_episode_source_required" }, 403);
    if (episode.data.lane !== source.lane || episode.data.targetId !== source.targetId)
      return context.json({ error: "captain_episode_source_forbidden" }, 403);
    let recorded;
    try {
      recorded = ctx.dependencies.memory.recordEpisode({
        ...episode.data,
        sourceConversationId: source.conversationId,
        provenance: {
          characterId: "clankie",
          sessionId: source.sessionId,
          selfAuthored: true,
          rawTranscript: false,
        },
      });
    } catch (error) {
      // Recording never edits. An id the store already holds is a conflict, not
      // an upsert, so the memory it names is still there afterwards.
      if (error instanceof MemoryConflictError) {
        return context.json({ error: error.code, message: error.message }, 409);
      }
      throw error;
    }
    ctx.recordEvent(
      "captain.episode.recorded",
      CAPTAIN_EPISODE_STREAM_ID,
      ctx.clock().toISOString(),
      {
        lane: recorded.lane,
        visibility: recorded.visibility,
        // The summary itself is deliberately absent from the log.
        summaryLength: recorded.summary.length,
      },
      { correlationId: `captain-episode:record:${ctx.idFactory()}` },
    );
    return context.json({ schemaVersion: 1, episodeId: recorded.episodeId });
  });

  /**
   * Recall is scoped by the lane the caller declares; the fence that matters is
   * upstream in the captain's own instruction hook. A Discord-scoped bearer can
   * never read the operator lane, whatever it asks for.
   */
  ctx.app.get("/v1/memory/captain-episodes", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "episode_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "episode_authentication_required" }, 401);
    const lane = CaptainSessionLaneV2Schema.safeParse(context.req.query("lane"));
    if (!lane.success) return context.json({ error: "invalid_captain_episode_lane" }, 400);
    const discordBearer =
      captain.steerSourceLane === "discord_text" || captain.steerSourceLane === "discord_voice";
    if (discordBearer && lane.data === "operator") {
      return context.json({ error: "operator_lane_recall_forbidden" }, 403);
    }
    // With a query this is on-demand recall over everything he kept; without
    // one it stays the bounded recent card. Same route, same lane fence, and
    // the same answer shape: a rendered card. Returning records instead would
    // hand a social bearer the provenance ids the recall branch withholds —
    // a second door to more fields on the lane it already reaches.
    const query = context.req.query("query")?.trim();
    if (query !== undefined && query.length > 0) {
      const limit = z.coerce.number().int().positive().safeParse(context.req.query("limit"));
      return context.json({
        schemaVersion: 1,
        lane: lane.data,
        query,
        recallCard: ctx.dependencies.memory.searchEpisodeCard({
          lane: lane.data,
          query,
          ...(limit.success ? { limit: limit.data } : {}),
        }),
      });
    }
    return context.json({
      schemaVersion: 1,
      lane: lane.data,
      recallCard: ctx.dependencies.memory.episodeRecallCard({ lane: lane.data }),
    });
  });

  ctx.app.patch("/v1/memory/captain-episodes/:lane/:episodeId", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const lane = CaptainSessionLaneV2Schema.safeParse(context.req.param("lane"));
    const episodeId = z.string().trim().min(1).max(256).safeParse(context.req.param("episodeId"));
    const edit = CaptainEpisodeEditSchema.safeParse(await readJson(context.req.raw));
    if (!lane.success || !episodeId.success || !edit.success) {
      return context.json({ error: "invalid_captain_episode_edit" }, 400);
    }
    const episode = ctx.dependencies.memory.updateEpisode(lane.data, episodeId.data, edit.data);
    if (episode === undefined) return context.json({ error: "captain_episode_not_found" }, 404);
    ctx.recordEvent("captain.episode.edited", CAPTAIN_EPISODE_STREAM_ID, ctx.clock().toISOString(), {
      episodeId: episode.episodeId,
      lane: episode.lane,
      operatorId: operator.operatorId,
      summaryLength: episode.summary.length,
      visibility: episode.visibility,
    });
    return context.json(episode);
  });

  ctx.app.delete("/v1/memory/captain-episodes/:lane/:episodeId", async (context) => {
    if (!ctx.dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const lane = CaptainSessionLaneV2Schema.safeParse(context.req.param("lane"));
    const episodeId = z.string().trim().min(1).max(256).safeParse(context.req.param("episodeId"));
    if (!lane.success || !episodeId.success) {
      return context.json({ error: "invalid_captain_episode_identity" }, 400);
    }
    if (!ctx.dependencies.memory.deleteEpisode(lane.data, episodeId.data)) {
      return context.json({ error: "captain_episode_not_found" }, 404);
    }
    ctx.recordEvent("captain.episode.deleted", CAPTAIN_EPISODE_STREAM_ID, ctx.clock().toISOString(), {
      episodeId: episodeId.data,
      lane: lane.data,
      operatorId: operator.operatorId,
    });
    return context.body(null, 204);
  });
}
