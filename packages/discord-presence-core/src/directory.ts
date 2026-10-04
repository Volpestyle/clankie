import {
  DiscordDirectorySnapshotSchema,
  type DiscordDirectoryRequest,
  type DiscordDirectorySnapshot,
  type DiscordDirectoryEntry,
} from "@clankie/protocol";

/** Page observed account data without implying that a partial cache is exhaustive. */
export function discordDirectoryPage(
  query: DiscordDirectoryRequest,
  source: Pick<DiscordDirectorySnapshot, "body" | "state" | "reason"> & {
    entries: readonly DiscordDirectoryEntry[];
  },
): DiscordDirectorySnapshot {
  const entries = [...source.entries]
    .filter((entry) => query.after === undefined || BigInt(entry.id) > BigInt(query.after))
    .sort((left, right) =>
      BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0,
    );
  const page = entries.slice(0, query.limit);
  const hasMore = entries.length > page.length;
  return DiscordDirectorySnapshotSchema.parse({
    schemaVersion: 1,
    body: source.body,
    kind: query.kind,
    state: source.state,
    ...(source.reason === undefined ? {} : { reason: source.reason }),
    entries: page,
    hasMore,
    ...(hasMore && page.length ? { nextCursor: page.at(-1)!.id } : {}),
  });
}

export const discordChannelKind = (type: number): DiscordDirectoryEntry["kind"] => {
  switch (type) {
    case 0:
      return "text";
    case 2:
      return "voice";
    case 4:
      return "category";
    case 5:
      return "announcement";
    case 10:
    case 11:
    case 12:
      return "thread";
    case 13:
      return "stage";
    case 15:
      return "forum";
    case 16:
      return "media";
    default:
      return "other";
  }
};
