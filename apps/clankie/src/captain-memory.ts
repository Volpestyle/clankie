import { randomUUID } from "node:crypto";
import type { CaptainDeps } from "./captain/deps.ts";
import type { MemoryStores } from "./memory.ts";

/** The service and MCP use the same file-backed memory and room-derived visibility. */
export function createCaptainMemory(memory: MemoryStores): CaptainDeps["memory"] {
  return {
    writeMemory(input) {
      const note = memory.recordEpisode({
        schemaVersion: 1,
        episodeId: `memory-${randomUUID()}`,
        sourceConversationId: input.sourceConversationId,
        lane: input.lane,
        targetId: input.targetId,
        summary: input.text,
        visibility: input.lane === "operator" ? "operator_private" : "shareable",
        provenance: {
          characterId: "clankie",
          sessionId: "captain",
          selfAuthored: true,
          rawTranscript: false,
        },
        occurredAt: new Date().toISOString(),
      });
      return Promise.resolve({ id: note.episodeId, text: note.summary });
    },
    recallMemoryCard: (lane, query) =>
      Promise.resolve(memory.episodeRecallCard({ lane, ...(query === undefined ? {} : { query }) })),
    searchMemory: (lane, query) => Promise.resolve(memory.searchEpisodeCard({ lane, query })),
    editMemory(input) {
      const note = memory.editMemory(input);
      return Promise.resolve(note === undefined ? undefined : { id: note.episodeId, text: note.summary });
    },
    forgetMemory: (input) => Promise.resolve(memory.forgetMemory(input)),
    recallDiscordPerson(identity, options) {
      const card = memory.recallDiscordPersonCard(identity, {
        channelId: options.channelId,
        query: options.query,
      });
      return card.length === 0 ? undefined : card;
    },
  };
}
