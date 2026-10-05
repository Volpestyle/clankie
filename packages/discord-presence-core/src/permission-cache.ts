import type { DiscordPermissionsRequest, DiscordPermissionsSnapshot } from "@clankie/protocol";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
const id = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{5,32}$/u.test(value) ? value : undefined;
const bits = (value: unknown): bigint | undefined =>
  typeof value === "string" && /^\d{1,64}$/u.test(value) ? BigInt(value) : undefined;
const FLAGS = {
  administrator: 1n << 3n,
  add_reactions: 1n << 6n,
  embed_links: 1n << 14n,
  attach_files: 1n << 15n,
  use_vad: 1n << 25n,
  use_application_commands: 1n << 31n,
  create_public_threads: 1n << 35n,
  view_channel: 1n << 10n,
  read_message_history: 1n << 16n,
  send_messages_in_threads: 1n << 38n,
  connect: 1n << 20n,
  speak: 1n << 21n,
  send_messages: 1n << 11n,
  manage_channels: 1n << 4n,
  manage_webhooks: 1n << 29n,
};
const ADMIN = 1n << 3n;
const CONNECT = 1n << 20n;
interface Guild {
  data: Row;
  roles: Map<string, unknown>;
  rolesKnown: boolean;
  channels: Map<string, Row>;
  member?: Row;
}
/** Permission evidence from this account's own gateway; no REST fetch, intent expansion or write. */
export class DiscordPermissionCache {
  private self: Row | undefined;
  private readonly guilds = new Map<string, Guild>();
  observe(packet: { t: string; d: Row }): void {
    const data = packet.d;
    if (packet.t === "READY") {
      const user = row(data.user);
      this.self = user ? { id: user.id, bot: user.bot, mfa_enabled: user.mfa_enabled } : undefined;
      this.guilds.clear();
      for (const value of Array.isArray(data.guilds) ? data.guilds : []) this.guild(row(value), true);
      return;
    }
    if (packet.t === "USER_UPDATE") {
      if (data.id !== this.self?.id) {
        this.self = undefined;
        this.guilds.clear();
      } else {
        for (const key of ["bot", "mfa_enabled"] as const) if (key in data) this.self![key] = data[key];
      }
      return;
    }
    if (packet.t === "GUILD_CREATE" || packet.t === "GUILD_UPDATE") {
      this.guild(data, packet.t === "GUILD_CREATE");
      return;
    }
    if (packet.t === "GUILD_DELETE") {
      const guild = this.guilds.get(String(data.id));
      if (guild && data.unavailable === true) guild.data.unavailable = true;
      else this.guilds.delete(String(data.id));
      return;
    }
    const guild = this.guilds.get(String(data.guild_id));
    if (!guild) return;
    if (packet.t === "CHANNEL_CREATE" || packet.t === "CHANNEL_UPDATE") {
      const channelId = id(data.id);
      if (channelId)
        guild.channels.set(channelId, { ...guild.channels.get(channelId), ...this.channel(data) });
    } else if (packet.t === "CHANNEL_DELETE") guild.channels.delete(String(data.id));
    else if (packet.t === "GUILD_ROLE_CREATE" || packet.t === "GUILD_ROLE_UPDATE") {
      const role = row(data.role);
      if (id(role?.id)) guild.roles.set(String(role!.id), role!.permissions);
    } else if (packet.t === "GUILD_ROLE_DELETE") guild.roles.delete(String(data.role_id));
    else if (packet.t === "GUILD_MEMBER_REMOVE" && row(data.user)?.id === this.self?.id) delete guild.member;
    else if (packet.t === "GUILD_MEMBER_ADD" || packet.t === "GUILD_MEMBER_UPDATE") this.member(guild, data);
    else if (packet.t === "GUILD_MEMBERS_CHUNK") {
      for (const value of Array.isArray(data.members) ? data.members : []) this.member(guild, row(value));
    }
  }
  read(
    query: DiscordPermissionsRequest,
    body: DiscordPermissionsSnapshot["body"],
    connected: boolean,
  ): DiscordPermissionsSnapshot {
    const result: DiscordPermissionsSnapshot = {
      body,
      ...(id(this.self?.id) ? { actorId: String(this.self!.id) } : {}),
      ...query,
      permissions: {
        administrator: "not_checked",
        add_reactions: "not_checked",
        embed_links: "not_checked",
        attach_files: "not_checked",
        use_vad: "not_checked",
        use_application_commands: "not_checked",
        create_public_threads: "not_checked",
        read_message_history: "not_checked",
        send_messages_in_threads: "not_checked",
        connect: "not_checked",
        speak: "not_checked",
        view_channel: "not_checked",
        send_messages: "not_checked",
        manage_channels: "not_checked",
        manage_webhooks: "not_checked",
      },
    };
    const self = this.self;
    if (!connected || !self || !id(self.id)) return result;
    const guild = query.guildId
      ? this.guilds.get(query.guildId)
      : [...this.guilds.values()].find((value) => value.channels.has(query.channelId!));
    if (!guild || guild.data.unavailable === true || !id(guild.data.owner_id)) return result;
    result.guildId = String(guild.data.id);
    const channel = query.channelId ? guild.channels.get(query.channelId) : undefined;
    if (query.channelId && !channel) return result;
    // Threads require parent and membership/archive evidence this cache does not retain.
    if (channel && ![0, 2, 4, 5, 13, 15, 16].includes(Number(channel.type))) return result;
    let permissions = 0n;
    const owner = guild.data.owner_id === self.id;
    const roles = guild.member?.roles;
    const roleIds = Array.isArray(roles) ? roles : [];
    if (!owner) {
      if (!guild.rolesKnown || !Array.isArray(roles) || roles.some((value) => !id(value))) return result;
      for (const roleId of [String(guild.data.id), ...roles]) {
        const value = bits(guild.roles.get(String(roleId)));
        if (value === undefined) return result;
        permissions |= value;
      }
    }
    const administrator = owner || (permissions & ADMIN) !== 0n;
    if (administrator) permissions = Object.values(FLAGS).reduce((a, b) => a | b, 0n);
    else if (channel) {
      if (!Array.isArray(channel.permission_overwrites)) return result;
      const overwrites = channel.permission_overwrites.map(row);
      if (
        overwrites.some(
          (value) =>
            !id(value?.id) ||
            ![0, 1].includes(Number(value?.type)) ||
            (value?.type !== 0 && value?.type !== 1) ||
            bits(value?.allow) === undefined ||
            bits(value?.deny) === undefined,
        )
      )
        return result;
      const apply = (values: Array<Row | undefined>) => {
        const allow = values.reduce((all, value) => all | bits(value!.allow)!, 0n);
        const deny = values.reduce((all, value) => all | bits(value!.deny)!, 0n);
        permissions = (permissions & ~deny) | allow;
      };
      apply(overwrites.filter((value) => value!.type === 0 && value!.id === guild.data.id));
      apply(
        overwrites.filter(
          (value) => value!.type === 0 && value!.id !== guild.data.id && roleIds.includes(value!.id),
        ),
      );
      apply(overwrites.filter((value) => value!.type === 1 && value!.id === self.id));
    }
    const timeout = guild.member?.communication_disabled_until;
    if (timeout !== undefined && timeout !== null && typeof timeout !== "string") return result;
    if (!administrator && typeof timeout === "string") {
      const until = Date.parse(timeout);
      if (!Number.isFinite(until)) return result;
      if (until > Date.now()) permissions &= FLAGS.view_channel | FLAGS.read_message_history;
    }
    for (const [kind, flag] of Object.entries(FLAGS) as Array<[keyof typeof FLAGS, bigint]>) {
      result.permissions[kind] = (permissions & flag) === flag ? "passed" : "failed";
    }
    if (channel) {
      if (result.permissions.view_channel === "failed") {
        result.permissions.add_reactions = "failed";
        result.permissions.embed_links = "failed";
        result.permissions.attach_files = "failed";
        result.permissions.use_vad = "failed";
        result.permissions.use_application_commands = "failed";
        result.permissions.create_public_threads = "failed";
        result.permissions.send_messages = "failed";
        result.permissions.read_message_history = "failed";
        result.permissions.send_messages_in_threads = "failed";
        result.permissions.connect = "failed";
        result.permissions.speak = "failed";
        result.permissions.manage_channels = "failed";
        result.permissions.manage_webhooks = "failed";
      }
      if (result.permissions.send_messages === "failed") {
        result.permissions.embed_links = "failed";
        result.permissions.attach_files = "failed";
      }
      if (!administrator && [2, 13].includes(Number(channel.type)) && (permissions & CONNECT) === 0n) {
        result.permissions.manage_channels = "failed";
        result.permissions.speak = "failed";
        result.permissions.use_vad = "failed";
      }
      if (![0, 2, 5, 13].includes(Number(channel.type))) result.permissions.send_messages = "not_checked";
    }
    if (
      body === "user_session" &&
      ((guild.data.mfa_level !== 0 && guild.data.mfa_level !== 1) ||
        (guild.data.mfa_level === 1 && self.mfa_enabled !== true))
    ) {
      for (const kind of ["administrator", "manage_channels", "manage_webhooks"] as const)
        if (result.permissions[kind] === "passed")
          result.permissions[kind] =
            guild.data.mfa_level === 1 && self.mfa_enabled === false ? "failed" : "not_checked";
    }
    return result;
  }
  private channel(data: Row): Row {
    return Object.fromEntries(
      ["id", "type", "permission_overwrites"].filter((key) => key in data).map((key) => [key, data[key]]),
    );
  }
  private member(guild: Guild, member: Row | undefined): void {
    if (!member || row(member.user)?.id !== this.self?.id) return;
    guild.member = {
      ...guild.member,
      ...Object.fromEntries(
        ["roles", "communication_disabled_until"]
          .filter((key) => key in member)
          .map((key) => [key, member[key]]),
      ),
    };
  }
  private guild(data: Row | undefined, fresh: boolean): void {
    const guildId = id(data?.id);
    if (!data || !guildId) return;
    const previous = this.guilds.get(guildId);
    const guild: Guild = fresh
      ? { data: {}, roles: new Map(), rolesKnown: false, channels: new Map() }
      : (previous ?? { data: {}, roles: new Map(), rolesKnown: false, channels: new Map() });
    const properties = row(data.properties);
    guild.data = {
      ...guild.data,
      id: guildId,
      owner_id: data.owner_id ?? properties?.owner_id ?? guild.data.owner_id,
      mfa_level: data.mfa_level ?? properties?.mfa_level ?? guild.data.mfa_level,
      unavailable: data.unavailable ?? (fresh ? false : guild.data.unavailable),
    };
    if (Array.isArray(data.roles)) {
      guild.roles.clear();
      guild.rolesKnown = data.roles.every((value) => id(row(value)?.id));
      for (const value of data.roles) {
        const role = row(value);
        if (id(role?.id)) guild.roles.set(String(role!.id), role!.permissions);
      }
    }
    if (Array.isArray(data.channels)) {
      guild.channels.clear();
      for (const value of data.channels) {
        const channel = row(value);
        if (channel && id(channel.id)) guild.channels.set(String(channel.id), this.channel(channel));
      }
    }
    if (Array.isArray(data.members)) for (const value of data.members) this.member(guild, row(value));
    this.guilds.set(guildId, guild);
  }
}
