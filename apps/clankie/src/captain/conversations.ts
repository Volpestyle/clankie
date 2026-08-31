import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  OPERATOR_CHANNEL_MEMBER_MAX,
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  OPERATOR_CONVERSATION_TEXT_MAX,
  type DiscordGuildRoom,
  type DiscordGuildRoomTarget,
  type OperatorChannel,
  type OperatorChannelMember,
  type OperatorConversation,
  type OperatorConversationContextUsage,
  type OperatorConversationEventBody,
  type OperatorConversationLiveDraft,
  type OperatorConversationReactor,
  type OperatorConversationScope,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type OperatorConversationStreamEvent,
  type ReplayOperatorConversationRequest,
  type ReplayOperatorConversationResult,
  type SubmitOperatorConversationTurn,
  type SubmitOperatorConversationTurnResult,
  type UpsertOperatorChannel,
} from "@clankie/protocol";
import { parseDiscordWebhookUrl } from "@clankie/discord-presence-core";
import {
  CHANNEL_NOTICE_AUTHOR,
  CHANNEL_ROUND_INTERRUPTED_NOTICE,
  channelRoundNotice,
  channelTurnReply,
  nextChannelTurn,
  renderChannelTurnPrompt,
  type ChannelTranscriptEntry,
  type ChannelTurnRecord,
} from "./channel-turns.ts";
import type {
  HerdrSeatTranscript,
  HerdrTranscriptEntry,
  HerdrTranscriptMessage,
} from "./herdr-transcript.ts";

type ConversationServiceRequest = Exclude<
  OperatorConversationServiceRequest,
  | { op: "autonomy" }
  | { op: "roster" }
  | { op: "fleet" }
  | { op: "composer_catalog" }
  | { op: "state_stance" }
  | { op: "personas" }
  | { op: "update_persona" }
  | { op: "terminal_catalog" }
  | { op: "close_seat" }
  | { op: "spawn_seat" }
  | { op: "terminal_tail" }
  | { op: "terminal_control" }
  | { op: "terminal_input" }
>;
type ConversationServiceResult = Exclude<
  OperatorConversationServiceResult,
  | { op: "autonomy" }
  | { op: "roster" }
  | { op: "fleet" }
  | { op: "composer_catalog" }
  | { op: "state_stance" }
  | { op: "personas" }
  | { op: "update_persona" }
  | { op: "terminal_catalog" }
  | { op: "close_seat" }
  | { op: "spawn_seat" }
  | { op: "terminal_tail" }
  | { op: "terminal_control" }
  | { op: "terminal_input" }
>;

const CURSOR_WIDTH = 12;
const ZERO_CURSOR = "0".repeat(CURSOR_WIDTH);
/** Under the relay's 30s upstream dispatch timeout, with headroom. */
const DEFAULT_TAIL_WAIT_MS = 25_000;
export const OPERATOR_CONVERSATION_RETAINED_MAX = 64;
export const OPERATOR_CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const OPERATOR_CONVERSATION_RETAINED_BYTES_MAX = 256 * 1024 * 1024;
export const OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX = 500;
const OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM = 400;
const SEAT_CONVERSATION_RETAINED_EVENTS_MAX = 10_000;
const SEAT_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM = 9_000;
/**
 * How long one member's turn may hold up the round before it counts as a pass.
 * A member that never answers must not wedge the room: the operator is waiting
 * on the whole round, not on any one seat.
 */
const CHANNEL_TURN_TIMEOUT_MS = 5 * 60 * 1_000;

interface SeatTranscriptCheckpoint {
  readonly sessionKey: string;
  readonly entryIds?: readonly string[];
  /** Pre-tool transcript checkpoints; read once and rewritten as `entryIds`. */
  readonly messageIds?: readonly string[];
}

interface ConversationMeta {
  readonly conversationId: string;
  scope: OperatorConversationScope;
  title: string;
  isDefault: boolean;
  readonly createdAt: string;
  updatedAt: string;
  revision: number;
  sessionState: OperatorConversation["sessionState"];
  contextUsage?: OperatorConversationContextUsage;
  readonly parentConversationId?: string;
  /** Exclusive replay boundary immediately before the oldest retained event. */
  retainedFromCursor?: string;
  /** Harness-native messages already folded into this durable persona thread. */
  seatTranscript?: SeatTranscriptCheckpoint;
  /**
   * The channel roster, in turn order. Present exactly on a `channel` scope
   * (ADR 0146); it lives on the meta so pruning the conversation takes the
   * membership with it and the two can never disagree.
   */
  channelMembers?: readonly OperatorChannelMember[];
  /**
   * Where this channel is projected, and the credential to post there. The
   * token lives here and nowhere else: `publicChannel` carries the webhook id
   * so a surface can tell a projected channel from an unprojected one, and
   * never the half that can post.
   */
  channelDiscord?: {
    readonly guildId: string;
    /** The direct channel, or the parent forum that owns the webhook. */
    readonly channelId: string;
    /** The forum post carrying this room, when projected into a forum. */
    readonly threadId?: string;
    readonly webhookId: string;
    readonly webhookToken: string;
    /**
     * Clankie made this webhook, so unprojecting or deleting the room deletes
     * it in Discord too. Absent on a pasted webhook — the operator made that
     * one by hand and keeps it — and on records from before the flag existed,
     * which are treated as pasted rather than guessed at.
     */
    readonly provisioned?: true;
  };
}

/** Optional seat for a turn that arrived from a herdr-hosted console. */
interface ConversationTurnSeat {
  readonly herdrPaneId: string;
}

/** Where a turn runs and who it arrived from. */
export interface ConversationTurnContext {
  /**
   * Absolute directory the conversation's session works in, from a workspace
   * scope. Absent for a global conversation, which works in the service repo.
   */
  readonly workspace?: string;
  readonly seat?: ConversationTurnSeat;
  readonly internal?: true;
  /** Side conversations inherit a Pi branch but never continue their parent's active task. */
  readonly side?: true;
  /** Conversation-store run id; one metrics line uses this, including absorbed steers. */
  readonly runId: string;
  readonly acceptedAt: string;
  /** Aborts when the operator interrupts this run (`cancel` op); the runner stops the live model turn. */
  readonly signal: AbortSignal;
  /**
   * Show the message being typed, or `undefined` to take it down. Volatile: it
   * reaches watching surfaces through the tail's `live` field and never becomes
   * a durable event. The runner throttles; the store just holds the latest.
   */
  readonly draft: (text: string | undefined) => void;
}

/** Runs one accepted operator turn against the captain's model session. */
export type ConversationRunner = (
  conversationId: string,
  message: string,
  publish: (event: OperatorConversationEventBody) => void,
  context: ConversationTurnContext,
) => Promise<void>;

type SeatSender = (seatId: string, message: string) => Promise<boolean>;
type PersonaSeatResolver = (personaId: string) => string | undefined;
type PersonaPresentation = (personaId: string) => Promise<{
  readonly username: string;
  readonly avatarUrl?: string;
}>;
/**
 * Posts one agent's words into the guild a channel is projected onto
 * (ADR 0146). Discord renders and participates; it owns nothing. A post that
 * fails must therefore never cost the conversation its own record of what was
 * said, so the round treats this as best-effort.
 */
export interface ChannelProjection {
  post: (post: {
    readonly guildId: string;
    readonly channelId: string;
    readonly threadId?: string;
    readonly webhookId: string;
    readonly webhookToken: string;
    readonly username: string;
    readonly avatarUrl?: string;
    readonly content: string;
  }) => Promise<void>;
  /** Which room a webhook points at, so the operator supplies only its URL. */
  resolve: (credential: { readonly webhookId: string; readonly webhookToken: string }) => Promise<{
    readonly guildId: string;
    readonly channelId: string;
  }>;
  /**
   * Make the webhook rather than being handed one — on a fresh room, or on an
   * existing container named by `room`. A forum container gets one new post.
   * Absent where the bot lacks
   * `Manage Webhooks` in the swarm home, which is the one case the manual
   * pasted webhook is for; a host with no Discord runtime at all has no swarm
   * home either, and projects nothing by any path.
   */
  provision?: (input: { readonly name: string; readonly room?: DiscordGuildRoomTarget }) => Promise<{
    readonly guildId: string;
    readonly channelId: string;
    readonly threadId?: string;
    readonly webhookId: string;
    readonly webhookToken: string;
  }>;
  /** The swarm home's rooms, so an existing one can be picked to project onto. */
  rooms?: () => Promise<readonly DiscordGuildRoom[]>;
  /** The one guild rooms may live in, which a pasted webhook is held to. */
  swarmGuildId?: () => string | undefined;
  /**
   * Delete one webhook in Discord — the cleanup half of `provision`, called
   * when a room is unprojected or removed. Authenticated by the token itself,
   * like `resolve`, so it needs no bot grant. Best-effort: a webhook already
   * gone is success, and a failure never blocks the local change.
   */
  remove?: (credential: { readonly webhookId: string; readonly webhookToken: string }) => Promise<void>;
}
type ConversationForker = (input: {
  readonly parentConversationId: string;
  readonly conversationId: string;
  readonly workspace?: string;
}) => Promise<void>;

/**
 * A workspace scope names the directory the conversation's session works in.
 * That directory becomes the cwd of an unsandboxed shell, so the registry
 * refuses anything but an absolute path that already resolves to a directory —
 * a conversation is never created pointing at a path the caller invented.
 */
function workspaceOf(scope: OperatorConversationScope): string | undefined {
  if (scope.kind !== "workspace") return undefined;
  const workspace = scope.workspaceId;
  if (!isAbsolute(workspace)) {
    throw new Error(`Workspace ${workspace} is not an absolute path`);
  }
  return workspace;
}

function messageKey(role: "operator" | "agent", text: string): string {
  return `${role}\u0000${text}`;
}

function transcriptEventBody(entry: HerdrTranscriptEntry): OperatorConversationEventBody {
  if (entry.type === "message") {
    return { type: "message", role: entry.role, text: entry.text, streaming: false };
  }
  return {
    type: "tool",
    toolCallId: entry.toolCallId,
    name: entry.name,
    phase: entry.phase,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  };
}

/**
 * File-backed conversation registry: `meta.json` + append-only `events.jsonl`
 * per conversation. The wire contract (list/get/create/close/replay/tail/send with
 * revision fencing and cursored pages) is the one the TUI and relay speak.
 * Cursors are zero-padded line counts.
 */
export class ConversationStore {
  private readonly metas = new Map<string, ConversationMeta>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Promise<boolean>>();
  /** Live (accepted, unsettled) runs an operator `cancel` can interrupt. */
  private readonly runControllers = new Map<
    string,
    { readonly conversationId: string; readonly controller: AbortController }
  >();
  private readonly cancelRequests = new Set<string>();
  private readonly seatSends = new Map<string, Promise<void>>();
  /**
   * Rounds parked on what a seat says next (ADR 0146). A seat may sit in more
   * than one channel, and every round waiting on it hears the same reply rather
   * than one round queueing behind another and stalling the room.
   */
  private readonly seatReplyWaiters = new Map<string, Set<(reply: string | undefined) => void>>();
  private readonly runCounts = new Map<string, number>();
  /** Internal turns whose `invoke()` has begun and not yet settled — not merely queued. */
  private readonly internalRuns = new Map<string, number>();

  private readonly root: string;
  private readonly runner: ConversationRunner;
  private readonly onPrune: ((conversationId: string, scope: OperatorConversationScope) => void) | undefined;
  private readonly sendToSeat: SeatSender | undefined;
  private readonly forkConversation: ConversationForker | undefined;
  private readonly projection: ChannelProjection | undefined;
  private readonly seatForPersona: PersonaSeatResolver | undefined;
  private readonly personaPresentation: PersonaPresentation | undefined;
  /** Longest a parked tail may wait here, whatever a caller asks for. */
  private readonly tailWaitMs: number;
  /** Per-conversation parked tails, woken by `append` and by a live draft. */
  private readonly tailListeners = new Map<string, Set<() => void>>();
  /** The message the captain is typing right now, per conversation. Never durable. */
  private readonly drafts = new Map<string, OperatorConversationLiveDraft>();
  private draftSequence = 0;

  public constructor(
    root: string,
    runner: ConversationRunner,
    onPrune?: (conversationId: string, scope: OperatorConversationScope) => void,
    sendToSeat?: SeatSender,
    tailWaitMs = DEFAULT_TAIL_WAIT_MS,
    forkConversation?: ConversationForker,
    projection?: ChannelProjection,
    seatForPersona?: PersonaSeatResolver,
    personaPresentation?: PersonaPresentation,
  ) {
    this.root = root;
    this.runner = runner;
    this.onPrune = onPrune;
    this.sendToSeat = sendToSeat;
    this.tailWaitMs = tailWaitMs;
    this.forkConversation = forkConversation;
    this.projection = projection;
    this.seatForPersona = seatForPersona;
    this.personaPresentation = personaPresentation;
    mkdirSync(root, { recursive: true });
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(
          readFileSync(join(root, entry.name, "meta.json"), "utf8"),
        ) as ConversationMeta;
        // A crash mid-run leaves "active"; on boot nothing is running.
        if (meta.sessionState === "active") {
          meta.sessionState = "waiting";
          // Settling the run stops a tailing client hanging forever, but the
          // room it was answering hears nothing at all — which is how an
          // operator came to type into a dead round five times. One line, once
          // per room however many runs it lost, and never fatal to boot.
          if (this.failOrphanedRuns(meta) > 0 && meta.scope.kind === "channel") {
            void this.projectChannelNotice(meta, CHANNEL_ROUND_INTERRUPTED_NOTICE);
          }
        }
        this.metas.set(meta.conversationId, meta);
      } catch {
        // An unreadable conversation is skipped, never fatal to boot.
      }
    }
    // Side forks have no resumable console owner after a service restart.
    for (const meta of this.metas.values()) {
      if (meta.parentConversationId !== undefined) this.remove(meta);
    }
    this.ensureDefaultGlobalConversation();
    this.prune();
  }

  /**
   * Remote clients may still explicitly select the default global conversation,
   * so the store guarantees exactly one even though each TUI process starts a
   * fresh conversation.
   */
  private ensureDefaultGlobalConversation(): void {
    const defaults = [...this.metas.values()]
      .filter((meta) => meta.scope.kind === "global" && meta.isDefault)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const demoted of defaults.slice(1)) {
      demoted.isDefault = false;
      this.saveMeta(demoted);
    }
    if (defaults.length > 0) return;
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: "global-default",
      scope: { kind: "global" },
      title: "Clankie",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "unbound",
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
  }

  /**
   * A turn accepted before a crash never got its terminal event, and a client
   * mid-tail would wait on it forever. Close each orphan out as failed.
   */
  private failOrphanedRuns(meta: ConversationMeta): number {
    const terminal = new Set<string>();
    const accepted: string[] = [];
    for (const event of this.readEvents(meta.conversationId)) {
      if (event.type !== "turn") continue;
      if (event.phase === "accepted") accepted.push(event.runId);
      else terminal.add(event.runId);
    }
    const orphans = accepted.filter((id) => !terminal.has(id));
    for (const runId of orphans) {
      this.append(meta, { type: "turn", runId, phase: "failed", reasonCode: "service_restarted" });
    }
    return orphans.length;
  }

  public async serve(request: ConversationServiceRequest): Promise<ConversationServiceResult> {
    switch (request.op) {
      case "list": {
        const conversations = [...this.metas.values()]
          .filter((meta) => request.scope === undefined || sameScope(meta.scope, request.scope))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((meta) => publicConversation(meta));
        return { op: "list", schemaVersion: 1, conversations };
      }
      case "get": {
        const meta = this.metas.get(request.conversationId);
        return {
          op: "get",
          schemaVersion: 1,
          ...(meta === undefined ? {} : { conversation: publicConversation(meta) }),
        };
      }
      case "create":
        // A channel is created with its membership or not at all — an empty
        // room nobody is in is a conversation with no counterpart. Selecting a
        // channel that already exists is just selecting it.
        if (request.scope.kind === "channel" && this.channelMeta(request.scope.channelId) === undefined) {
          throw new Error("Create a channel with the channel op, which carries its membership");
        }
        return {
          op: "create",
          schemaVersion: 1,
          conversation: publicConversation(this.create(request.scope, request.title)),
        };
      case "channel": {
        const meta = await this.upsertChannel(request.channel);
        return {
          op: "channel",
          schemaVersion: 1,
          channel: publicChannel(meta),
          conversation: publicConversation(meta),
        };
      }
      case "channels":
        return {
          op: "channels",
          schemaVersion: 1,
          channels: [...this.metas.values()]
            .filter((meta) => meta.scope.kind === "channel")
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((meta) => publicChannel(meta)),
        };
      case "discord_rooms":
        return {
          op: "discord_rooms",
          schemaVersion: 1,
          // Empty rather than an error where no Discord runtime can list them,
          // or where no swarm home is set: the compose screen still opens, and
          // says what it can offer rather than failing to draw.
          rooms: [...((await this.projection?.rooms?.()) ?? [])],
        };
      case "react":
        return {
          op: "react",
          schemaVersion: 1,
          conversationId: request.conversationId,
          entryRef: request.entryRef,
          reacted: this.react(
            request.conversationId,
            request.entryRef,
            request.emoji,
            { kind: "operator" },
            request.remove,
          ),
        };
      case "fork":
        return {
          op: "fork",
          schemaVersion: 1,
          conversation: await this.fork(request.parentConversationId),
        };
      case "close":
        return {
          op: "close",
          schemaVersion: 1,
          conversationId: request.conversationId,
          closed: await this.removeConversation(request.conversationId),
        };
      case "replay":
        return { op: "replay", schemaVersion: 1, result: this.replay(request.replay) };
      case "tail": {
        // Hanging long-poll: a page with no news parks until this conversation
        // changes (or the wait elapses), so an idle tail costs one request per
        // wait window instead of one per client poll interval, and a live draft
        // reaches the surface as fast as the round trip allows. "No news" means
        // no unseen event AND no draft the caller has not already drawn.
        let result = this.replay(request.tail);
        const waitMs = Math.min(request.tail.waitMs ?? 0, this.tailWaitMs);
        if (waitMs > 0 && result.status === "page" && result.events.length === 0 && !result.hasMore) {
          if ((result.live?.sequence ?? 0) === (request.tail.liveSequence ?? 0)) {
            await this.waitForChange(request.tail.conversationId, waitMs);
            result = this.replay(request.tail);
          }
        }
        return { op: "tail", schemaVersion: 1, result };
      }
      case "send":
        return { op: "send", schemaVersion: 1, result: await this.send(request.turn) };
      case "cancel":
        return {
          op: "cancel",
          schemaVersion: 1,
          conversationId: request.conversationId,
          runId: request.runId,
          cancelled: this.cancel(request.conversationId, request.runId),
        };
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown operator conversation op ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Interrupt one accepted run. A live run's abort signal fires (the captain
   * stops the model turn); a still-queued run settles as cancelled without ever
   * invoking the runner. Unknown or already settled runs report false.
   */
  public cancel(conversationId: string, runId: string): boolean {
    const entry = this.runControllers.get(runId);
    if (entry === undefined || entry.conversationId !== conversationId) return false;
    this.cancelRequests.add(runId);
    entry.controller.abort();
    return true;
  }

  /** Keeps an accepted detached run alive for the transport's waitUntil. */
  public awaitRun(runId: string): Promise<void> {
    return this.runs.get(runId)?.then(() => undefined) ?? Promise.resolve();
  }

  public awaitRunResult(runId: string): Promise<boolean> {
    return this.runs.get(runId) ?? Promise.resolve(false);
  }

  public has(conversationId: string): boolean {
    return this.metas.has(conversationId);
  }

  public conversation(conversationId: string): OperatorConversation | undefined {
    const meta = this.metas.get(conversationId);
    return meta === undefined ? undefined : publicConversation(meta);
  }

  /**
   * Whether Clankie himself answers here. He does in his own global and
   * workspace rooms; he does not in a persona thread, where the counterpart is
   * that agent, nor in a channel, where the members answer (ADR 0146). Every
   * caller that would hand him a turn asks this first.
   */
  public runsCaptainTurns(conversationId: string): boolean {
    const kind = this.metas.get(conversationId)?.scope.kind;
    return kind === "global" || kind === "workspace";
  }

  public conversationIdForSeat(seatId: string): string | undefined {
    return [...this.metas.values()].find((meta) => meta.scope.kind === "seat" && meta.scope.seatId === seatId)
      ?.conversationId;
  }

  public conversationIdForPersona(personaId: string): string | undefined {
    return [...this.metas.values()].find(
      (meta) => meta.scope.kind === "persona" && meta.scope.personaId === personaId,
    )?.conversationId;
  }

  public renamePersona(personaId: string, title: string): void {
    const conversationId = this.conversationIdForPersona(personaId);
    const meta = conversationId === undefined ? undefined : this.metas.get(conversationId);
    if (meta === undefined || meta.title === title) return;
    meta.title = title;
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
  }

  /**
   * Bind a durable character to its current seat and carry any legacy seat DM
   * and channel membership forward without copying or splitting transcripts.
   */
  public bindPersona(personaId: string, seatId: string, title: string): string {
    const current = this.conversationIdForPersona(personaId);
    if (current !== undefined) this.renamePersona(personaId, title);
    const legacy =
      current === undefined
        ? [...this.metas.values()].find((meta) => meta.scope.kind === "seat" && meta.scope.seatId === seatId)
        : undefined;
    if (legacy !== undefined && current === undefined) {
      legacy.scope = { kind: "persona", personaId };
      legacy.title = title;
      legacy.updatedAt = new Date().toISOString();
      this.saveMeta(legacy);
    }
    for (const channel of this.metas.values()) {
      if (channel.scope.kind !== "channel" || channel.channelMembers === undefined) continue;
      let changed = false;
      channel.channelMembers = channel.channelMembers.map((member) => {
        const raw = member as OperatorChannelMember & { readonly seatId?: string };
        if (raw.seatId !== seatId) return member;
        changed = true;
        return { personaId, position: member.position, joinedAt: member.joinedAt };
      });
      if (changed) this.saveMeta(channel);
    }
    return (
      current ?? legacy?.conversationId ?? this.create({ kind: "persona", personaId }, title).conversationId
    );
  }

  public seatIds(): readonly string[] {
    return [...this.metas.values()].flatMap((meta) =>
      meta.scope.kind === "seat" ? [meta.scope.seatId] : [],
    );
  }

  public publishPersonaEvent(personaId: string, seatId: string, body: OperatorConversationEventBody): void {
    // Before the seat's own thread, and regardless of whether it has one: a
    // channel round offered this seat a turn and is waiting on exactly this.
    if (body.type === "message" && body.role === "agent") this.resolveSeatReply(seatId, body.text);
    const conversationId = this.conversationIdForPersona(personaId);
    this.publishConversationEvent(conversationId, body);
  }

  /** Legacy test/API path while persisted seat scopes migrate on discovery. */
  public publishSeatEvent(seatId: string, body: OperatorConversationEventBody): void {
    if (body.type === "message" && body.role === "agent") this.resolveSeatReply(seatId, body.text);
    this.publishConversationEvent(this.conversationIdForSeat(seatId), body);
  }

  private publishConversationEvent(
    conversationId: string | undefined,
    body: OperatorConversationEventBody,
  ): void {
    const meta = conversationId === undefined ? undefined : this.metas.get(conversationId);
    if (meta === undefined) return;
    const events = this.readEvents(meta.conversationId);
    if (body.type === "activity") {
      const previous = events.reverse().find((event) => event.type === "activity");
      if (previous?.type === "activity" && previous.phase === body.phase) return;
    }
    if (body.type === "message" && body.role === "agent") {
      const previous = events.reverse().find((event) => event.type === "message" && event.role === "agent");
      if (previous?.type === "message" && previous.role === "agent" && previous.text === body.text) return;
    }
    this.append(meta, body);
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
  }

  /** Fold one harness session's complete active chat branch into its durable persona thread. */
  public syncPersonaTranscript(personaId: string, seatId: string, transcript: HerdrSeatTranscript): void {
    const conversationId = this.conversationIdForPersona(personaId);
    this.syncConversationTranscript(conversationId, seatId, transcript);
  }

  /** Legacy test/API path while persisted seat scopes migrate on discovery. */
  public syncSeatTranscript(seatId: string, transcript: HerdrSeatTranscript): void {
    this.syncConversationTranscript(this.conversationIdForSeat(seatId), seatId, transcript);
  }

  private syncConversationTranscript(
    conversationId: string | undefined,
    seatId: string,
    transcript: HerdrSeatTranscript,
  ): void {
    const meta = conversationId === undefined ? undefined : this.metas.get(conversationId);
    if (meta === undefined || transcript.entries.length === 0) return;
    const checkpoint = meta.seatTranscript;
    if (checkpoint === undefined && this.retainedEventCount(meta.conversationId) > 0) {
      this.replaceSeatEntries(meta, transcript.entries);
      meta.seatTranscript = {
        sessionKey: transcript.sessionKey,
        entryIds: transcript.entries.map(({ id }) => id),
      };
      this.saveMeta(meta);
      return;
    }

    // ponytail: legacy checkpoints append their newly typed historical tools once;
    // add a cursor/reaction-remapping migration only if pre-upgrade ordering matters.
    const checkpointIds = checkpoint?.entryIds ?? checkpoint?.messageIds ?? [];
    const seen = new Set(checkpoint?.sessionKey === transcript.sessionKey ? checkpointIds : []);
    let latestAgentReply: string | undefined;
    for (const entry of transcript.entries) {
      if (seen.has(entry.id)) continue;
      if (entry.type === "message" && entry.role === "agent") latestAgentReply = entry.text;
      if (entry.type !== "message" || entry.role !== "operator" || !this.matchesRecentSeatSend(meta, entry)) {
        this.append(meta, transcriptEventBody(entry), entry.occurredAt);
      }
      seen.add(entry.id);
    }
    meta.seatTranscript = { sessionKey: transcript.sessionKey, entryIds: [...seen] };
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    if (latestAgentReply !== undefined) this.resolveSeatReply(seatId, latestAgentReply);
  }

  /** Queue a host-authored continuation without forging an operator message. */
  public submitInternal(conversationId: string, message: string): SubmitOperatorConversationTurnResult {
    const meta = this.metas.get(conversationId);
    if (meta === undefined) throw new Error(`Unknown conversation ${conversationId}`);
    if (!this.runsCaptainTurns(conversationId)) {
      throw new Error(`Conversation ${conversationId} does not run captain turns`);
    }
    return this.enqueue(meta, message, undefined, false);
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...this.runs.values(), ...this.seatSends.values()]);
  }

  private create(scope: OperatorConversationScope, title: string): ConversationMeta {
    if (scope.kind === "persona") {
      const existing = this.conversationIdForPersona(scope.personaId);
      if (existing !== undefined) return this.metas.get(existing)!;
    }
    if (scope.kind === "seat") {
      const existing = this.conversationIdForSeat(scope.seatId);
      if (existing !== undefined) return this.metas.get(existing)!;
    }
    if (scope.kind === "channel") {
      const existing = this.channelMeta(scope.channelId);
      if (existing !== undefined) return existing;
    }
    const workspace = workspaceOf(scope);
    if (workspace !== undefined && !statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Workspace ${workspace} is not a directory on this machine`);
    }
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: `conv-${randomUUID()}`,
      scope,
      title,
      // The boot-seeded global conversation owns default; created ones never do.
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "unbound",
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
    this.prune(meta.conversationId);
    return meta;
  }

  /**
   * Create a channel, or restate an existing one's title and roster (ADR 0146).
   * Membership arrives as the whole list the operator wants, in turn order, so
   * a join, a leave, and a reorder are the same write; a member already in the
   * room keeps the `joinedAt` it had.
   */
  private async upsertChannel(request: UpsertOperatorChannel): Promise<ConversationMeta> {
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
        : await this.resolveProjection(request.discord, channelId, request.title);
    const meta = this.create({ kind: "channel", channelId }, request.title);
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
      this.discardProjection(meta.channelDiscord);
      delete meta.channelDiscord;
    } else if (discord !== undefined) {
      // Re-projecting elsewhere retires the old credential the same way
      // unprojecting does; nothing keeps posting through a webhook no room uses.
      if (meta.channelDiscord?.webhookId !== discord.webhookId) {
        this.discardProjection(meta.channelDiscord);
      }
      meta.channelDiscord = discord;
    }
    meta.updatedAt = now;
    this.saveMeta(meta);
    // A member is someone the operator can also reach on their own.
    for (const personaId of personaIds) this.create({ kind: "persona", personaId }, personaId);
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
  private async resolveProjection(
    choice: Exclude<NonNullable<UpsertOperatorChannel["discord"]>, { kind: "off" }>,
    channelId: string,
    title: string,
  ): Promise<NonNullable<ConversationMeta["channelDiscord"]>> {
    if (this.projection === undefined) throw new Error("Discord projection is unavailable here");
    // Required before either path resolves, never merely compared against when
    // it happens to be set: an unset swarm home is not "no opinion", it is no
    // server Clankie controls, and the fleet may not be put anywhere at all.
    const swarmGuildId = this.projection.swarmGuildId?.();
    if (swarmGuildId === undefined) {
      throw new Error("Clankie has no swarm server set, so a room cannot go to Discord.");
    }
    if (choice.kind === "webhook") {
      const credential = parseDiscordWebhookUrl(choice.webhookUrl);
      // Resolved before anything is saved: a webhook that cannot be reached is
      // a projection that would silently never post.
      const resolved = { ...(await this.projection.resolve(credential)), ...credential };
      // A pasted URL is otherwise the back door around the swarm fence: a
      // webhook from a guild Clankie merely inhabits would put his agents in a
      // server he does not control, without any grant being involved.
      if (resolved.guildId !== swarmGuildId) {
        throw new Error("That webhook is not in Clankie’s swarm server.");
      }
      const resolvedRoom = (await this.projection.rooms?.())?.find(
        (room) => room.channelId === resolved.channelId,
      );
      if (resolvedRoom?.kind === "forum") {
        throw new Error("A forum webhook does not identify a post; choose the forum from Clankie’s server.");
      }
      this.assertRoomUnclaimed(resolved.channelId, channelId);
      return resolved;
    }
    if (this.projection.provision === undefined) {
      throw new Error("Clankie cannot make Discord channels here; paste one from your swarm server instead");
    }
    // Checked first for a named room: provisioning makes a webhook in Discord,
    // and a refusal afterwards would leave one behind that nothing posts to.
    if (choice.room?.kind === "channel") this.assertRoomUnclaimed(choice.room.channelId, channelId);
    const provisioned = await this.projection.provision({
      name: title,
      ...(choice.room === undefined ? {} : { room: choice.room }),
    });
    // Held to the same fence as a paste. The trusted module answers for the
    // swarm home, but a room is only a room here if it landed in the guild this
    // side was told about — a disagreement is a refusal, not a projection.
    if (provisioned.guildId !== swarmGuildId) {
      throw new Error("That Discord room is not in Clankie’s swarm server.");
    }
    if (choice.room?.kind === "forum" && provisioned.threadId === undefined) {
      throw new Error("Discord did not create a post in that forum.");
    }
    this.assertRoomUnclaimed(provisioned.threadId ?? provisioned.channelId, channelId);
    return { ...provisioned, provisioned: true };
  }

  /** Refuses a Discord channel or forum post another Clankie room already uses. */
  private assertRoomUnclaimed(discordRoomId: string, exceptChannelId: string): void {
    const claimed = [...this.metas.values()].find(
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
   * A room's projection, but only while it still points inside the swarm home.
   * Records outlive the setting that admitted them: a guild dropped as the
   * swarm home, or one projected before this fence existed, must stop routing
   * and stop posting immediately rather than at the next edit. No swarm home
   * set means no projection is live at all.
   */
  private liveProjection(meta: ConversationMeta): ConversationMeta["channelDiscord"] {
    const swarmGuildId = this.projection?.swarmGuildId?.();
    return swarmGuildId !== undefined && meta.channelDiscord?.guildId === swarmGuildId
      ? meta.channelDiscord
      : undefined;
  }

  private channelMeta(channelId: string): ConversationMeta | undefined {
    return [...this.metas.values()].find(
      (meta) => meta.scope.kind === "channel" && meta.scope.channelId === channelId,
    );
  }

  /**
   * Put a reaction on one entry, or take it back off (ADR 0146). The entry is
   * never rewritten: the reaction is its own append-only event, and the set
   * standing on an entry is the fold of those.
   */
  private react(
    conversationId: string,
    entryRef: string,
    emoji: string,
    reactor: OperatorConversationReactor,
    remove: boolean,
  ): boolean {
    const meta = this.metas.get(conversationId);
    if (meta === undefined) return false;
    if (!this.readEvents(conversationId).some((event) => event.cursor === entryRef)) return false;
    this.append(meta, { type: "reaction", entryRef, emoji, reactor, removed: remove });
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    return true;
  }

  private async fork(parentConversationId: string): Promise<OperatorConversation> {
    const parent = this.metas.get(parentConversationId);
    if (parent === undefined) throw new Error(`Unknown conversation ${parentConversationId}`);
    if (!this.runsCaptainTurns(parentConversationId)) {
      throw new Error("Only Clankie's own conversations can be forked");
    }
    if (parent.parentConversationId !== undefined) throw new Error("A side conversation is already open");
    if ([...this.metas.values()].some((meta) => meta.parentConversationId === parentConversationId)) {
      throw new Error("A side conversation is already open");
    }
    if (this.forkConversation === undefined) throw new Error("Side conversations are unavailable");

    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: `conv-${randomUUID()}`,
      scope: parent.scope,
      title: "BTW",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "waiting",
      parentConversationId,
      ...(parent.contextUsage === undefined ? {} : { contextUsage: parent.contextUsage }),
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
    try {
      const workspace = workspaceOf(parent.scope);
      await this.forkConversation({
        parentConversationId,
        conversationId: meta.conversationId,
        ...(workspace === undefined ? {} : { workspace }),
      });
    } catch (error) {
      this.remove(meta);
      throw error;
    }
    this.prune(meta.conversationId);
    return publicConversation(meta);
  }

  private replay(request: ReplayOperatorConversationRequest): ReplayOperatorConversationResult {
    const meta = this.metas.get(request.conversationId);
    if (meta === undefined) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: request.conversationId,
        code: "unknown_conversation",
        recoverable: false,
        resetCursor: ZERO_CURSOR,
        message: "No conversation with that id exists here.",
      };
    }
    const events = this.readEvents(meta.conversationId);
    const retainedFromCursor = meta.retainedFromCursor ?? ZERO_CURSOR;
    const safeCursor = events.length === 0 ? retainedFromCursor : events[events.length - 1]!.cursor;
    const rawFrom = request.cursor ?? ZERO_CURSOR;
    if (!/^\d+$/u.test(rawFrom) || rawFrom.length > CURSOR_WIDTH) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_invalid",
        recoverable: true,
        resetCursor: retainedFromCursor,
        message: "That cursor is not from this conversation; replay from the start.",
      };
    }
    // Cursors compare lexically, so a short numeric cursor pads first.
    const from = rawFrom.padStart(CURSOR_WIDTH, "0");
    if (from < retainedFromCursor) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_expired",
        recoverable: true,
        resetCursor: retainedFromCursor,
        message: "Older conversation events expired; replay from the retained boundary.",
      };
    }
    if (from > safeCursor) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_reset",
        recoverable: true,
        resetCursor: safeCursor,
        message: "That cursor is ahead of this conversation; resume from its latest event.",
      };
    }
    const limit = request.limit ?? 200;
    const remaining = events.filter((event) => event.cursor > from);
    const page = remaining.slice(0, limit);
    return {
      schemaVersion: 1,
      status: "page",
      conversationId: meta.conversationId,
      surfaceClientId: request.surfaceClientId,
      events: page,
      retainedFromCursor,
      nextCursor: page.length === 0 ? from : page[page.length - 1]!.cursor,
      safeCursor,
      hasMore: page.length < remaining.length,
      // The volatile half of the page: what he is typing right now. A surface
      // that ignores it still gets every settled message from `events`.
      ...(this.drafts.has(meta.conversationId) ? { live: this.drafts.get(meta.conversationId)! } : {}),
    };
  }

  private async send(turn: SubmitOperatorConversationTurn): Promise<SubmitOperatorConversationTurnResult> {
    const meta = this.metas.get(turn.conversationId);
    if (meta === undefined) {
      throw new Error(`Unknown conversation ${turn.conversationId}`);
    }
    if (meta.scope.kind === "seat") {
      return this.queueSeatSend(meta, meta.scope.seatId, turn, { seatId: meta.scope.seatId });
    }
    if (meta.scope.kind === "persona") {
      const seatId =
        this.seatForPersona === undefined ? meta.scope.personaId : this.seatForPersona(meta.scope.personaId);
      return this.queueSeatSend(meta, seatId, turn, { personaId: meta.scope.personaId });
    }
    const safeCursor = this.lastCursor(meta);
    if (turn.expectedRevision !== meta.revision) {
      return {
        schemaVersion: 1,
        status: "revision_conflict",
        conversationId: meta.conversationId,
        expectedRevision: turn.expectedRevision,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    // In a channel the members answer, not Clankie. The run is the sequenced
    // round; everything else about an accepted turn — revision, cancellation,
    // settlement, retention — is the same as any other.
    return this.enqueue(
      meta,
      turn.message,
      turn.herdrPaneId,
      true,
      meta.scope.kind === "channel" ? this.channelRound(true) : this.runner,
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
  public submitProjectedMessage(
    guildId: string,
    channelId: string,
    message: string,
  ): { readonly conversationId: string; readonly runId: string } | undefined {
    const meta = [...this.metas.values()].find((candidate) => {
      const live = this.liveProjection(candidate);
      return live?.guildId === guildId && (live.threadId ?? live.channelId) === channelId;
    });
    if (meta === undefined) return undefined;
    // Already on screen in the room it was typed in, so it is not echoed back.
    const result = this.enqueue(meta, message, undefined, true, this.channelRound(false));
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
  private channelRound(echoOperator: boolean): ConversationRunner {
    return async (conversationId, message, publish, context) => {
      const meta = this.metas.get(conversationId);
      if (meta === undefined) return;
      // A room that showed only the answers would be answering invisible
      // questions, so a message sent from the app is shown in the guild too.
      if (echoOperator) await this.projectChannelMessage(meta, "operator", message);
      const members = meta.channelMembers ?? [];
      const names = new Map(
        await Promise.all(
          members.map(async (member) => {
            const personaId = channelMemberPersonaId(member);
            const presentation = await this.personaPresentation?.(personaId);
            return [personaId, presentation?.username ?? personaId] as const;
          }),
        ),
      );
      const taken: ChannelTurnRecord[] = [];
      // A member that was never asked, or asked and never heard from, is not
      // the same as one that passed — and telling them apart is the whole
      // difference between a quiet room and a broken one.
      const unreachable: string[] = [];
      let spoke = 0;
      for (;;) {
        if (context.signal.aborted) return;
        const member = nextChannelTurn({ members, taken });
        if (member === undefined) break;
        const prompt = renderChannelTurnPrompt({
          title: meta.title,
          member,
          members,
          entries: this.channelEntries(conversationId),
          nameOf: (personaId) => names.get(personaId) ?? personaId,
        });
        // An offline seat passes: the room carries on without it rather than
        // stalling on a pane that is not there to answer.
        const personaId = channelMemberPersonaId(member);
        const seatId = this.seatForPersona === undefined ? personaId : this.seatForPersona(personaId);
        const asked = seatId !== undefined && (await this.sendToSeat?.(seatId, prompt)) === true;
        const reply = asked ? await this.awaitSeatReply(seatId, context.signal) : undefined;
        const spokenText = channelTurnReply(reply);
        if (spokenText === undefined) {
          if (!asked || reply === undefined) unreachable.push(names.get(personaId) ?? personaId);
          taken.push({ personaId, outcome: "passed" });
          continue;
        }
        publish({ type: "message", role: "agent", text: spokenText, streaming: false, personaId });
        spoke += 1;
        taken.push({ personaId, outcome: "spoke" });
        await this.projectChannelMessage(meta, personaId, spokenText);
      }
      const notice = channelRoundNotice({ spoke, unreachable, members: members.length });
      if (notice !== undefined) await this.projectChannelNotice(meta, notice);
    };
  }

  /**
   * Say in the guild what the transcript has no business recording: that a
   * round reached nobody. It is authored by the room rather than by a member,
   * because no member said it, and it is deliberately not published — the
   * record holds what was said, not why nothing was.
   */
  private async projectChannelNotice(meta: ConversationMeta, notice: string): Promise<void> {
    await this.projectChannelMessage(meta, CHANNEL_NOTICE_AUTHOR, notice);
  }

  /**
   * Show one member's words in the guild, as that member. A webhook renders
   * each agent under its own name from one per-channel credential, which is why
   * no seat needs a bot application and certainly not a user account
   * (ADR 0048). Discord is a second surface, so a projection that fails is
   * logged by its absence there and changes nothing here.
   */
  private async projectChannelMessage(
    meta: ConversationMeta,
    personaId: string,
    content: string,
  ): Promise<void> {
    const target = this.liveProjection(meta);
    if (target === undefined || this.projection === undefined) return;
    try {
      const presentation =
        personaId === "operator" || personaId === CHANNEL_NOTICE_AUTHOR
          ? { username: personaId }
          : ((await this.personaPresentation?.(personaId)) ?? { username: personaId });
      const { provisioned: _provisioned, ...credential } = target;
      await this.projection.post({ ...credential, ...presentation, content });
    } catch {
      // The transcript is the record; the room in Discord is a view of it.
    }
  }

  /** The shared transcript as a member sees it: who said what, oldest first. */
  private channelEntries(conversationId: string): readonly ChannelTranscriptEntry[] {
    return this.readEvents(conversationId).flatMap((event) => {
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
  private awaitSeatReply(seatId: string, signal: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve) => {
      let waiters = this.seatReplyWaiters.get(seatId);
      if (waiters === undefined) {
        waiters = new Set();
        this.seatReplyWaiters.set(seatId, waiters);
      }
      const registered = waiters;
      const settle = (reply: string | undefined): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        registered.delete(settle);
        if (registered.size === 0) this.seatReplyWaiters.delete(seatId);
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

  private resolveSeatReply(seatId: string, text: string): void {
    const waiters = this.seatReplyWaiters.get(seatId);
    if (waiters === undefined) return;
    // One reply answers one offered turn, oldest first. Two messages sent close
    // together run two rounds, and both offer the same seat a turn — handing
    // this text to every waiter would publish the seat's single answer once per
    // round, so the room hears it twice and Discord shows it twice. The seat
    // said it once; the other round keeps waiting for its own answer.
    const [oldest] = waiters;
    oldest?.(text);
  }

  private queueSeatSend(
    meta: ConversationMeta,
    seatId: string | undefined,
    turn: SubmitOperatorConversationTurn,
    offlineIdentity: { readonly seatId: string } | { readonly personaId: string },
  ): Promise<SubmitOperatorConversationTurnResult> {
    const previous = this.seatSends.get(meta.conversationId) ?? Promise.resolve();
    const pending = previous.then(() => this.deliverSeatTurn(meta, seatId, offlineIdentity, turn));
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    this.seatSends.set(meta.conversationId, settled);
    void settled.finally(() => {
      if (this.seatSends.get(meta.conversationId) === settled) this.seatSends.delete(meta.conversationId);
    });
    return pending;
  }

  private async deliverSeatTurn(
    meta: ConversationMeta,
    seatId: string | undefined,
    offlineIdentity: { readonly seatId: string } | { readonly personaId: string },
    turn: SubmitOperatorConversationTurn,
  ): Promise<SubmitOperatorConversationTurnResult> {
    const safeCursor = this.lastCursor(meta);
    if (turn.expectedRevision !== meta.revision) {
      return {
        schemaVersion: 1,
        status: "revision_conflict",
        conversationId: meta.conversationId,
        expectedRevision: turn.expectedRevision,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    if (seatId === undefined || !(await this.sendToSeat?.(seatId, turn.message))) {
      return {
        schemaVersion: 1,
        status: "seat_offline",
        conversationId: meta.conversationId,
        ...offlineIdentity,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    const runId = `run-${randomUUID()}`;
    meta.revision += 1;
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    this.append(meta, { type: "message", role: "operator", text: turn.message, streaming: false });
    this.append(meta, { type: "turn", runId, phase: "accepted" });
    this.append(meta, { type: "turn", runId, phase: "completed" });
    this.prune(meta.conversationId);
    return {
      schemaVersion: 1,
      status: "accepted",
      conversationId: meta.conversationId,
      runId,
      revision: meta.revision,
      safeCursor,
    };
  }

  private enqueue(
    meta: ConversationMeta,
    message: string,
    herdrPaneId: string | undefined,
    publishOperatorMessage: boolean,
    runner: ConversationRunner = this.runner,
  ): SubmitOperatorConversationTurnResult {
    const workspace = workspaceOf(meta.scope);
    const safeCursor = this.lastCursor(meta);
    meta.revision += 1;
    meta.sessionState = "active";
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    const runId = `run-${randomUUID()}`;
    if (publishOperatorMessage) {
      this.append(meta, { type: "message", role: "operator", text: message, streaming: false });
    }
    this.append(meta, { type: "turn", runId, phase: "accepted" });

    const conversationId = meta.conversationId;
    this.runCounts.set(conversationId, (this.runCounts.get(conversationId) ?? 0) + 1);
    const controller = new AbortController();
    this.runControllers.set(runId, { conversationId, controller });
    // Steer only while an autonomous invoke is in flight. A continuation still
    // sitting on the FIFO must not open the lane — that let a later human send
    // jump an in-flight human turn (ADR 0091 / ADR 0130).
    const joinLiveInternal = publishOperatorMessage && (this.internalRuns.get(conversationId) ?? 0) > 0;

    const previous = this.chains.get(conversationId) ?? Promise.resolve();
    const invoke = (): Promise<void> => {
      // Cancelled while still queued: settle without ever invoking the runner.
      if (controller.signal.aborted) return Promise.resolve();
      if (!publishOperatorMessage) {
        this.internalRuns.set(conversationId, (this.internalRuns.get(conversationId) ?? 0) + 1);
      }
      meta.sessionState = "active";
      this.saveMeta(meta);
      return runner(
        conversationId,
        message,
        (event) => {
          this.append(meta, event);
        },
        {
          runId,
          acceptedAt: meta.updatedAt,
          signal: controller.signal,
          draft: (text) => {
            this.setLiveDraft(conversationId, text);
          },
          ...(publishOperatorMessage ? {} : { internal: true as const }),
          ...(meta.parentConversationId === undefined ? {} : { side: true as const }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(herdrPaneId === undefined ? {} : { seat: { herdrPaneId } }),
        },
      );
    };
    // A human send during an in-flight autonomous turn is admitted now so the
    // captain can steer it into the live pi run (ADR 0091). Other pairs stay FIFO.
    const work = joinLiveInternal ? invoke() : previous.then(invoke);
    const run = work
      .then(() => {
        const cancelled = this.cancelRequests.has(runId);
        this.append(
          meta,
          cancelled
            ? { type: "turn", runId, phase: "cancelled", reasonCode: "operator_interrupt" }
            : { type: "turn", runId, phase: "completed" },
        );
        if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "waiting";
        return !cancelled;
      })
      .catch((error: unknown) => {
        // An interrupt that surfaces as a runner throw is still a cancellation,
        // not a failure.
        if (this.cancelRequests.has(runId)) {
          this.append(meta, { type: "turn", runId, phase: "cancelled", reasonCode: "operator_interrupt" });
          if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "waiting";
          return false;
        }
        // A bare class name ("Error") tells the operator nothing. The message is
        // the only thing that names the actual failure, so it rides along; the
        // stack goes to the service log for anything the summary truncates.
        console.error(`operator turn ${runId} failed`, error);
        this.append(meta, {
          type: "turn",
          runId,
          phase: "failed",
          reasonCode: error instanceof Error ? error.constructor.name : "run_failed",
          summary: turnFailureSummary(error),
        });
        if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "failed";
        return false;
      })
      .finally(() => {
        meta.updatedAt = new Date().toISOString();
        this.saveMeta(meta);
        this.trimEventLog(meta);
        this.runs.delete(runId);
        this.runControllers.delete(runId);
        this.cancelRequests.delete(runId);
        const remaining = (this.runCounts.get(conversationId) ?? 1) - 1;
        if (remaining <= 0) this.runCounts.delete(conversationId);
        else this.runCounts.set(conversationId, remaining);
        // Nothing is typing here any more: a draft stranded by a failed or
        // interrupted turn comes down with the last run, not on the next one.
        if (remaining <= 0) this.setLiveDraft(conversationId, undefined);
        if (!publishOperatorMessage) {
          const remainingInternal = (this.internalRuns.get(conversationId) ?? 1) - 1;
          if (remainingInternal <= 0) this.internalRuns.delete(conversationId);
          else this.internalRuns.set(conversationId, remainingInternal);
        }
        this.prune(conversationId);
      });
    this.chains.set(
      conversationId,
      joinLiveInternal
        ? Promise.all([previous, run.then(() => undefined)]).then(() => undefined)
        : run.then(() => undefined),
    );
    this.runs.set(runId, run);
    return {
      schemaVersion: 1,
      status: "accepted",
      conversationId: meta.conversationId,
      runId,
      revision: meta.revision,
      safeCursor,
    };
  }

  private append(meta: ConversationMeta, body: OperatorConversationEventBody, occurredAt?: string): void {
    const retainedCount = this.retainedEventCount(meta.conversationId);
    const sequence = this.eventSequence(meta) + 1;
    const cursor = String(sequence).padStart(CURSOR_WIDTH, "0");
    const event: OperatorConversationStreamEvent = {
      schemaVersion: 1,
      conversationId: meta.conversationId,
      cursor,
      revision: meta.revision,
      occurredAt: occurredAt ?? new Date().toISOString(),
      ...body,
    } as OperatorConversationStreamEvent;
    appendFileSync(this.eventsPath(meta.conversationId), `${JSON.stringify(event)}\n`, "utf8");
    this.counts.set(meta.conversationId, retainedCount + 1);
    this.sequences.set(meta.conversationId, sequence);
    if (body.type === "context") {
      meta.contextUsage = body.usage;
      this.saveMeta(meta);
    }
    if (meta.sessionState !== "active") this.trimEventLog(meta);
    this.wakeTails(meta.conversationId);
  }

  private waitForChange(conversationId: string, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      let listeners = this.tailListeners.get(conversationId);
      if (listeners === undefined) {
        listeners = new Set();
        this.tailListeners.set(conversationId, listeners);
      }
      const registered = listeners;
      const done = (): void => {
        clearTimeout(timer);
        registered.delete(done);
        if (registered.size === 0) this.tailListeners.delete(conversationId);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      registered.add(done);
    });
  }

  private wakeTails(conversationId: string): void {
    const listeners = this.tailListeners.get(conversationId);
    if (listeners === undefined) return;
    // Each listener removes only itself as it resolves, and a set never
    // revisits an element it has already yielded, so this walks the live set.
    for (const listener of listeners) listener();
  }

  /**
   * The captain's answer as it is being typed ([ADR 0141](../../../../docs/adr/0141-the-console-watches-him-type.md)).
   * A draft is volatile: it lives in memory, never in `events.jsonl`, so replay,
   * retention, cursors, and every surface that only wants the record are
   * untouched by streaming. `undefined` takes the draft down — the durable
   * `message` event that settles it is the record. Callers throttle; every call
   * wakes the parked tails.
   */
  public setLiveDraft(conversationId: string, text: string | undefined): void {
    if (!this.metas.has(conversationId)) return;
    if (text === undefined || text.length === 0) {
      if (this.drafts.delete(conversationId)) this.wakeTails(conversationId);
      return;
    }
    this.draftSequence += 1;
    this.drafts.set(conversationId, {
      sequence: this.draftSequence,
      role: "captain",
      text: text.slice(0, OPERATOR_CONVERSATION_TEXT_MAX),
    });
    this.wakeTails(conversationId);
  }

  private readonly counts = new Map<string, number>();
  private readonly sequences = new Map<string, number>();

  private retainedEventCount(conversationId: string): number {
    const cached = this.counts.get(conversationId);
    if (cached !== undefined) return cached;
    const count = this.readEvents(conversationId).length;
    this.counts.set(conversationId, count);
    return count;
  }

  private eventSequence(meta: ConversationMeta): number {
    const cached = this.sequences.get(meta.conversationId);
    if (cached !== undefined) return cached;
    const events = this.readEvents(meta.conversationId);
    const cursor = events[events.length - 1]?.cursor ?? meta.retainedFromCursor ?? ZERO_CURSOR;
    const sequence = Number.parseInt(cursor, 10);
    this.sequences.set(meta.conversationId, sequence);
    return sequence;
  }

  private lastCursor(meta: ConversationMeta): string {
    return String(this.eventSequence(meta)).padStart(CURSOR_WIDTH, "0");
  }

  private trimEventLog(meta: ConversationMeta): void {
    // A persona thread and a channel are both durable rooms an agent keeps talking
    // in; Clankie's own conversations turn over with his sessions.
    const room = meta.scope.kind === "seat" || meta.scope.kind === "persona" || meta.scope.kind === "channel";
    const maximum = room ? SEAT_CONVERSATION_RETAINED_EVENTS_MAX : OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX;
    const retainedCount = room
      ? SEAT_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM
      : OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM;
    if (this.retainedEventCount(meta.conversationId) <= maximum) {
      return;
    }
    const events = this.readEvents(meta.conversationId);
    const dropped = events.slice(0, -retainedCount);
    const retained = events.slice(-retainedCount);
    meta.retainedFromCursor = dropped[dropped.length - 1]?.cursor ?? meta.retainedFromCursor ?? ZERO_CURSOR;
    const path = this.eventsPath(meta.conversationId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${retained.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    renameSync(temporary, path);
    this.counts.set(meta.conversationId, retained.length);
    this.saveMeta(meta);
  }

  private matchesRecentSeatSend(meta: ConversationMeta, message: HerdrTranscriptMessage): boolean {
    const previous = this.readEvents(meta.conversationId).findLast(
      (event) => event.type === "message" && event.role === "operator",
    );
    if (previous?.type !== "message" || previous.role !== "operator" || previous.text !== message.text) {
      return false;
    }
    const nativeAt = Date.parse(message.occurredAt ?? "");
    return !Number.isFinite(nativeAt) || Math.abs(Date.parse(previous.occurredAt) - nativeAt) < 60_000;
  }

  /** One-time migration from the old last-answer projection to the native ordered transcript. */
  private replaceSeatEntries(meta: ConversationMeta, transcript: readonly HerdrTranscriptEntry[]): void {
    const events = this.readEvents(meta.conversationId);
    const covered = new Map<string, number>();
    for (const message of transcript) {
      if (message.type !== "message") continue;
      const key = messageKey(message.role, message.text);
      covered.set(key, (covered.get(key) ?? 0) + 1);
    }
    const preserved = events.flatMap((event) => {
      if (event.type !== "message") return [];
      const role = event.role === "agent" ? "agent" : event.role === "operator" ? "operator" : undefined;
      if (role === undefined) return [];
      const key = messageKey(role, event.text);
      const remaining = covered.get(key) ?? 0;
      if (remaining > 0) {
        covered.set(key, remaining - 1);
        return [];
      }
      return [
        {
          body: { type: "message" as const, role, text: event.text, streaming: false as const },
          occurredAt: event.occurredAt,
        },
      ];
    });
    const projected = transcript.map((entry) => ({
      body: transcriptEventBody(entry),
      occurredAt: entry.occurredAt ?? new Date().toISOString(),
    }));
    const previousSequence = this.eventSequence(meta);
    let sequence = previousSequence + 1;
    meta.retainedFromCursor = String(sequence).padStart(CURSOR_WIDTH, "0");
    const rebuilt = [...preserved, ...projected].map(({ body, occurredAt }) => {
      sequence += 1;
      return {
        schemaVersion: 1 as const,
        conversationId: meta.conversationId,
        cursor: String(sequence).padStart(CURSOR_WIDTH, "0"),
        revision: meta.revision,
        occurredAt,
        ...body,
      } as OperatorConversationStreamEvent;
    });
    const path = this.eventsPath(meta.conversationId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${rebuilt.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    renameSync(temporary, path);
    this.counts.set(meta.conversationId, rebuilt.length);
    this.sequences.set(meta.conversationId, sequence);
    this.wakeTails(meta.conversationId);
  }

  private readEvents(conversationId: string): OperatorConversationStreamEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.eventsPath(conversationId), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as OperatorConversationStreamEvent];
        } catch {
          return [];
        }
      });
  }

  private eventsPath(conversationId: string): string {
    return join(this.root, conversationId, "events.jsonl");
  }

  private saveMeta(meta: ConversationMeta): void {
    writeFileSync(join(this.root, meta.conversationId, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  }

  /**
   * Conversation is the sole session/log lifetime. Recent inactive rooms are
   * retained for explicit `--chat` resume; old rooms leave as one directory,
   * including their public event log and their one Pi session tree.
   */
  private prune(protectedConversationId?: string): void {
    const sideParents = new Set(
      [...this.metas.values()].flatMap((meta) =>
        meta.parentConversationId === undefined ? [] : [meta.parentConversationId],
      ),
    );
    const removable = (): ConversationMeta[] =>
      [...this.metas.values()]
        .filter(
          (meta) =>
            !meta.isDefault &&
            meta.sessionState !== "active" &&
            !this.seatSends.has(meta.conversationId) &&
            !sideParents.has(meta.conversationId) &&
            meta.conversationId !== protectedConversationId,
        )
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const cutoff = Date.now() - OPERATOR_CONVERSATION_RETENTION_MS;
    for (const meta of removable().filter((candidate) => Date.parse(candidate.updatedAt) < cutoff)) {
      this.remove(meta);
    }
    while (this.metas.size > OPERATOR_CONVERSATION_RETAINED_MAX) {
      const oldest = removable()[0];
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    while (this.retainedBytes() > OPERATOR_CONVERSATION_RETAINED_BYTES_MAX) {
      const oldest = removable()[0];
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  /**
   * Retire a projection's webhook in Discord, when it is one Clankie made. A
   * pasted webhook is the operator's and stays. Fire-and-forget: the local
   * change this rides on (unproject, re-project, delete) never waits on
   * Discord, and a webhook that cannot be reached now is deleted the next time
   * the operator prunes Server Settings, not a reason to keep the projection.
   */
  private discardProjection(discord: ConversationMeta["channelDiscord"]): void {
    if (discord?.provisioned !== true) return;
    void this.projection
      ?.remove?.({ webhookId: discord.webhookId, webhookToken: discord.webhookToken })
      .catch(() => {});
  }

  private remove(meta: ConversationMeta): void {
    this.discardProjection(meta.channelDiscord);
    rmSync(join(this.root, meta.conversationId), { recursive: true, force: true });
    this.metas.delete(meta.conversationId);
    this.chains.delete(meta.conversationId);
    this.runCounts.delete(meta.conversationId);
    this.internalRuns.delete(meta.conversationId);
    this.counts.delete(meta.conversationId);
    this.sequences.delete(meta.conversationId);
    this.onPrune?.(meta.conversationId, meta.scope);
  }

  private async removeConversation(conversationId: string): Promise<boolean> {
    const meta = this.metas.get(conversationId);
    if (
      meta === undefined ||
      meta.isDefault ||
      this.seatSends.has(conversationId) ||
      [...this.metas.values()].some((candidate) => candidate.parentConversationId === conversationId)
    ) {
      return false;
    }
    if (meta.sessionState === "active" && meta.parentConversationId === undefined) return false;
    if (meta.parentConversationId !== undefined) {
      const activeRuns = [...this.runControllers.entries()].filter(
        ([, entry]) => entry.conversationId === conversationId,
      );
      for (const [runId, entry] of activeRuns) {
        this.cancelRequests.add(runId);
        entry.controller.abort();
      }
      await Promise.allSettled(
        activeRuns.flatMap(([runId]) => {
          const run = this.runs.get(runId);
          return run === undefined ? [] : [run];
        }),
      );
    }
    this.remove(meta);
    return true;
  }

  private retainedBytes(): number {
    return [...this.metas.keys()].reduce(
      (total, conversationId) => total + directoryBytes(join(this.root, conversationId)),
      0,
    );
  }
}

/**
 * The failure in words, cause chain included — an API rejection routinely puts
 * the only useful detail on `cause`, not on the outer error's own message.
 */
function turnFailureSummary(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const text = current instanceof Error ? current.message.trim() : String(current).trim();
    if (text.length > 0 && parts[parts.length - 1] !== text) parts.push(text);
    current = current instanceof Error ? current.cause : undefined;
  }
  const summary = parts.join(": ");
  if (summary.length === 0) return "Turn failed with no error message.";
  return summary.length > OPERATOR_CONVERSATION_SUMMARY_MAX
    ? `${summary.slice(0, OPERATOR_CONVERSATION_SUMMARY_MAX - 1)}\u2026`
    : summary;
}

function directoryBytes(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (total, entry) => total + (entry.isSymbolicLink() ? 0 : directoryBytes(join(path, entry.name))),
    0,
  );
}

function sameScope(a: OperatorConversationScope, b: OperatorConversationScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "workspace" && b.kind === "workspace") return a.workspaceId === b.workspaceId;
  if (a.kind === "persona" && b.kind === "persona") return a.personaId === b.personaId;
  if (a.kind === "seat" && b.kind === "seat") return a.seatId === b.seatId;
  if (a.kind === "channel" && b.kind === "channel") return a.channelId === b.channelId;
  return true;
}

function publicChannel(meta: ConversationMeta): OperatorChannel {
  if (meta.scope.kind !== "channel") {
    throw new Error(`Conversation ${meta.conversationId} is not a channel`);
  }
  return {
    schemaVersion: 1,
    channelId: meta.scope.channelId,
    conversationId: meta.conversationId,
    title: meta.title,
    members: (meta.channelMembers ?? []).map((member) => ({
      personaId: channelMemberPersonaId(member),
      position: member.position,
      joinedAt: member.joinedAt,
    })),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.channelDiscord === undefined
      ? {}
      : {
          discord: {
            guildId: meta.channelDiscord.guildId,
            channelId: meta.channelDiscord.channelId,
            ...(meta.channelDiscord.threadId === undefined ? {} : { threadId: meta.channelDiscord.threadId }),
            webhookId: meta.channelDiscord.webhookId,
          },
        }),
  };
}

/** Reads pre-ADR-0147 channel records without keeping seat identity in the public model. */
function channelMemberPersonaId(member: OperatorChannelMember): string {
  return member.personaId ?? (member as OperatorChannelMember & { readonly seatId: string }).seatId;
}

function publicConversation(meta: ConversationMeta): OperatorConversation {
  return {
    schemaVersion: 1,
    conversationId: meta.conversationId,
    scope: meta.scope,
    title: meta.title,
    isDefault: meta.isDefault,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    sessionState: meta.sessionState,
    revision: meta.revision,
    ...(meta.contextUsage === undefined ? {} : { contextUsage: meta.contextUsage }),
    ...(meta.parentConversationId === undefined ? {} : { parentConversationId: meta.parentConversationId }),
  };
}
