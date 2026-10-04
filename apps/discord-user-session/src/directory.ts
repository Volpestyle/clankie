import { discordChannelKind, discordDirectoryPage } from "@clankie/discord-presence-core";
import type {
  DiscordDirectoryEntry,
  DiscordDirectoryRequest,
  DiscordDirectorySnapshot,
} from "@clankie/protocol";

type Row = Record<string, unknown>;
interface GuildView {
  data: Row;
  channels: Map<string, Row>;
  roles: Map<string, Row>;
  people: Map<string, Row>;
  rolesKnown: boolean;
}
const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
const id = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{5,32}$/u.test(value) ? value : undefined;
const named = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, 512) : undefined;
const bits = (value: unknown): bigint | undefined =>
  typeof value === "string" && /^\d{1,64}$/u.test(value) ? BigInt(value) : undefined;
const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;

/** Only retains directory fields already delivered to this connected account. */
export class DiscordUserDirectory {
  private selfId: string | undefined;
  private guildsKnown = false;
  private readonly guilds = new Map<string, GuildView>();

  public observe(packet: { t: string; d: Row }): void {
    const data = packet.d;
    if (packet.t === "READY") {
      this.guilds.clear();
      this.selfId = id(row(data.user)?.id);
      this.guildsKnown = Array.isArray(data.guilds);
      for (const guild of Array.isArray(data.guilds) ? data.guilds : []) this.upsertGuild(row(guild));
      return;
    }
    if (packet.t === "GUILD_CREATE" || packet.t === "GUILD_UPDATE") {
      this.upsertGuild(data, packet.t === "GUILD_CREATE");
      return;
    }
    if (packet.t === "GUILD_DELETE") {
      const guildId = id(data.id);
      if (guildId && data.unavailable === true) {
        const guild = this.guilds.get(guildId);
        if (guild) guild.data.unavailable = true;
      } else if (guildId) this.guilds.delete(guildId);
      return;
    }
    const guild = this.guilds.get(id(data.guild_id) ?? "");
    if (!guild) return;
    if (packet.t === "CHANNEL_CREATE" || packet.t === "CHANNEL_UPDATE") {
      const channelId = id(data.id);
      if (channelId)
        guild.channels.set(channelId, {
          ...guild.channels.get(channelId),
          id: channelId,
          name: data.name ?? guild.channels.get(channelId)?.name,
          type: data.type ?? guild.channels.get(channelId)?.type,
          permission_overwrites:
            data.permission_overwrites ?? guild.channels.get(channelId)?.permission_overwrites,
        });
    } else if (packet.t === "CHANNEL_DELETE") guild.channels.delete(id(data.id) ?? "");
    else if (packet.t === "GUILD_ROLE_CREATE" || packet.t === "GUILD_ROLE_UPDATE") {
      const role = row(data.role);
      const roleId = id(role?.id);
      if (roleId) guild.roles.set(roleId, { id: roleId, name: role?.name, permissions: role?.permissions });
    } else if (packet.t === "GUILD_ROLE_DELETE") guild.roles.delete(id(data.role_id) ?? "");
    else if (packet.t === "GUILD_MEMBER_ADD" || packet.t === "GUILD_MEMBER_UPDATE")
      this.rememberPerson(guild, data);
    else if (packet.t === "GUILD_MEMBER_REMOVE") guild.people.delete(id(row(data.user)?.id) ?? "");
    else if (packet.t === "MESSAGE_CREATE")
      this.rememberPerson(guild, { ...row(data.member), user: data.author });
  }

  public read(query: DiscordDirectoryRequest, connected: boolean): DiscordDirectorySnapshot {
    const page = (
      state: DiscordDirectorySnapshot["state"],
      entries: DiscordDirectoryEntry[] = [],
      reason?: DiscordDirectorySnapshot["reason"],
    ) => discordDirectoryPage(query, { body: "user_session", state, entries, ...(reason ? { reason } : {}) });
    if (!connected) return page("disconnected", [], "runtime_not_connected");
    if (query.kind === "servers") {
      const entries = [...this.guilds.values()].flatMap((guild) => {
        const name = named(guild.data.name);
        return name && guild.data.unavailable !== true
          ? [{ id: String(guild.data.id), name, kind: "server" as const }]
          : [];
      });
      const partial = !this.guildsKnown || entries.length !== this.guilds.size;
      return page(
        partial ? "partial" : "connected",
        entries,
        partial ? "gateway_cache_incomplete" : undefined,
      );
    }
    const guild = this.guilds.get(query.guildId!);
    if (!guild || guild.data.unavailable === true) return page("unavailable", [], "server_unavailable");
    if (query.kind === "roles") {
      const entries = [...guild.roles.values()].flatMap((role) => {
        const name = named(role.name);
        return name ? [{ id: String(role.id), name, kind: "role" as const, guildId: query.guildId! }] : [];
      });
      const complete = guild.rolesKnown && entries.length === guild.roles.size;
      return page(
        complete ? "connected" : "partial",
        entries,
        complete ? undefined : "gateway_cache_incomplete",
      );
    }
    if (query.kind === "people")
      return page(
        "partial",
        [...guild.people.values()].flatMap((member) => {
          const user = row(member.user);
          const userId = id(user?.id);
          const name = named(member.nick) ?? named(user?.global_name) ?? named(user?.username);
          return userId && name
            ? [
                {
                  id: userId,
                  name,
                  kind: user?.bot === true ? ("bot" as const) : ("person" as const),
                  guildId: query.guildId!,
                },
              ]
            : [];
        }),
        "people_not_fully_loaded",
      );
    let unknown = false;
    const entries = [...guild.channels.values()].flatMap((channel) => {
      const visible = this.canView(guild, channel);
      if (visible === undefined) unknown = true;
      const name = named(channel.name);
      return visible === true && name
        ? [
            {
              id: String(channel.id),
              name,
              kind: discordChannelKind(Number(channel.type)),
              guildId: query.guildId!,
            },
          ]
        : [];
    });
    // This cache contains guild channels, not a complete archived-thread list.
    return page("partial", entries, unknown ? "permissions_unknown" : "gateway_cache_incomplete");
  }

  private upsertGuild(data: Row | undefined, fresh = false): void {
    const guildId = id(data?.id);
    if (!data || !guildId) return;
    const guild: GuildView = this.guilds.get(guildId) ?? {
      data: {},
      channels: new Map(),
      roles: new Map(),
      people: new Map(),
      rolesKnown: false,
    };
    // Never retain messages, tokens, presences or other unrelated gateway fields.
    guild.data = {
      ...guild.data,
      id: guildId,
      name: data.name ?? row(data.properties)?.name ?? guild.data.name,
      owner_id: data.owner_id ?? row(data.properties)?.owner_id ?? guild.data.owner_id,
      unavailable: data.unavailable ?? (fresh ? false : (guild.data.unavailable ?? false)),
    };
    if (Array.isArray(data.channels)) {
      guild.channels.clear();
      for (const value of data.channels) {
        const channel = row(value);
        const channelId = id(channel?.id);
        if (channelId)
          guild.channels.set(channelId, {
            id: channelId,
            name: channel?.name,
            type: channel?.type,
            permission_overwrites: channel?.permission_overwrites,
          });
      }
    }
    if (Array.isArray(data.roles)) {
      guild.roles.clear();
      guild.rolesKnown = true;
      for (const value of data.roles) {
        const role = row(value);
        const roleId = id(role?.id);
        if (roleId) guild.roles.set(roleId, { id: roleId, name: role?.name, permissions: role?.permissions });
      }
    }
    if (fresh) guild.people.clear();
    if (Array.isArray(data.members))
      for (const member of data.members) {
        const value = row(member);
        if (value) this.rememberPerson(guild, value);
      }
    this.guilds.set(guildId, guild);
  }

  private rememberPerson(guild: GuildView, member: Row): void {
    const user = row(member.user);
    const userId = id(user?.id);
    if (!userId) return;
    const existing = guild.people.get(userId);
    if (!existing && guild.people.size >= 2000 && userId !== this.selfId) return;
    guild.people.set(userId, {
      user: {
        ...row(existing?.user),
        id: userId,
        ...(user?.username === undefined ? {} : { username: user.username }),
        ...(user?.global_name === undefined ? {} : { global_name: user.global_name }),
        ...(user?.bot === undefined ? {} : { bot: user.bot }),
      },
      nick: member.nick ?? existing?.nick,
      roles: member.roles ?? existing?.roles,
    });
  }

  /** Discord's overwrite order; missing permission evidence fails closed. */
  private canView(guild: GuildView, channel: Row): boolean | undefined {
    // Thread membership is a separate visibility boundary; this guild cache
    // deliberately omits threads rather than inferring it from parent access.
    if ([10, 11, 12].includes(Number(channel.type))) return undefined;
    if (!this.selfId) return undefined;
    if (guild.data.owner_id === this.selfId) return true;
    const member = guild.people.get(this.selfId);
    if (!Array.isArray(member?.roles)) return undefined;
    const roleIds = [String(guild.data.id), ...member.roles];
    let permissions = 0n;
    for (const roleId of roleIds) {
      const permission = bits(guild.roles.get(String(roleId))?.permissions);
      if (permission === undefined) return undefined;
      permissions |= permission;
    }
    if ((permissions & ADMINISTRATOR) !== 0n) return true;
    if (!Array.isArray(channel.permission_overwrites)) return undefined;
    const overwrites = channel.permission_overwrites.map(row);
    if (
      overwrites.some(
        (overwrite) =>
          !id(overwrite?.id) ||
          (overwrite?.type !== 0 && overwrite?.type !== 1) ||
          bits(overwrite?.allow) === undefined ||
          bits(overwrite?.deny) === undefined,
      )
    )
      return undefined;
    const apply = (entries: Array<Row | undefined>): boolean => {
      let allow = 0n;
      let deny = 0n;
      for (const overwrite of entries) {
        const a = bits(overwrite?.allow);
        const d = bits(overwrite?.deny);
        if (a === undefined || d === undefined) return false;
        allow |= a;
        deny |= d;
      }
      permissions = (permissions & ~deny) | allow;
      return true;
    };
    if (!apply(overwrites.filter((overwrite) => overwrite?.type === 0 && overwrite.id === guild.data.id)))
      return undefined;
    if (
      !apply(
        overwrites.filter(
          (overwrite) =>
            overwrite?.type === 0 && overwrite.id !== guild.data.id && roleIds.includes(overwrite.id),
        ),
      )
    )
      return undefined;
    if (!apply(overwrites.filter((overwrite) => overwrite?.type === 1 && overwrite.id === this.selfId)))
      return undefined;
    return (permissions & VIEW_CHANNEL) !== 0n;
  }
}
