import { Client, ClientUser, Guild, GatewayIntentBits } from "discord.js";

export function botCache(additionalGuild = false) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.user = Reflect.construct(ClientUser, [
    client,
    {
      id: "30001",
      username: "Clankie",
      discriminator: "0",
      avatar: null,
      bot: true,
    },
  ]) as ClientUser;
  let connected = true;
  client.isReady = (() => connected) as Client["isReady"];
  const raw = {
    id: "10001",
    name: "Studio",
    owner_id: "30002",
    unavailable: false,
    member_count: 10,
    roles: [
      { id: "10001", name: "@everyone", permissions: "1024", position: 0, color: 0 },
      { id: "10002", name: "Builders", permissions: "0", position: 1, color: 0 },
    ],
    members: [
      {
        user: { id: "30001", username: "Clankie", discriminator: "0", avatar: null, bot: true },
        roles: [],
        joined_at: "2026-10-04T12:00:00Z",
      },
      {
        user: { id: "30002", username: "James", discriminator: "0", avatar: null },
        roles: ["10002"],
        joined_at: "2026-10-04T12:00:00Z",
      },
    ],
    channels: [
      { id: "20001", guild_id: "10001", name: "general", type: 0, position: 0, permission_overwrites: [] },
      { id: "20002", guild_id: "10001", name: "dev", type: 0, position: 1, permission_overwrites: [] },
      {
        id: "20003",
        guild_id: "10001",
        name: "secret-room",
        type: 0,
        position: 2,
        permission_overwrites: [{ id: "10001", type: 0, allow: "0", deny: "1024" }],
      },
      { id: "20004", guild_id: "10001", name: "Talk", type: 2, position: 3, permission_overwrites: [] },
    ],
  };
  if (additionalGuild) {
    raw.members.push({
      user: { id: "30005", username: "Ivo", discriminator: "0", avatar: null },
      roles: [],
      joined_at: "2026-10-04T12:00:00Z",
    });
    const garden = structuredClone(raw);
    garden.id = "10002";
    garden.name = "Garden";
    garden.roles = garden.roles.map((role, index) => ({ ...role, id: index === 0 ? "10002" : "10003" }));
    garden.channels = garden.channels.map((channel, index) => ({
      ...channel,
      id: String(20011 + index),
      guild_id: "10002",
      permission_overwrites: channel.permission_overwrites.map((overwrite) => ({
        ...overwrite,
        id: "10002",
      })),
    }));
    const extra = Reflect.construct(Guild, [client, garden]) as Guild;
    client.guilds.cache.set(extra.id, extra);
  }
  const guild = Reflect.construct(Guild, [client, raw]) as Guild;
  client.guilds.cache.set(guild.id, guild);
  return {
    client,
    guild,
    disconnect: () => {
      connected = false;
    },
  };
}
