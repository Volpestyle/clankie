/**
 * Watching a lane the operator is not talking in (ADR 0083).
 *
 * Every room Clankie answers in — each Discord server and channel, voice,
 * gameplay — is a lane the clankie service reports on its authenticated
 * `/captain/v1/lanes` listing. The console reads that listing to learn which
 * rooms exist and, when a room is watched, polls its bounded heard/said log for
 * new entries. It is a subscriber and nothing else: no send, no steering.
 *
 * This is conversation history, not private pi reasoning or tool state.
 */
import {
  CAPTAIN_LANE_OBSERVATION_PATH,
  CaptainLaneListingSchema,
  type CaptainLaneObservationEntry,
  type ObservableCaptainLane,
} from "@clankie/protocol";
import type { ClankieFaceShell } from "../shell/shell.ts";
import type { CaptainRouteFetcher } from "./operator-conversations.ts";

/** Poll cadence while a followed lane is active. */
const LANE_IDLE_POLL_MS = 2_000;
/** Ceiling the quiet-room backoff climbs to, so a settled room stays cheap to watch. */
const LANE_MAX_POLL_MS = 15_000;

export interface CaptainLaneClient {
  lanes(): Promise<readonly ObservableCaptainLane[]>;
}

export class CaptainLaneClientError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CaptainLaneClientError";
  }
}

/** Reads the captain's lane listing over the authenticated route. */
export function createCaptainLaneClient(fetcher: CaptainRouteFetcher): CaptainLaneClient {
  return {
    lanes: async () => {
      const response = await fetcher.fetch(CAPTAIN_LANE_OBSERVATION_PATH);
      if (!response.ok) {
        throw new CaptainLaneClientError(`Clankie's lane listing failed with status ${response.status}`);
      }
      try {
        return CaptainLaneListingSchema.parse(await response.json()).lanes;
      } catch (error) {
        throw new CaptainLaneClientError("Clankie's lane listing failed schema validation", error);
      }
    },
  };
}

export interface LaneAddress {
  readonly lane: string;
  readonly targetId: string;
}

/** Stable console-side key for one room. */
export function laneKey(address: LaneAddress): string {
  return `${address.lane}:${address.targetId}`;
}

/**
 * Resolves what `/trace <argument>` means against the live listing. Matches a
 * whole lane (`discord_presence`), one room by its key or target
 * (`123:456`), `all` for every lane that is not the operator's own, or a
 * substring of the key so a guild id alone is enough.
 */
export function selectLanes(
  lanes: readonly ObservableCaptainLane[],
  argument: string,
): readonly ObservableCaptainLane[] {
  const query = argument.trim().toLowerCase();
  if (query.length === 0 || query === "all") return lanes.filter((lane) => lane.lane !== "operator");
  const exact = lanes.filter(
    (lane) => laneKey(lane).toLowerCase() === query || lane.targetId.toLowerCase() === query,
  );
  if (exact.length > 0) return exact;
  const byLane = lanes.filter((lane) => lane.lane.toLowerCase() === query);
  if (byLane.length > 0) return byLane;
  return lanes.filter((lane) => laneKey(lane).toLowerCase().includes(query));
}

function latestEntryAt(lane: ObservableCaptainLane): string {
  return lane.entries.at(-1)?.at ?? "";
}

/** One `/trace` listing line: room, recent history, and whether it is being watched. */
export function formatLaneListing(
  lanes: readonly ObservableCaptainLane[],
  watched: ReadonlySet<string>,
): string {
  if (lanes.length === 0) {
    return "No captain lanes have run a turn yet. Rooms appear here once Clankie answers in them.";
  }
  return [...lanes]
    .sort((left, right) => latestEntryAt(right).localeCompare(latestEntryAt(left)))
    .map((lane) => {
      const key = laneKey(lane);
      const mark = watched.has(key) ? "▶" : " ";
      const latest = latestEntryAt(lane);
      const activity = latest.length === 0 ? "quiet" : `${String(lane.entries.length)} recent · ${latest}`;
      return `${mark} ${key} · ${activity}`;
    })
    .join("\n");
}

export interface LaneTailOptions {
  readonly address: LaneAddress;
  readonly lanes: CaptainLaneClient;
  /** Renders one observed change in the followed room. */
  readonly render: (line: string) => void;
  /** Surfaces a non-fatal problem (listing unreachable) without stopping the tail. */
  readonly onNotice?: (message: string) => void;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
}

function sameEntry(left: CaptainLaneObservationEntry, right: CaptainLaneObservationEntry): boolean {
  return left.at === right.at && left.kind === right.kind && left.text === right.text;
}

/** Finds the appended suffix when the service's bounded log window advances. */
function appendedEntries(
  previous: readonly CaptainLaneObservationEntry[] | undefined,
  current: readonly CaptainLaneObservationEntry[],
): readonly CaptainLaneObservationEntry[] {
  if (previous === undefined) return current;
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap -= 1) {
    const previousStart = previous.length - overlap;
    if (
      current.slice(0, overlap).every((entry, index) => sameEntry(previous[previousStart + index]!, entry))
    ) {
      return current.slice(overlap);
    }
  }
  return current;
}

/**
 * Follows one lane until the signal aborts, polling the listing and reporting
 * newly appended heard/said entries. A quiet room backs off to
 * {@link LANE_MAX_POLL_MS}; the first observed change brings the cadence back.
 */
export async function followLane(options: LaneTailOptions): Promise<void> {
  const poll = options.pollIntervalMs ?? LANE_IDLE_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const key = laneKey(options.address);
  let previous: readonly CaptainLaneObservationEntry[] | undefined;
  let quietRounds = 0;
  const waitQuietly = async (): Promise<void> => {
    const delay = Math.min(poll * 2 ** quietRounds, LANE_MAX_POLL_MS);
    quietRounds += 1;
    await sleep(delay);
  };
  // A captain that is down fails every round; the transcript hears it once.
  let lastNotice: string | undefined;
  const notice = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === lastNotice) return;
    lastNotice = message;
    options.onNotice?.(message);
  };

  while (!options.signal.aborted) {
    let current: ObservableCaptainLane | undefined;
    try {
      current = (await options.lanes.lanes()).find((lane) => laneKey(lane) === key);
    } catch (error) {
      notice(error);
      await waitQuietly();
      continue;
    }
    if (options.signal.aborted) return;
    lastNotice = undefined;
    const appended = current === undefined ? [] : appendedEntries(previous, current.entries);
    if (current !== undefined) previous = current.entries;
    if (appended.length > 0) {
      for (const entry of appended) options.render(`${entry.kind} · ${entry.at}\n\n${entry.text}`);
      quietRounds = 0;
      await sleep(poll);
    } else {
      await waitQuietly();
    }
  }
}

/**
 * Owns the console's live lane tails. Several rooms can be watched at once;
 * each renders its changes as room-tagged transcript lines.
 */
export class CaptainLaneTraceController {
  private readonly lanesClient: CaptainLaneClient;
  private readonly watchers = new Map<string, AbortController>();

  public constructor(options: { readonly lanes: CaptainLaneClient }) {
    this.lanesClient = options.lanes;
  }

  public get watched(): ReadonlySet<string> {
    return new Set(this.watchers.keys());
  }

  public lanes(): Promise<readonly ObservableCaptainLane[]> {
    return this.lanesClient.lanes();
  }

  /** Starts a tail. Returns false when that room is already being watched. */
  public attach(address: LaneAddress, shell: ClankieFaceShell): boolean {
    const key = laneKey(address);
    if (this.watchers.has(key)) return false;
    const controller = new AbortController();
    this.watchers.set(key, controller);
    void followLane({
      address,
      lanes: this.lanesClient,
      signal: controller.signal,
      render: (line) => {
        shell.insertMarkdown(`\`${key}\` **trace**\n\n${line}`);
        shell.requestRender();
      },
      onNotice: (message) => {
        shell.insertMarkdown(`\`${key}\` **trace**\n\n${message}`);
        shell.requestRender();
      },
    }).catch((error: unknown) => {
      this.watchers.delete(key);
      shell.insertMarkdown(
        `\`${key}\` **trace stopped**\n\n${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return true;
  }

  public detach(key: string): boolean {
    const controller = this.watchers.get(key);
    if (controller === undefined) return false;
    controller.abort();
    this.watchers.delete(key);
    return true;
  }

  public detachAll(): number {
    const keys = [...this.watchers.keys()];
    for (const key of keys) this.detach(key);
    return keys.length;
  }
}
