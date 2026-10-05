import { parseDiscordWebhookUrl } from "@clankie/discord-presence-core";
import { OPERATOR_CHANNEL_MEMBER_MAX, type UpsertOperatorChannel } from "@clankie/protocol";
import { randomUUID } from "node:crypto";
import {
  CHANNEL_NOTICE_AUTHOR,
  channelRoundNotice,
  channelTurnReply,
  nextChannelTurn,
  renderChannelTurnPrompt,
  type ChannelTranscriptEntry,
  type ChannelTurnRecord,
} from "../channel-turns.ts";
import { CHANNEL_TURN_TIMEOUT_MS } from "./constants.ts";
import { channelMemberPersonaId } from "./helpers.ts";
import type { ConversationStore } from "./store.ts";
import { type ConversationMeta, type ConversationRunner } from "./types.ts";

/**
 * Create a channel, or restate an existing one's title and roster (ADR 0146).
 * Membership arrives as the whole list the operator wants, in turn order, so
 * a join, a leave, and a reorder are the same write; a member already in the
 * room keeps the `joinedAt` it had.
 */
export async function upsertChannel(
  ctx: ConversationStore,
  request: UpsertOperatorChannel,
): Promise<ConversationMeta> {
  const personaIds = [...new Set(request.members)];
  if (personaIds.length > OPERATOR_CHANNEL_MEMBER_MAX) {
    throw new Error(`A channel holds at most ${OPERATOR_CHANNEL_MEMBER_MAX} members`);
  }
  const channelId = request.channelId ?? `channel-${randomUUID()}`;
  // Everything that can fail happens before a single byte of local state
  // moves. A projection that cannot be reached must not leave behind a room
  // the operator never got, nor a half-applied roster on one they already had.
  const discord =
    request.discord === undefined || request.discord.kind === "off"
      ? undefined
      : await ctx["resolveProjection"](request.discord, channelId, request.title);
  const meta = ctx["create"]({ kind: "channel", channelId }, request.title);
  const previous = new Map(
    (meta.channelMembers ?? []).map((member) => [channelMemberPersonaId(member), member]),
  );
  const now = new Date().toISOString();
  meta.title = request.title;
  meta.channelMembers = personaIds.map((personaId, position) => ({
    personaId,
    position,
    joinedAt: previous.get(personaId)?.joinedAt ?? now,
  }));
  if (request.discord?.kind === "off") {
    ctx["discardProjection"](meta.channelDiscord);
    delete meta.channelDiscord;
    meta.channelDiscordAutoProvision = "disabled";
  } else if (discord !== undefined) {
    // Re-projecting elsewhere retires the old credential the same way
    // unprojecting does; nothing keeps posting through a webhook no room uses.
    if (meta.channelDiscord?.webhookId !== discord.webhookId) {
      ctx["discardProjection"](meta.channelDiscord);
    }
    meta.channelDiscord = discord;
    delete meta.channelDiscordAutoProvision;
  }
  meta.updatedAt = now;
  ctx["saveMeta"](meta);
  // A member is someone the operator can also reach on their own.
  for (const personaId of personaIds) ctx["create"]({ kind: "persona", personaId }, personaId);
  return meta;
}

/**
 * Settle where a room is going in Discord without touching anything local
 * (ADR 0146), so a refusal here costs the operator nothing but the message.
 *
 * One Clankie room per message-bearing Discord location is an invariant, not
 * a preference: inbound guild text is routed by its channel id, which is the
 * direct channel or the forum post's thread. A second room bound to the same
 * location would silently steal or split delivery. Existing locations are
 * checked before provisioning creates anything, and every result is checked
 * again. Forum parents are containers and may hold several distinct posts.
 */
export async function resolveProjection(
  ctx: ConversationStore,
  choice: Exclude<NonNullable<UpsertOperatorChannel["discord"]>, { kind: "off" }>,
  channelId: string,
  title: string,
): Promise<NonNullable<ConversationMeta["channelDiscord"]>> {
  if (ctx["projection"] === undefined) throw new Error("Discord projection is unavailable here");
  // Required before either path resolves, never merely compared against when
  // it happens to be set: an unset managed server is not "no opinion", it is no
  // server Clankie controls, and the fleet may not be put anywhere at all.
  const swarmGuildId = ctx["projection"].currentGuildId
    ? await ctx["projection"].currentGuildId()
    : ctx["projection"].swarmGuildId?.();
  if (swarmGuildId === undefined) {
    throw new Error("Clankie has no swarm server set, so a room cannot go to Discord.");
  }
  if (choice.kind === "webhook") {
    const credential = parseDiscordWebhookUrl(choice.webhookUrl);
    // Resolved before anything is saved: a webhook that cannot be reached is
    // a projection that would silently never post.
    const resolved = { ...(await ctx["projection"].resolve(credential)), ...credential };
    // A pasted URL is otherwise the back door around the swarm fence: a
    // webhook from a guild Clankie merely inhabits would put his agents in a
    // server he does not control, without any grant being involved.
    if (resolved.guildId !== swarmGuildId) {
      throw new Error("That webhook is not in Clankie’s swarm server.");
    }
    const resolvedRoom = (await ctx["projection"].rooms?.())?.find(
      (room) => room.channelId === resolved.channelId,
    );
    if (resolvedRoom?.kind === "forum") {
      throw new Error("A forum webhook does not identify a post; choose the forum from Clankie’s server.");
    }
    ctx["assertRoomUnclaimed"](resolved.channelId, channelId);
    return resolved;
  }
  if (ctx["projection"].provision === undefined) {
    throw new Error("Clankie cannot make Discord channels here; paste one from your swarm server instead");
  }
  // Checked first for a named room: provisioning makes a webhook in Discord,
  // and a refusal afterwards would leave one behind that nothing posts to.
  if (choice.room?.kind === "channel") ctx["assertRoomUnclaimed"](choice.room.channelId, channelId);
  const provisioned = await ctx["projection"].provision({
    name: title,
    ...(choice.room === undefined ? {} : { room: choice.room }),
  });
  // Held to the same fence as a paste. The trusted module answers for the
  // managed server, but a room is only a room here if it landed in the guild this
  // side was told about — a disagreement is a refusal, not a projection.
  if (provisioned.guildId !== swarmGuildId) {
    throw new Error("That Discord room is not in Clankie’s swarm server.");
  }
  if (choice.room?.kind === "forum" && provisioned.threadId === undefined) {
    throw new Error("Discord did not create a post in that forum.");
  }
  ctx["assertRoomUnclaimed"](provisioned.threadId ?? provisioned.channelId, channelId);
  return { ...provisioned, provisioned: true };
}

/** Refuses a Discord channel or forum post another Clankie room already uses. */
export function assertRoomUnclaimed(
  ctx: ConversationStore,
  discordRoomId: string,
  exceptChannelId: string,
): void {
  const claimed = [...ctx["metas"].values()].find(
    (meta) =>
      (meta.channelDiscord?.threadId ?? meta.channelDiscord?.channelId) === discordRoomId &&
      !(meta.scope.kind === "channel" && meta.scope.channelId === exceptChannelId),
  );
  if (claimed !== undefined) {
    // Ends in a full stop deliberately: the operator surface shows a host
    // message verbatim only when it reads as a finished sentence, and the
    // generic fallback here would blame permissions for a naming conflict.
    throw new Error(`That Discord room already holds “${claimed.title}”.`);
  }
}

/**
 * A room's projection, but only while it still points inside the managed server.
 * Records outlive the setting that admitted them: a guild dropped as the
 * managed server, or one projected before this fence existed, must stop routing
 * and stop posting immediately rather than at the next edit. No managed server
 * set means no projection is live at all.
 */
export function liveProjection(
  ctx: ConversationStore,
  meta: ConversationMeta,
): ConversationMeta["channelDiscord"] {
  const swarmGuildId = ctx["projection"]?.swarmGuildId?.();
  return swarmGuildId !== undefined && meta.channelDiscord?.guildId === swarmGuildId
    ? meta.channelDiscord
    : undefined;
}

export function channelMeta(ctx: ConversationStore, channelId: string): ConversationMeta | undefined {
  return [...ctx["metas"].values()].find(
    (meta) => meta.scope.kind === "channel" && meta.scope.channelId === channelId,
  );
}

/**
 * A message typed in the guild a channel is projected onto (ADR 0146). It is
 * the same conversation, so it lands in the shared transcript and runs a round
 * exactly as one sent from the app does — Discord participates, it does not
 * keep a second conversation of its own.
 *
 * Nothing is fenced against a revision here: a surface writing into the one
 * conversation is not a second writer racing the first, and there is no
 * client-held revision on the far side of the gateway to fence with.
 *
 * Who is allowed to speak here is settled before this is called. Discord
 * identity policy lives on the bridge, which is the seat that knows who sent
 * a message; a channel fans one message out to every seat in it, so that
 * decision is never taken on this side.
 */
export function submitProjectedMessage(
  ctx: ConversationStore,
  guildId: string,
  channelId: string,
  message: string,
): { readonly conversationId: string; readonly runId: string } | undefined {
  const meta = [...ctx["metas"].values()].find((candidate) => {
    const live = ctx["liveProjection"](candidate);
    return live?.guildId === guildId && (live.threadId ?? live.channelId) === channelId;
  });
  if (meta === undefined) return undefined;
  // Already on screen in the room it was typed in, so it is not echoed back.
  const result = ctx["enqueue"](meta, message, undefined, true, ctx["channelRound"](false));
  return result.status === "accepted"
    ? { conversationId: meta.conversationId, runId: result.runId }
    : undefined;
}

/**
 * One round of turn-taking (ADR 0146). Members are offered a turn in position
 * order, each prompted with the transcript as it stands at that moment —
 * including a reply that landed a second earlier, which is what lets a member
 * see its point already made and stay quiet.
 *
 * Every member gets at most one turn per operator message. Without that bound
 * two members that each found the other worth replying to would trade
 * messages until something ran out of money; a member with more to say waits
 * for the operator, exactly as a person in a group chat does.
 */
export function channelRound(ctx: ConversationStore, echoOperator: boolean): ConversationRunner {
  return async (conversationId, message, publish, context) => {
    const meta = ctx["metas"].get(conversationId);
    if (meta === undefined) return;
    // A room that showed only the answers would be answering invisible
    // questions, so a message sent from the app is shown in the guild too.
    if (echoOperator) await ctx["projectChannelMessage"](meta, "operator", message);
    const members = meta.channelMembers ?? [];
    const names = new Map(
      await Promise.all(
        members.map(async (member) => {
          const personaId = channelMemberPersonaId(member);
          const presentation = await ctx["personaPresentation"]?.(personaId);
          return [personaId, presentation?.username ?? personaId] as const;
        }),
      ),
    );
    const taken: ChannelTurnRecord[] = [];
    // A member that was never asked, or asked and never heard from, is not
    // the same as one that passed — and telling them apart is the whole
    // difference between a quiet room and a broken one.
    const unreachable: string[] = [];
    const deliveryFailures: string[] = [];
    let spoke = 0;
    for (;;) {
      if (context.signal.aborted) return;
      const member = nextChannelTurn({ members, taken });
      if (member === undefined) break;
      const prompt = renderChannelTurnPrompt({
        title: meta.title,
        member,
        members,
        entries: ctx["channelEntries"](conversationId),
        nameOf: (personaId) => names.get(personaId) ?? personaId,
      });
      // An offline seat passes: the room carries on without it rather than
      // stalling on a pane that is not there to answer.
      const personaId = channelMemberPersonaId(member);
      const seatId = ctx["seatForPersona"] === undefined ? personaId : ctx["seatForPersona"](personaId);
      // Whoever spoke last in the room is who this turn answers, so the edge
      // is drawn from them — captured before the send, because the send is
      // what makes it the previous line.
      const answering = ctx["lastSeatEntry"](conversationId);
      const replyController = new AbortController();
      const pendingReply =
        seatId === undefined
          ? undefined
          : ctx["awaitSeatReply"](seatId, AbortSignal.any([context.signal, replyController.signal]));
      const delivery =
        seatId === undefined
          ? undefined
          : await ctx["sendToSeat"]?.(seatId, prompt, { conversationId, source: "room" });
      const asked = delivery === true || (typeof delivery === "object" && delivery.outcome === "delivered");
      if (asked && seatId !== undefined && answering !== undefined) {
        const fromSeatId =
          ctx["seatForPersona"] === undefined
            ? answering.personaId
            : ctx["seatForPersona"](answering.personaId);
        if (fromSeatId !== undefined && fromSeatId !== seatId) {
          ctx["reportSeatEdge"]?.({
            type: "message",
            fromSeatId,
            toSeatId: seatId,
            conversationId,
            entryId: answering.entryId,
          });
        }
      }
      if (!asked) replyController.abort();
      const reply = await pendingReply;
      replyController.abort();
      const spokenText = channelTurnReply(reply);
      if (spokenText === undefined) {
        const name = names.get(personaId) ?? personaId;
        if (
          typeof delivery === "object" &&
          (delivery.outcome === "unconfirmed" || delivery.outcome === "undelivered")
        ) {
          deliveryFailures.push(
            `${name}: ${delivery.outcome === "unconfirmed" ? "delivery unconfirmed; it may still arrive" : "message not delivered"}. ${delivery.detail}`,
          );
        } else if (!asked || reply === undefined) unreachable.push(name);
        taken.push({ personaId, outcome: "passed" });
        continue;
      }
      publish({ type: "message", role: "agent", text: spokenText, streaming: false, personaId });
      // Published synchronously, so the newest cursor is this line's. Whether
      // it answers anything is the window's to decide.
      if (seatId !== undefined) {
        ctx["reportSeatEdge"]?.({
          type: "turn",
          seatId,
          conversationId,
          entryId: ctx["lastCursor"](meta),
        });
      }
      spoke += 1;
      taken.push({ personaId, outcome: "spoke" });
      await ctx["projectChannelMessage"](meta, personaId, spokenText);
    }
    const notice = channelRoundNotice({ spoke, unreachable, members: members.length });
    if (notice !== undefined && deliveryFailures.length === 0)
      await ctx["projectChannelNotice"](meta, notice);
    if (deliveryFailures.length > 0)
      await ctx["projectChannelNotice"](
        meta,
        `${deliveryFailures.join("\n")}\nInspect the native sessions before resending; no terminal input was sent.`,
      );
  };
}

/**
 * Say in the guild what the transcript has no business recording: that a
 * round reached nobody. It is authored by the room rather than by a member,
 * because no member said it, and it is deliberately not published — the
 * record holds what was said, not why nothing was.
 */
export async function projectChannelNotice(
  ctx: ConversationStore,
  meta: ConversationMeta,
  notice: string,
): Promise<void> {
  await ctx["projectChannelMessage"](meta, CHANNEL_NOTICE_AUTHOR, notice);
}

/**
 * Show one member's words in the guild, as that member. A webhook renders
 * each agent under its own name from one per-channel credential, which is why
 * no seat needs a bot application and certainly not a user account
 * (ADR 0048). Discord is a second surface, so a projection that fails is
 * logged by its absence there and changes nothing here.
 */
export async function projectChannelMessage(
  ctx: ConversationStore,
  meta: ConversationMeta,
  personaId: string,
  content: string,
): Promise<void> {
  if (ctx["projection"] === undefined) return;
  try {
    const presentation =
      personaId === "operator" || personaId === CHANNEL_NOTICE_AUTHOR
        ? { username: personaId }
        : ((await ctx["personaPresentation"]?.(personaId)) ?? { username: personaId });
    if (meta.channelDiscordAutoProvision === "disabled") return;
    if (
      await ctx["projection"].participantPost?.({
        username: presentation.username,
        content: `**${meta.title}**\n${content}`,
      })
    )
      return;
    await ctx["provisionFleetProjection"](meta);
    const target = ctx["liveProjection"](meta);
    if (target === undefined) return;
    const { provisioned: _provisioned, ...credential } = target;
    await ctx["projection"].post({ ...credential, ...presentation, content });
  } catch {
    // The transcript is the record; the room in Discord is a view of it.
  }
}

/** The shared transcript as a member sees it: who said what, oldest first. */
/**
 * The last thing a fleet character said in this thread, and which entry it
 * was. A room turn hands the reader everything said so far, so this is the
 * line the next member is answering — and the one an edge is about.
 *
 * `role` decides authorship: only `agent` is a seat speaking. The operator's
 * own message and the captain's are messages from outside the fleet, and a
 * turn that follows one is nobody's reply.
 */
export function lastSeatEntry(
  ctx: ConversationStore,
  conversationId: string,
): { readonly personaId: string; readonly entryId: string } | undefined {
  const events = ctx["readEvents"](conversationId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "message" || event.role !== "agent") continue;
    const personaId = event.personaId ?? event.seatId;
    if (personaId === undefined) continue;
    return { personaId, entryId: event.cursor };
  }
  return undefined;
}

export function channelEntries(
  ctx: ConversationStore,
  conversationId: string,
): readonly ChannelTranscriptEntry[] {
  return ctx["readEvents"](conversationId).flatMap((event) => {
    if (event.type !== "message" || event.text.trim().length === 0) return [];
    const personaId = event.personaId ?? event.seatId;
    return [{ ...(personaId === undefined ? {} : { personaId }), text: event.text }];
  });
}

/**
 * Park until this seat says its next thing, or until the turn times out and
 * counts as a pass. The reply arrives through the same herdr projection that
 * feeds the seat's own thread, so a channel adds no second way of listening
 * to an agent.
 */
export function awaitSeatReply(
  ctx: ConversationStore,
  seatId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let waiters = ctx["seatReplyWaiters"].get(seatId);
    if (waiters === undefined) {
      waiters = new Set();
      ctx["seatReplyWaiters"].set(seatId, waiters);
    }
    const registered = waiters;
    const settle = (reply: string | undefined): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      registered.delete(settle);
      if (registered.size === 0) ctx["seatReplyWaiters"].delete(seatId);
      resolve(reply);
    };
    const onAbort = (): void => {
      settle(undefined);
    };
    const timer = setTimeout(() => {
      settle(undefined);
    }, CHANNEL_TURN_TIMEOUT_MS);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    registered.add(settle);
  });
}

export function resolveSeatReply(ctx: ConversationStore, seatId: string, text: string): void {
  const waiters = ctx["seatReplyWaiters"].get(seatId);
  if (waiters === undefined) return;
  // One reply answers one offered turn, oldest first. Two messages sent close
  // together run two rounds, and both offer the same seat a turn — handing
  // this text to every waiter would publish the seat's single answer once per
  // round, so the room hears it twice and Discord shows it twice. The seat
  // said it once; the other round keeps waiting for its own answer.
  const [oldest] = waiters;
  oldest?.(text);
}

export async function provisionFleetProjection(
  ctx: ConversationStore,
  meta: ConversationMeta,
): Promise<void> {
  const pending = ctx["channelProjectionCreates"].get(meta.conversationId);
  if (pending !== undefined) return pending;
  if (
    meta.scope.kind !== "channel" ||
    meta.channelDiscord !== undefined ||
    meta.channelDiscordAutoProvision !== undefined ||
    !(await ctx["projection"]?.autoProvision?.())
  )
    return;
  // A concurrent first message may have finished its settings read before this one.
  const concurrent = ctx["channelProjectionCreates"].get(meta.conversationId);
  if (concurrent !== undefined) return concurrent;
  if (meta.channelDiscord !== undefined || meta.channelDiscordAutoProvision !== undefined) return;
  const channelId = meta.scope.channelId;
  meta.channelDiscordAutoProvision = "uncertain";
  ctx["saveMeta"](meta);
  const creation = (async () => {
    const destination = await ctx["resolveProjection"]({ kind: "provision" }, channelId, meta.title);
    meta.channelDiscord = destination;
    delete meta.channelDiscordAutoProvision;
    ctx["saveMeta"](meta);
  })();
  ctx["channelProjectionCreates"].set(meta.conversationId, creation);
  try {
    await creation;
  } finally {
    ctx["channelProjectionCreates"].delete(meta.conversationId);
  }
}
