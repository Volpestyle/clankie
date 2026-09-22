import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ConversationStore, OPERATOR_CONVERSATION_RETENTION_MS } from "./conversations.ts";
import { readHerdrSeatTranscript } from "./herdr-transcript.ts";

/** The native Pi tree remains the source, just as a Herdr seat's native transcript does. */
export class RoomConversations {
  private readonly store: ConversationStore;

  public constructor(store: ConversationStore) {
    this.store = store;
  }

  public sync(conversationId: string, path: string | undefined): void {
    if (path === undefined) return;
    const transcript = readHerdrSeatTranscript("pi", { source: "discord", kind: "path", value: path });
    if (transcript === undefined) return;
    this.store.syncRoomTranscript(conversationId, {
      ...transcript,
      // A visible source boundary keeps one-shot and trusted sessions distinguishable.
      entries: [
        {
          type: "message",
          role: "operator",
          id: "source",
          text: `Pi session: ${basename(path)}\nSource: ${path}`,
          ...(transcript.entries[0]?.occurredAt === undefined
            ? {}
            : { occurredAt: transcript.entries[0].occurredAt }),
        },
        ...transcript.entries,
      ],
    });
  }

  /** Import retained text, voice, and actor-granted one-shots without moving their live trees. */
  public discover(stateDir: string): void {
    const sources: {
      path: string;
      lane: "discord_presence" | "discord_voice";
      targetId: string;
      at: number;
    }[] = [];
    for (const kind of ["rooms", "voice", "turns"] as const) {
      const directory = join(stateDir, kind);
      if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const folder of readdirSync(directory, { withFileTypes: true })) {
        if (!folder.isDirectory()) continue;
        let key: string;
        try {
          key = decodeURIComponent(folder.name);
        } catch {
          continue;
        }
        const match =
          kind === "turns"
            ? /^(discord_presence|discord_voice)~(dm|[0-9]+):([0-9]+)$/u.exec(key)
            : /:(dm|[0-9]+):([0-9]+)(?::authority:system)?$/u.exec(key);
        if (match === null) continue;
        const lane =
          kind === "turns"
            ? (match[1] as "discord_presence" | "discord_voice")
            : kind === "voice"
              ? "discord_voice"
              : "discord_presence";
        const targetId = kind === "turns" ? `${match[2]}:${match[3]}` : `${match[1]}:${match[2]}`;
        for (const file of readdirSync(join(directory, folder.name), { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
          const path = join(directory, folder.name, file.name);
          const at = statSync(path).mtimeMs;
          if (Date.now() - at <= OPERATOR_CONVERSATION_RETENTION_MS)
            sources.push({ path, lane, targetId, at });
        }
      }
    }
    for (const source of sources.sort((a, b) => a.at - b.at)) {
      this.sync(this.store.roomConversation(source.lane, source.targetId), source.path);
    }
  }
}
