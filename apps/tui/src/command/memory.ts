/**
 * `clankie memory` — the operator's own hands on Clankie's episodes (VUH-1104).
 *
 * Everything here goes through the operator memory catalog and the per-episode
 * routes, so the CLI sees exactly what the console does, private notes included.
 * Episodes are addressed by id alone; the lane they live in is resolved from the
 * catalog rather than asked for, because an id is what recall and search print.
 */
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { ClankieApiClient } from "@clankie/api-client";
import type { CaptainEpisode, OperatorMemoryCatalog } from "@clankie/protocol";
import { commandHost, type Writable } from "./io.ts";

const MEMORY_USAGE = [
  "Usage: clankie memory [status]",
  "       clankie memory search <terms...>",
  "       clankie memory retain <episodeId> | release <episodeId>",
  "       clankie memory correct <episodeId> --summary TEXT",
  "       clankie memory forget <episodeId>",
].join("\n");

/** Episodes a status or search prints; the whole store is rarely what a reader wants. */
const MEMORY_CLI_LIMIT = 20;

export interface MemoryCliCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

/** One shape per verb, so a caller narrows on the field it wants instead of casting. */
export type MemoryCliResult =
  | {
      readonly ok: true;
      readonly retention: OperatorMemoryCatalog["retention"];
      readonly episodes: readonly CaptainEpisode[];
      readonly people: number;
    }
  | {
      readonly ok: true;
      readonly query: string;
      readonly found: number;
      readonly episodes: readonly CaptainEpisode[];
    }
  | { readonly ok: true; readonly forgotten: string; readonly lane: CaptainEpisode["lane"] }
  | { readonly ok: true; readonly episode: CaptainEpisode }
  | { readonly ok: false; readonly error: string };

type MemoryCliArgs =
  | { readonly verb: "status" }
  | { readonly verb: "search"; readonly query: string }
  | { readonly verb: "retain" | "release" | "forget"; readonly episodeId: string }
  | { readonly verb: "correct"; readonly episodeId: string; readonly summary: string };

export function parseMemoryArgs(args: readonly string[]): MemoryCliArgs {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === "status") {
    if (rest.length > 0) throw new Error(MEMORY_USAGE);
    return { verb: "status" };
  }
  if (verb === "search") {
    const query = rest.join(" ").trim();
    if (query.length === 0) throw new Error(MEMORY_USAGE);
    return { verb: "search", query };
  }
  if (verb === "retain" || verb === "release" || verb === "forget") {
    const [episodeId, ...extra] = rest;
    if (episodeId === undefined || extra.length > 0) throw new Error(MEMORY_USAGE);
    return { verb, episodeId };
  }
  if (verb === "correct") {
    const [episodeId, flag, summary, ...extra] = rest;
    if (episodeId === undefined || flag !== "--summary" || summary === undefined || extra.length > 0) {
      throw new Error(MEMORY_USAGE);
    }
    if (summary.trim().length === 0) throw new Error(MEMORY_USAGE);
    return { verb: "correct", episodeId, summary: summary.trim() };
  }
  throw new Error(MEMORY_USAGE);
}

/** Newest first — the order both the catalog reader and a person expect. */
function newestFirst(episodes: readonly CaptainEpisode[]): CaptainEpisode[] {
  return [...episodes].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

/**
 * The same all-terms-must-appear match the service uses for his own recall,
 * run here over the operator catalog so the console needs no second route and
 * the operator's view stays the one that includes private notes.
 */
export function matchEpisodes(episodes: readonly CaptainEpisode[], query: string): CaptainEpisode[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [];
  return newestFirst(episodes).filter((episode) => {
    const haystack = `${episode.summary} ${episode.lane} ${episode.targetId}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function locate(catalog: OperatorMemoryCatalog, episodeId: string): CaptainEpisode {
  const episode = catalog.captainEpisodes.find((candidate) => candidate.episodeId === episodeId);
  if (episode === undefined) throw new Error(`No episode with id ${episodeId}.`);
  return episode;
}

export async function runMemoryCommand(
  args: readonly string[],
  options: MemoryCliCommandOptions = {},
): Promise<MemoryCliResult> {
  const parsed = parseMemoryArgs(args);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) {
    return { ok: false, error: "Memory needs the local operator credential. Run `clankie doctor`." };
  }
  const client = new ClankieApiClient({
    baseUrl: commandHost({ ...options, env }),
    operatorToken: credential.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  try {
    const catalog = await client.inspectMemory();
    if (parsed.verb === "status") {
      return {
        ok: true,
        retention: catalog.retention,
        episodes: newestFirst(catalog.captainEpisodes).slice(0, MEMORY_CLI_LIMIT),
        people: catalog.discordPeople.length,
      };
    }
    if (parsed.verb === "search") {
      const matched = matchEpisodes(catalog.captainEpisodes, parsed.query);
      return {
        ok: true,
        query: parsed.query,
        found: matched.length,
        episodes: matched.slice(0, MEMORY_CLI_LIMIT),
      };
    }
    const episode = locate(catalog, parsed.episodeId);
    if (parsed.verb === "forget") {
      // One record per memory, so this is the whole memory: there is no second
      // retained copy left behind for recall to find.
      await client.deleteCaptainEpisode(episode.lane, episode.episodeId);
      return { ok: true, forgotten: episode.episodeId, lane: episode.lane };
    }
    const edit =
      parsed.verb === "correct" ? { summary: parsed.summary } : { retained: parsed.verb === "retain" };
    const updated = await client.updateCaptainEpisode(episode.lane, episode.episodeId, edit);
    return { ok: true, episode: updated };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
