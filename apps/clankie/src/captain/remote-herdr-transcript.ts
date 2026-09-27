import {
  readAgentSession,
  sessionIdFromPath,
  type AgentSessionFile,
  type AgentTranscriptHost,
  type HerdrSeatTranscript,
} from "@clankie/agent-transcript";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";

/** Read only an explicitly opened seat's native history, through the host's confined byte reader. */
export function remoteHerdrTranscriptReader(host: AgentTranscriptHost) {
  const resolved = new Map<string, AgentSessionFile>();
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
    try {
      const page = await readAgentSession(host, file, { tail: 500 });
      return {
        sessionKey: JSON.stringify([host.id, file.harness, sessionIdFromPath(file)]),
        // Remote image paths must never reach this machine's file publisher.
        entries: page.entries.filter((entry) => entry.type !== "viewed_image"),
      };
    } catch (error) {
      resolved.delete(key);
      throw error;
    }
  };
}
