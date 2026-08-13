/**
 * Small file-backed memory, replacing the deleted `@clankie/memory-store` for
 * the two surviving route families:
 *
 * - **Discord person memory** — approved facts about people, one JSON file per
 *   guild/user under `<dataDir>/discord-people/`. Bounded to the protocol's
 *   128-fact ceiling per person; oldest facts are evicted first.
 * - **Captain episodes** — Clankie's own notes about his own activity, one
 *   append-only JSONL file per lane under `<dataDir>/captain-episodes/`.
 *   Recall is the newest N, and non-operator lanes only ever see `shareable`
 *   episodes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CaptainEpisodeSchema,
  DiscordPersonMemoryFactSchema,
  type CaptainEpisode,
  type CaptainSessionLaneV2,
  type DiscordPersonIdentity,
  type DiscordPersonMemoryExport,
  type DiscordPersonMemoryFact,
} from "@clankie/protocol";
import { z } from "zod";

/** Protocol ceiling on facts per person; the store evicts oldest beyond it. */
const MAX_FACTS_PER_PERSON = 128;
/** Newest episodes a recall card renders. */
const EPISODE_RECALL_LIMIT = 8;
/** Facts a recall card renders. */
const FACT_RECALL_LIMIT = 8;

export interface DiscordPersonMemoryReadOptions {
  readonly channelId?: string;
  readonly now?: Date;
}

export interface MemoryStores {
  /** Direct apply — the approval ceremony left with the governance machinery. Upserts by factId. */
  storeDiscordPersonFact(fact: DiscordPersonMemoryFact): DiscordPersonMemoryFact;
  /** Ambient read: guild-scoped plus this channel's facts, never operator_private. */
  listDiscordPerson(
    identity: DiscordPersonIdentity,
    options?: DiscordPersonMemoryReadOptions,
  ): readonly DiscordPersonMemoryFact[];
  recallDiscordPersonCard(
    identity: DiscordPersonIdentity,
    options: DiscordPersonMemoryReadOptions & { query: string },
  ): string;
  /** Operator export: every fact, operator_private included. */
  exportDiscordPerson(identity: DiscordPersonIdentity, now?: Date): DiscordPersonMemoryExport;
  deleteDiscordPerson(identity: DiscordPersonIdentity): readonly string[];
  recordEpisode(input: unknown): CaptainEpisode;
  episodeRecallCard(options: { lane: CaptainSessionLaneV2 }): string;
}

export function defaultMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLANKIE_MEMORY_DIR?.trim() || join(homedir(), ".clankie", "memory");
}

const PersonFileSchema = z.array(DiscordPersonMemoryFactSchema).max(MAX_FACTS_PER_PERSON);

export function createFileMemory(options: { dataDir: string; clock?: () => Date }): MemoryStores {
  const clock = options.clock ?? (() => new Date());
  const peopleDir = join(options.dataDir, "discord-people");
  const episodesDir = join(options.dataDir, "captain-episodes");
  mkdirSync(peopleDir, { recursive: true, mode: 0o700 });
  mkdirSync(episodesDir, { recursive: true, mode: 0o700 });

  // Guild and user ids are numeric snowflakes in practice, but the wire allows
  // any 64-char string; encode so a hostile id cannot climb out of the dir.
  const personPath = (identity: DiscordPersonIdentity): string =>
    join(peopleDir, `${encodeURIComponent(identity.guildId)}__${encodeURIComponent(identity.userId)}.json`);

  const readPerson = (identity: DiscordPersonIdentity): DiscordPersonMemoryFact[] => {
    try {
      return [...PersonFileSchema.parse(JSON.parse(readFileSync(personPath(identity), "utf8")))];
    } catch {
      return [];
    }
  };
  const writePerson = (identity: DiscordPersonIdentity, facts: readonly DiscordPersonMemoryFact[]): void => {
    writeFileSync(personPath(identity), JSON.stringify(facts, null, 2), { mode: 0o600 });
  };

  const visibleToChannel = (
    fact: DiscordPersonMemoryFact,
    channelId: string | undefined,
    now: Date,
  ): boolean => {
    if (fact.expiresAt !== undefined && Date.parse(fact.expiresAt) <= now.getTime()) return false;
    if (fact.visibility.scope === "guild") return true;
    if (fact.visibility.scope === "channel") return fact.visibility.channelId === channelId;
    return false; // operator_private never reaches an ambient read
  };

  const lanePath = (lane: CaptainSessionLaneV2): string => join(episodesDir, `${lane}.jsonl`);

  const readLane = (lane: CaptainSessionLaneV2): CaptainEpisode[] => {
    let raw: string;
    try {
      raw = readFileSync(lanePath(lane), "utf8");
    } catch {
      return [];
    }
    const episodes: CaptainEpisode[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        episodes.push(CaptainEpisodeSchema.parse(JSON.parse(line)));
      } catch {
        continue; // a torn tail line must not poison the ring
      }
    }
    return episodes;
  };

  return {
    storeDiscordPersonFact(input) {
      const fact = DiscordPersonMemoryFactSchema.parse(input);
      const facts = readPerson(fact.subject).filter((existing) => existing.factId !== fact.factId);
      facts.push(fact);
      // Oldest-first eviction keeps the protocol's per-person ceiling.
      writePerson(fact.subject, facts.slice(-MAX_FACTS_PER_PERSON));
      return fact;
    },

    listDiscordPerson(identity, options = {}) {
      const now = options.now ?? clock();
      return readPerson(identity).filter((fact) => visibleToChannel(fact, options.channelId, now));
    },

    recallDiscordPersonCard(identity, options) {
      const now = options.now ?? clock();
      const query = options.query.toLowerCase();
      const matched = readPerson(identity)
        .filter((fact) => visibleToChannel(fact, options.channelId, now))
        .filter((fact) => fact.body.toLowerCase().includes(query) || fact.kind.includes(query));
      if (matched.length === 0) return "";
      const lines = [`## What you know about user ${identity.userId}`];
      for (const fact of matched.slice(-FACT_RECALL_LIMIT)) {
        lines.push(`- ${fact.kind} (${fact.confidence.toFixed(2)}): ${fact.body}`);
      }
      return lines.join("\n");
    },

    exportDiscordPerson(identity, now = clock()) {
      return {
        schemaVersion: 1,
        subject: identity,
        exportedAt: now.toISOString(),
        facts: readPerson(identity),
      };
    },

    deleteDiscordPerson(identity) {
      const facts = readPerson(identity);
      if (existsSync(personPath(identity))) rmSync(personPath(identity));
      return facts.map((fact) => fact.factId);
    },

    recordEpisode(input) {
      const episode = CaptainEpisodeSchema.parse(input);
      appendFileSync(lanePath(episode.lane), `${JSON.stringify(episode)}\n`, { mode: 0o600 });
      return episode;
    },

    episodeRecallCard({ lane }) {
      const visible = readLane(lane).filter(
        (episode) => lane === "operator" || episode.visibility === "shareable",
      );
      if (visible.length === 0) return "";
      const lines = ["# What you remember doing recently"];
      for (const episode of visible.slice(-EPISODE_RECALL_LIMIT)) {
        lines.push(`- [${episode.occurredAt}] ${episode.summary}`);
      }
      return lines.join("\n");
    },
  };
}
