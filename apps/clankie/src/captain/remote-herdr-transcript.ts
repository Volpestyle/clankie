import {
  readAgentSession,
  sessionIdFromPath,
  type AgentSessionFile,
  type AgentTranscriptHost,
  type HerdrSeatTranscript,
} from "@clankie/agent-transcript";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";

/** A remote read this recent is served as is, without asking the host. */
const REMOTE_FRESH_MS = 2_000;
const REMOTE_PAGES_MAX = 64;

/**
 * Read only an explicitly opened seat's native history, through the host's
 * confined byte reader. Every read is a round trip over SSH (seconds for a
 * Windows host), so a read is kept with the file size it was taken at: within
 * REMOTE_FRESH_MS it is served as is, and after that a one-byte probe of the
 * size decides whether the tail must be read again. Concurrent reads of one
 * session share a request.
 */
export function remoteHerdrTranscriptReader(host: AgentTranscriptHost, now: () => number = Date.now) {
  const resolved = new Map<string, AgentSessionFile>();
  const pages = new Map<string, { size: number; checkedAt: number; transcript: HerdrSeatTranscript }>();
  const inflight = new Map<string, Promise<HerdrSeatTranscript>>();
  const readFresh = async (file: AgentSessionFile): Promise<HerdrSeatTranscript> => {
    const cached = pages.get(file.path);
    if (cached !== undefined && now() - cached.checkedAt < REMOTE_FRESH_MS) return cached.transcript;
    // Size first: a write landing during the tail read shows as growth next time.
    const { size } = await host.readBytes(file.path, cached?.size ?? 0, 1);
    if (cached !== undefined && cached.size === size) {
      cached.checkedAt = now();
      return cached.transcript;
    }
    // A seat's reader keeps its channel deliveries, as the local one does, for receipts.
    const page = await readAgentSession(host, file, { tail: 500, channelPrompts: true });
    const transcript: HerdrSeatTranscript = {
      sessionKey: JSON.stringify([host.id, file.harness, sessionIdFromPath(file)]),
      // Remote image paths must never reach this machine's file publisher.
      entries: page.entries.filter((entry) => entry.type !== "viewed_image"),
    };
    pages.delete(file.path);
    if (pages.size >= REMOTE_PAGES_MAX) pages.delete(pages.keys().next().value!);
    pages.set(file.path, { size, checkedAt: now(), transcript });
    return transcript;
  };
  return async (agent: HerdrAgentSnapshot): Promise<HerdrSeatTranscript | undefined> => {
    const session = agent.session;
    if (!session || !["claude", "codex", "grok", "pi"].includes(agent.agent)) return undefined;
    const key = JSON.stringify([agent.agent, session.kind, session.value]);
    let file = resolved.get(key);
    if (!file) {
      const matches = (await host.list({ limit: 1000 })).filter(
        (candidate) =>
          candidate.harness === agent.agent &&
          (session.kind === "path"
            ? candidate.path === session.value
            : sessionIdFromPath(candidate) === session.value),
      );
      if (matches.length !== 1) return undefined;
      file = matches[0]!;
      if (resolved.size >= 128) resolved.delete(resolved.keys().next().value!);
      resolved.set(key, file);
    }
    const running = inflight.get(file.path);
    if (running !== undefined) return running;
    const reading = readFresh(file);
    inflight.set(file.path, reading);
    try {
      return await reading;
    } catch (error) {
      resolved.delete(key);
      pages.delete(file.path);
      throw error;
    } finally {
      inflight.delete(file.path);
    }
  };
}
