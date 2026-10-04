import {
  DISCORD_BODY_DIRECTORY_PATH,
  DiscordDirectorySnapshotSchema,
  parseProtocolResponse,
  type DiscordDirectoryRequest,
  type DiscordDirectorySnapshot,
} from "@clankie/protocol";

/** Reads the active body's existing loopback control server; never starts one. */
export async function readDiscordBodyDirectory(
  query: DiscordDirectoryRequest,
  options: {
    body: DiscordDirectorySnapshot["body"];
    env: NodeJS.ProcessEnv;
    token: string;
    fetchImpl?: typeof fetch;
  },
): Promise<DiscordDirectorySnapshot> {
  const unavailable = (
    state: "disconnected" | "unavailable",
    reason: "runtime_not_connected" | "directory_unavailable",
  ): DiscordDirectorySnapshot => ({
    schemaVersion: 1,
    body: options.body,
    kind: query.kind,
    state,
    entries: [],
    hasMore: false,
    reason,
  });
  const rawPort =
    options.body === "user_session"
      ? (options.env.CLANKIE_USER_SESSION_CONTROL_PORT ?? "4312")
      : (options.env.CLANKIE_DISCORD_BRIDGE_CONTROL_PORT ?? "4313");
  if (!/^\d{1,5}$/u.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
    return unavailable("unavailable", "directory_unavailable");
  const url = new URL(DISCORD_BODY_DIRECTORY_PATH, `http://127.0.0.1:${rawPort}`);
  url.searchParams.set("kind", query.kind);
  url.searchParams.set("limit", String(query.limit));
  if (query.guildId) url.searchParams.set("guildId", query.guildId);
  if (query.after) url.searchParams.set("after", query.after);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return code === "ECONNREFUSED"
      ? unavailable("disconnected", "runtime_not_connected")
      : unavailable("unavailable", "directory_unavailable");
  }
  if (!response.ok) return unavailable("unavailable", "directory_unavailable");
  try {
    const snapshot = parseProtocolResponse(DiscordDirectorySnapshotSchema, await response.json());
    if (snapshot.body !== options.body || snapshot.kind !== query.kind)
      return unavailable("unavailable", "directory_unavailable");
    return snapshot;
  } catch {
    return unavailable("unavailable", "directory_unavailable");
  }
}
