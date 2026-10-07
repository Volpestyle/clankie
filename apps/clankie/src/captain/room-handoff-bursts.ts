import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { NormalizedDiscordTurn } from "./discord-turn.ts";
import type { TurnContext } from "./tools.ts";

export interface LiveRoomRun {
  readonly session: AgentSession;
  readonly capture: TurnContext;
}

export interface LiveRoomHandoff {
  readonly actorId: string;
  /** Verified-owner flag and transport: the parts of a grant known on arrival. */
  readonly identity: string;
  readonly deliveryId: string;
  readonly childId: string;
  /** The resolved grant the run executes under, set before its Pi run can start. */
  grant?: string;
  sessionKey?: string;
  /** Resolves when its Pi run starts, or undefined when it never runs in Pi. */
  readonly run: Promise<LiveRoomRun | undefined>;
  readonly settled: Promise<{ readonly completed: boolean; readonly unconsumed: readonly string[] }>;
}

/**
 * A text burst gets one answer (ADR 0118, amended 2026-10-06 for ADR 0229).
 * Each room handoff with a Pi run is offered here while it runs; a follow-up
 * from the same actor under the same grant steers that run instead of starting
 * a sibling. Another actor, or the same actor under a different grant, never
 * finds it, so steering can neither cross speakers nor raise a grant.
 */
export class RoomHandoffBursts {
  private readonly rooms = new Map<string, LiveRoomHandoff[]>();

  public open(
    roomId: string,
    entry: Pick<LiveRoomHandoff, "actorId" | "identity" | "deliveryId" | "childId">,
  ): {
    readonly handoff: LiveRoomHandoff;
    readonly liveRun: NonNullable<NormalizedDiscordTurn["liveRun"]>;
    /** It will not run in Pi (native child, refusal) or it has ended. Idempotent. */
    readonly close: () => void;
  } {
    let started!: (run: LiveRoomRun | undefined) => void;
    let settle!: (outcome: { completed: boolean; unconsumed: readonly string[] }) => void;
    const handoff: LiveRoomHandoff = {
      ...entry,
      run: new Promise((resolve) => {
        started = resolve;
      }),
      settled: new Promise((resolve) => {
        settle = resolve;
      }),
    };
    const list = this.rooms.get(roomId) ?? [];
    list.push(handoff);
    this.rooms.set(roomId, list);
    const remove = (): void => {
      const current = this.rooms.get(roomId);
      if (current === undefined) return;
      const next = current.filter((candidate) => candidate !== handoff);
      if (next.length === 0) this.rooms.delete(roomId);
      else this.rooms.set(roomId, next);
    };
    return {
      handoff,
      liveRun: {
        started: (session, capture) => started({ session, capture }),
        settled: (completed, unconsumed) => {
          remove();
          started(undefined);
          settle({ completed, unconsumed });
        },
      },
      close: () => {
        remove();
        started(undefined);
        settle({ completed: false, unconsumed: [] });
      },
    };
  }

  /** The newest handoff still running for this actor and arrival identity. */
  public latest(roomId: string, actorId: string, identity: string): LiveRoomHandoff | undefined {
    return this.rooms
      .get(roomId)
      ?.findLast((candidate) => candidate.actorId === actorId && candidate.identity === identity);
  }

  /** Its live Pi run, when it reached one under exactly this grant and is still streaming. */
  public async join(handoff: LiveRoomHandoff, grant: string): Promise<LiveRoomRun | undefined> {
    const run = await handoff.run;
    return run !== undefined && handoff.grant === grant && run.session.isStreaming ? run : undefined;
  }
}
