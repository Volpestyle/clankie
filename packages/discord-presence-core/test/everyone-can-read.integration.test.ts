// Whether everyone in a server can read a channel's history, asked of a Discord REST stand-in over real HTTP (#340).
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { discordEveryoneCanRead, type DiscordServerRequest } from "../src/index.ts";

const GUILD = "100";
const VIEW = 1024;
const HISTORY = 65536;
type Overwrite = { id: string; type: 0 | 1; allow: string; deny: string };
type Channel = {
  id: string;
  guild_id: string;
  type?: number;
  parent_id?: string;
  permission_overwrites?: Overwrite[];
  thread_metadata?: Record<string, unknown>;
  [field: string]: unknown;
};

let state: { channels: Record<string, Channel>; everyone: string; afterRead?: (path: string) => void };
const reads: string[] = [];
const server = createServer((incoming, response) => {
  const path = incoming.url ?? "";
  reads.push(path);
  const body =
    path === `/guilds/${GUILD}/roles`
      ? [
          { id: GUILD, permissions: state.everyone },
          { id: "200", permissions: "0" },
        ]
      : state.channels[path.replace("/channels/", "")];
  response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
  response.end(JSON.stringify(body ?? { message: "Unknown Channel" }));
  state.afterRead?.(path);
});
let base = "";
const request: DiscordServerRequest = async (action) => {
  const response = await fetch(`${base}${action.path}`, { method: action.method });
  if (!response.ok) throw new Error(`Discord ${String(response.status)}`);
  return response.json();
};
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  base = `http://127.0.0.1:${String(address.port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const deny = (id: string, type: 0 | 1, bits: number): Overwrite => ({
  id,
  type,
  allow: "0",
  deny: String(bits),
});
const text = (overwrites: Overwrite[] = [], extra: Partial<Channel> = {}): Channel => ({
  id: "300",
  guild_id: GUILD,
  type: 0,
  permission_overwrites: overwrites,
  ...extra,
});
const proves = async (
  channels: Channel[],
  everyone = String(VIEW | HISTORY),
  afterRead?: (path: string) => void,
) => {
  state = {
    channels: Object.fromEntries(channels.map((channel) => [channel.id, channel])),
    everyone,
    ...(afterRead ? { afterRead } : {}),
  };
  return discordEveryoneCanRead(GUILD, channels[0]!.id, request);
};

it("proves a plain public text channel, and voice text chat, readable by everyone", async () => {
  expect(await proves([text()])).toBe(true);
  expect(await proves([text([], { type: 2 })])).toBe(true);
  // An allow that changes nothing about who is denied is fine.
  expect(await proves([text([{ id: "200", type: 0, allow: String(VIEW), deny: "0" }])])).toBe(true);
});

it("refuses a channel any overwrite hides from some members, of any kind", async () => {
  expect(await proves([text([deny(GUILD, 0, VIEW)])])).toBe(false);
  expect(await proves([text([deny("200", 0, VIEW)])])).toBe(false); // a role
  expect(await proves([text([deny("400", 1, VIEW)])])).toBe(false); // a member
  expect(await proves([text([deny("200", 0, HISTORY)])])).toBe(false); // history hidden
});

// GET /channels/{thread.id} as Discord returns it: a thread carries thread metadata and
// no permission_overwrites of its own, because it inherits its parent's.
const thread = (type: number, extra: Partial<Channel> = {}): Channel => ({
  id: "600",
  guild_id: GUILD,
  parent_id: "500",
  owner_id: "400",
  name: "Friday plans",
  type,
  last_message_id: "601",
  message_count: 3,
  member_count: 2,
  rate_limit_per_user: 0,
  flags: 0,
  total_message_sent: 3,
  applied_tags: [],
  thread_metadata: {
    archived: false,
    auto_archive_duration: 4320,
    archive_timestamp: "2026-11-01T18:00:00.000000+00:00",
    locked: false,
    create_timestamp: "2026-11-01T18:00:00.000000+00:00",
  },
  ...extra,
});

it("judges a public thread, which carries no overwrites of its own, by its parent", async () => {
  const open = text([], { id: "500", type: 15 });
  expect(await proves([thread(11), open])).toBe(true); // forum or text thread
  expect(await proves([thread(10), text([], { id: "500", type: 5 })])).toBe(true); // announcement thread
  const hidden = text([deny("200", 0, VIEW)], { id: "500", type: 15 });
  expect(await proves([thread(11), hidden])).toBe(false);
  expect(await proves([thread(12), open])).toBe(false); // private thread
  // Unproven thread shapes still fail closed: missing metadata, or an overwrite that denies.
  const unmarked = thread(11);
  delete unmarked.thread_metadata;
  expect(await proves([unmarked, open])).toBe(false);
  expect(await proves([thread(11, { permission_overwrites: [deny("200", 0, VIEW)] }), open])).toBe(false);
});

it("refuses a channel that is not a thread and omits its overwrites", async () => {
  const bare = text();
  delete bare.permission_overwrites;
  expect(await proves([bare])).toBe(false);
});

it("refuses when everyone cannot view and read history at the server level", async () => {
  expect(await proves([text()], String(VIEW))).toBe(false);
  expect(await proves([text()], "0")).toBe(false);
  expect(await proves([text()], "8")).toBe(true); // administrator
});

it("refuses an unknown or missing channel type and an unreadable channel", async () => {
  expect(await proves([text([], { type: 99 })])).toBe(false);
  const untyped = text();
  delete untyped.type;
  expect(await proves([untyped])).toBe(false);
  state = { channels: {}, everyone: String(VIEW | HISTORY) };
  expect(await discordEveryoneCanRead(GUILD, "300", request)).toBe(false);
});

it("refuses states from different moments: a change between reads fails the closing re-read", async () => {
  // The channel turns private right after its first read: the roles read next and the
  // channel as first read never held together, and the closing re-read sees the change.
  const channel = text();
  reads.length = 0;
  const result = await proves([channel], String(VIEW | HISTORY), (path) => {
    if (path === "/channels/300" && reads.filter((read) => read === path).length === 1)
      state.channels["300"] = text([deny(GUILD, 0, VIEW)]);
  });
  expect(result).toBe(false);
  expect(reads.filter((read) => read === "/channels/300")).toHaveLength(2);
});
