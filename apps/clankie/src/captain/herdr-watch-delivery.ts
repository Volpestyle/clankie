import type { StopNativeTaskResult, FleetSeatInputCapabilities } from "@clankie/protocol";
import { type ConversationOwner } from "./conversation-owner.ts";
import { isMessageableSeat } from "./fleet-seat-control.ts";
import { currentOf, withCurrent, type CurrentCheck, type PeerDeliveryOptions } from "./peer-seat-messages.ts";
import type { MachineAccessFence } from "../machine-access.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import { createHash } from "node:crypto";
import { SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { type FleetSeatDelivery } from "./fleet-seat.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { type HerdrSeatTranscript } from "./herdr-transcript.ts";
import {
  type HerdrAgentSnapshot,
  REPLY_STATUSES,
  NATIVE_CHAT_CACHE_FILES_MAX,
  NATIVE_CHAT_CACHE_BYTES_MAX,
} from "./herdr-watch-types.ts";
import { reasonDetail, delay } from "./herdr-watch-helpers.ts";
import type { HerdrWatchContext } from "./herdr-watch-context.ts";

type Context = Pick<
  HerdrWatchContext,
  | "cacheNativeChat"
  | "closed"
  | "deliverToSeat"
  | "nativeOwner"
  | "nativeTaskObservation"
  | "path"
  | "projectSeat"
  | "readNativeChat"
  | "readRoomReply"
  | "readSeatReply"
  | "requireWorkerAccess"
  | "runner"
  | "scopedDelivery"
  | "seatClaim"
  | "seatControl"
  | "seatTranscriptTailMs"
  | "watchHiredSeat"
>;

export function createHerdrWatchDelivery(ctx: Context) {
  /** Body-free native delivery observations, including persisted legacy fences. */
  async function unresolvedSeatDeliveries() {
    const entries = ctx.seatControl.unresolvedDeliveries();
    return Promise.all(
      entries.map(async (entry) => {
        const agent = await ctx.runner.resolveTerminal(entry.seatId).catch(() => undefined);
        let owner: ConversationOwner | undefined;
        try {
          owner = agent ? ctx.nativeOwner(agent) : undefined;
        } catch {
          /* Retain visibility after occupant replacement. */
        }
        return {
          ...entry,
          conversationId: entry.conversationId ?? owner?.conversationId ?? "global-default",
        };
      }),
    );
  }

  async function scopedDelivery(id: string, conversationId: string, ownerSettlement = false) {
    const original = await ctx.seatControl.locateDelivery(id);
    if (!original) return undefined;
    const [key, receipt] = original;
    const agent = await ctx.runner.resolveTerminal(receipt.seatId ?? key).catch(() => undefined);
    let owner: ConversationOwner | undefined;
    try {
      owner = agent ? ctx.nativeOwner(agent) : undefined;
    } catch {
      /* Persisted delivery scope remains authoritative. */
    }
    // A different conversation may have messaged this hire. Only the persisted
    // hiring lead of the receipt's exact native occupant may override that scope.
    if (
      ownerSettlement &&
      owner?.conversationId === conversationId &&
      agent?.session &&
      agent.paneId === receipt.paneId &&
      nativeSessionId(agent) === receipt.sessionId &&
      receipt.occupantId !== undefined &&
      occupantIdForHerdrSession(agent.session) === receipt.occupantId &&
      ctx.seatClaim(agent)?.hired === true
    )
      return original;
    if (
      (receipt.conversationId ??
        owner?.conversationId ??
        (ownerSettlement ? "global-default" : undefined)) !== conversationId
    )
      throw new Error("Original delivery belongs to another conversation");
    return original;
  }

  async function reconcileSeatDelivery(id: string, conversationId: string) {
    if (!(await ctx.scopedDelivery(id, conversationId))) return undefined;
    return ctx.seatControl.reconcileDelivery(id);
  }

  /** The lead's explicit settle (VUH-2358), scoped like owner settlement. */
  async function settleSeatDelivery(id: string, conversationId: string) {
    if (!(await ctx.scopedDelivery(id, conversationId, true))) return undefined;
    return ctx.seatControl.settleDelivery(id);
  }

  async function abandonSeatDelivery(
    id: string,
    conversationId: string,
    beforeSettlement?: () => Promise<void>,
  ) {
    if (!(await ctx.scopedDelivery(id, conversationId, true))) return undefined;
    return ctx.seatControl.abandonDelivery(id, beforeSettlement);
  }

  /**
   * The seat id a `clankie mcp --seat` bridge should poll, given the pane it
   * sits in (`HERDR_PANE_ID`). Herdr accepts a moved pane's old id as an alias.
   * `undefined` until the pane holds a messageable agent.
   */
  async function seatIdForPane(paneId: string): Promise<string | undefined> {
    if (ctx.closed) return undefined;
    try {
      const agent = await ctx.runner.get(paneId);
      return isMessageableSeat(agent) ? agent.terminalId : undefined;
    } catch {
      return undefined;
    }
  }

  /** Read only the answer to an explicitly sent room prompt, never prior pane activity. */
  async function sendAndWatchReply(
    seatId: string,
    text: string,
    deliver: () => Promise<boolean>,
  ): Promise<boolean> {
    const before = await ctx.readRoomReply(seatId);
    const priorIds = new Set(before?.transcript.entries.map((entry) => entry.id));
    const sent = await deliver();
    if (!sent) return false;
    const deadline = Date.now() + 10 * 60_000;
    void (async () => {
      while (!ctx.closed && Date.now() < deadline) {
        await delay(ctx.seatTranscriptTailMs);
        if (ctx.closed) return;
        const snapshot = await ctx.readRoomReply(seatId);
        if (snapshot === undefined) return;
        if (before !== undefined && snapshot.transcript.sessionKey !== before.transcript.sessionKey) return;
        const entries = snapshot.transcript.entries;
        if (snapshot.transcript.sessionKey.startsWith("terminal:")) {
          // ponytail: transcriptless harnesses compare against the pre-send answer;
          // native prompt IDs replace this fallback when their adapter exists.
          const last = entries.at(-1);
          if (
            REPLY_STATUSES.has(snapshot.agent.status) &&
            last?.type === "message" &&
            last.text !==
              (before?.transcript.entries.at(-1)?.type === "message"
                ? (before.transcript.entries.at(-1) as { text: string }).text
                : undefined)
          ) {
            ctx.projectSeat?.(seatId, { kind: "reply", text: last.text });
            return;
          }
          continue;
        }
        const asked = entries.findIndex(
          (entry) =>
            !priorIds.has(entry.id) &&
            entry.type === "message" &&
            entry.role === "operator" &&
            (entry.text.trim() === text.trim() ||
              (entry.text.startsWith("<channel") && entry.text.includes(text))),
        );
        if (asked < 0) continue;
        const subsequent = entries.slice(asked + 1);
        const nextPrompt = subsequent.findIndex(
          (entry) => entry.type === "message" && entry.role === "operator",
        );
        const answer = nextPrompt < 0 ? subsequent : subsequent.slice(0, nextPrompt);
        const last = answer.at(-1);
        if (
          (nextPrompt >= 0 || REPLY_STATUSES.has(snapshot.agent.status)) &&
          last?.type === "message" &&
          last.role === "agent"
        ) {
          ctx.projectSeat?.(seatId, { kind: "reply", text: last.text });
          return;
        }
        if (nextPrompt >= 0) return;
      }
    })().catch(() => undefined);
    return true;
  }

  async function readNativeChat(
    seatId: string,
    previous?: HerdrAgentSnapshot,
  ): Promise<
    | {
        agent: HerdrAgentSnapshot;
        transcript: HerdrSeatTranscript;
      }
    | undefined
  > {
    const live = await ctx.runner.resolveTerminal(seatId).catch(() => undefined);
    const agent = live ?? previous;
    if (agent === undefined || (live === undefined && agent.session === undefined)) return undefined;
    // A cache belongs to this exact native occupant, never its pane's next agent.
    // It is an on-demand display snapshot, separate from owned conversation events.
    const cachePath = `${ctx.path}.native-chat/${createHash("sha256")
      .update(JSON.stringify([seatId, agent.agent, agent.session]))
      .digest("hex")}.json`;
    const cacheSchema = z.object({
      sessionKey: z.string(),
      entries: SeatTranscriptUploadSchema.shape.entries.element.array().max(9_000),
    });
    let transcript: HerdrSeatTranscript | undefined;
    let unavailable = false;
    try {
      transcript = await ctx.runner.transcript?.(agent);
    } catch {
      unavailable = true;
    }
    if (transcript !== undefined) {
      const display = {
        ...transcript,
        entries: transcript.entries.filter(
          (entry) => entry.type !== "viewed_image" && !(entry.type === "message" && entry.internal),
        ),
      };
      // A cache write failure cannot make a successful native read fail.
      try {
        ctx.cacheNativeChat(cachePath, display);
      } catch {
        /* read-through remains live */
      }
    } else {
      try {
        transcript = cacheSchema.parse(JSON.parse(readFileSync(cachePath, "utf8")));
      } catch {
        /* never substitute terminal text */
      }
      unavailable = true;
    }
    const status = live === undefined ? "offline" : unavailable ? "unavailable" : agent.status;
    transcript ??= { sessionKey: `unavailable:${seatId}`, entries: [] };
    return { agent: { ...agent, status }, transcript };
  }

  /** Only an explicit room prompt may use the transcriptless answer fallback. */
  async function readRoomReply(seatId: string) {
    const native = await ctx.readNativeChat(seatId);
    if (native?.agent.status !== "unavailable") return native;
    // allow-swallowed-rejection -- a failed lookup proves no live room recipient; no terminal reply is claimed.
    const live = await ctx.runner.resolveTerminal(seatId).catch(() => undefined);
    if (live === undefined) return undefined;
    const reply = await ctx.readSeatReply(live, "recent-unwrapped");
    return {
      agent: live,
      transcript: {
        sessionKey: `terminal:${seatId}`,
        entries:
          reply === undefined
            ? []
            : [{ type: "message" as const, id: "latest", role: "agent" as const, text: reply }],
      },
    };
  }

  /** Compact display snapshots share one bounded, oldest-write-first cache. */
  function cacheNativeChat(path: string, transcript: HerdrSeatTranscript): void {
    let snapshot = transcript;
    let encoded = JSON.stringify(snapshot);
    while (Buffer.byteLength(encoded) > NATIVE_CHAT_CACHE_BYTES_MAX && snapshot.entries.length > 0) {
      snapshot = { ...snapshot, entries: snapshot.entries.slice(Math.ceil(snapshot.entries.length / 2)) };
      encoded = JSON.stringify(snapshot);
    }
    const unchanged = existsSync(path) && readFileSync(path, "utf8") === encoded;
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files = readdirSync(directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name) && join(directory, name) !== path)
      .map((name) => {
        const file = join(directory, name);
        const stat = statSync(file);
        return { path: file, bytes: stat.size, modifiedAt: stat.mtimeMs };
      })
      .sort((a, b) => a.modifiedAt - b.modifiedAt || a.path.localeCompare(b.path));
    let bytes = files.reduce((total, file) => total + file.bytes, 0) + Buffer.byteLength(encoded);
    while (files.length >= NATIVE_CHAT_CACHE_FILES_MAX || bytes > NATIVE_CHAT_CACHE_BYTES_MAX) {
      const oldest = files.shift();
      if (!oldest) break;
      unlinkSync(oldest.path);
      bytes -= oldest.bytes;
    }
    if (unchanged) return;
    const temporary = `${path}.${String(process.pid)}.tmp`;
    try {
      writeFileSync(temporary, encoded, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  /** Controller observations and actions retain the exact native occupant. */
  async function inputCapabilities(agent: HerdrAgentSnapshot): Promise<FleetSeatInputCapabilities> {
    const capabilities = await ctx.seatControl.inputCapabilities(agent, { displayOnly: true });
    const current = await ctx.runner.resolveTerminal(agent.terminalId).catch(() => undefined);
    return current?.paneId === agent.paneId &&
      current.agent === agent.agent &&
      isDeepStrictEqual(current.session, agent.session)
      ? capabilities
      : { deliveryModes: [], interrupt: false, nextTurnOnly: false };
  }

  /** Controller observations and actions retain the exact native occupant. */
  async function nativeTaskObservation(
    seatId: string,
    holderId?: string,
  ): Promise<{ binding: string; status: string; queueSupported: boolean } | undefined> {
    if (ctx.closed) return undefined;
    const agent = await ctx.runner.resolveTerminal(seatId).catch(() => undefined);
    if (!agent?.session) return undefined;
    // allow-swallowed-rejection -- A failed native read grants no activity or lease renewal.
    const observation = await ctx.seatControl.observeNativeTask(agent, holderId).catch(() => undefined);
    if (!observation) return undefined;
    const { status } = observation;
    const current = await ctx.runner.resolveTerminal(seatId).catch(() => undefined);
    if (
      !current?.session ||
      !isDeepStrictEqual(current.session, agent.session) ||
      current.agent !== agent.agent ||
      current.terminalId !== agent.terminalId ||
      ["offline", "released"].includes(status)
    )
      return undefined;
    return {
      binding: JSON.stringify([agent.paneId, agent.terminalId, agent.agent, agent.session]),
      status,
      queueSupported: observation.queueSupported,
    };
  }

  async function stopNativeTask(
    seatId: string,
    binding: string,
    authorize: () => Promise<void>,
  ): Promise<StopNativeTaskResult> {
    if (ctx.closed) return { outcome: "unavailable" };
    await authorize();
    const agent = await ctx.runner.resolveTerminal(seatId).catch(() => undefined);
    if (
      !agent?.session ||
      JSON.stringify([agent.paneId, agent.terminalId, agent.agent, agent.session]) !== binding
    )
      return { outcome: "unavailable" };
    const control = await ctx.seatControl.attach(agent);
    if (!control?.stopTask)
      return {
        outcome: "unsupported",
        detail: "This native harness has no exact-task stop control; no terminal input was sent.",
      };
    return control.stopTask(async () => {
      await authorize();
      const current = await ctx.nativeTaskObservation(seatId);
      if (current?.binding !== binding) throw new Error("Native occupant changed");
      await authorize();
    });
  }

  async function sendToSeat(
    seatId: string,
    text: string,
    uncontrolled?: () => Promise<boolean>,
  ): Promise<boolean> {
    const delivery = await ctx.deliverToSeat(
      seatId,
      text,
      uncontrolled === undefined
        ? undefined
        : async () =>
            (await uncontrolled())
              ? { outcome: "delivered" }
              : { outcome: "undelivered", detail: "The seat mailbox did not confirm delivery." },
    );
    return delivery.outcome === "delivered";
  }

  async function deliverToSeat(
    seatId: string,
    text: string,
    uncontrolled?: (attempt?: PeerDeliveryOptions) => Promise<FleetSeatDelivery>,
    options?: PeerDeliveryOptions,
  ): Promise<FleetSeatDelivery> {
    if (ctx.requireWorkerAccess) {
      const original = options;
      // The last access generation the guard read, for the write's synchronous final gate.
      let access: MachineAccessFence | undefined;
      const fenced: CurrentCheck = {
        current: () => {
          if (access === undefined) return undefined;
          try {
            access.assertCurrent();
            return true;
          } catch {
            return false;
          }
        },
      };
      const guard = withCurrent(
        async () => {
          access = undefined;
          await original?.guard?.();
          access = (await ctx.requireWorkerAccess!(splitFleetQualified(seatId)?.fleet)) ?? undefined;
        },
        currentOf(original?.guard, fenced),
      );
      try {
        await ctx.requireWorkerAccess(splitFleetQualified(seatId)?.fleet);
      } catch (error) {
        return { outcome: "undelivered", deliveryStage: "rejected", detail: reasonDetail(error) };
      }
      options = { ...original, guard };
    }
    if (ctx.closed && options)
      return { outcome: "offline", deliveryStage: "unavailable", detail: "Native seat delivery is closed." };
    if (ctx.closed)
      return uncontrolled?.() ?? { outcome: "offline", detail: "Native hire service is closed." };
    const before = options?.fence
      ? undefined
      : await ctx.runner.resolveTerminal(seatId).catch(() => undefined);
    // The lead only arms a follow-up's completion harvest below. A stale claim on this pane or
    // terminal (an earlier occupant's) names no lead for the current one, and must not stop the
    // message: the seat control proves the occupant it delivers to on its own.
    let owner: ConversationOwner | undefined;
    try {
      owner = before?.session ? ctx.nativeOwner(before) : undefined;
    } catch {
      owner = undefined;
    }
    const delivered = await (options === undefined
      ? ctx.seatControl.deliverToSeat(seatId, text, uncontrolled)
      : ctx.seatControl.deliverToSeat(seatId, text, uncontrolled, options));
    // Follow-ups need their own completion harvest. Peer output creates no
    // owner wake. Queued native input IDs correlate to their eventual turn.
    if (
      owner &&
      before?.agent === "codex" &&
      before.session &&
      delivered.outcome === "delivered" &&
      delivered.messageId &&
      (delivered.state === "started" || delivered.state === "steered" || delivered.state === "queued")
    ) {
      try {
        // Arming is synchronous after native acceptance. The watcher proves
        // the original occupant and current owner again before harvesting.
        ctx.watchHiredSeat(
          seatId,
          occupantIdForHerdrSession(before.session),
          owner,
          true,
          delivered.messageId,
        );
      } catch {
        // A watcher failure cannot erase confirmed native acceptance or permit
        // redispatch. The retained delivery receipt remains authoritative.
        console.warn("Native follow-up completion watch unavailable:", seatId);
      }
    }
    return delivered;
  }
  return {
    unresolvedSeatDeliveries,
    scopedDelivery,
    reconcileSeatDelivery,
    settleSeatDelivery,
    abandonSeatDelivery,
    seatIdForPane,
    sendAndWatchReply,
    readNativeChat,
    readRoomReply,
    cacheNativeChat,
    inputCapabilities,
    nativeTaskObservation,
    stopNativeTask,
    sendToSeat,
    deliverToSeat,
  };
}
