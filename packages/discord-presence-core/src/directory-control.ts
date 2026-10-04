import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DISCORD_BODY_DIRECTORY_PATH,
  DiscordDirectoryRequestSchema,
  type DiscordDirectoryRequest,
  type DiscordDirectorySnapshot,
} from "@clankie/protocol";

/** Service-to-body read, authenticated with that body's existing brokered bridge bearer. */
export function tryHandleDiscordDirectoryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    token: string;
    read(query: DiscordDirectoryRequest): DiscordDirectorySnapshot;
  },
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" || url.pathname !== DISCORD_BODY_DIRECTORY_PATH) return false;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  const expected = Buffer.from(`Bearer ${options.token}`);
  const provided = Buffer.from(request.headers.authorization ?? "");
  if (!options.token || expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    response.writeHead(403);
    response.end(JSON.stringify({ error: "discord_directory_authentication_required" }));
    return true;
  }
  const parsed = DiscordDirectoryRequestSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    response.writeHead(400);
    response.end(JSON.stringify({ error: "invalid_discord_directory_request" }));
    return true;
  }
  try {
    const snapshot = options.read(parsed.data);
    response.writeHead(200);
    response.end(JSON.stringify(snapshot));
  } catch {
    response.writeHead(503);
    response.end(JSON.stringify({ error: "discord_directory_unavailable" }));
  }
  return true;
}
