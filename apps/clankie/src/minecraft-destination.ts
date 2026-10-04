import { lookup, resolveSrv } from "node:dns/promises";
import { isIP } from "node:net";
import type { MinecraftServerProfile } from "@clankie/protocol";
import { MinecraftHostSchema, MinecraftSettingsSchema, type MinecraftSettings } from "@clankie/settings";

export interface MinecraftResolvedProfile {
  /** A checked literal address. The motor must dial it without another DNS/SRV lookup. */
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly username: string;
  readonly auth: "offline";
}

export interface MinecraftDestinationDns {
  lookup(host: string): Promise<readonly { address: string; family: number }[]>;
  resolveSrv(
    name: string,
  ): Promise<readonly { name: string; port: number; priority: number; weight: number }[]>;
}

const systemDns: MinecraftDestinationDns = {
  lookup: (host) => lookup(host, { all: true, verbatim: true }),
  resolveSrv,
};

class MinecraftDestinationError extends Error {
  public readonly code: "unknown_profile" | "destination_unapproved" | "destination_unavailable";
  public constructor(code: "unknown_profile" | "destination_unapproved" | "destination_unavailable") {
    super(code);
    this.code = code;
  }
}

export function minecraftProfiles(settings: MinecraftSettings): readonly MinecraftServerProfile[] {
  return settings.profiles.map(({ id, name }) => ({ id, name }));
}

function ipv6Bytes(address: string): number[] {
  const mapped = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped) {
    const octets = mapped[2]!.split(".").map(Number);
    address = `${mapped[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [left = "", right = ""] = address.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const groups = address.includes("::")
    ? [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end]
    : start;
  return groups.flatMap((group) => {
    const number = Number.parseInt(group, 16);
    return [number >> 8, number & 255];
  });
}

function addressClass(address: string): "private" | "public" | "invalid" {
  const family = isIP(address);
  if (family === 4) {
    const [first = 0, second = 0] = address.split(".").map(Number);
    if (first === 0 || first >= 224) return "invalid";
    if (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
      return "private";
    return "public";
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255)
      return addressClass(bytes.slice(12).join("."));
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "private";
    if ((bytes[0]! & 254) === 252) return "private"; // RFC 4193 unique local networks.
    if (
      bytes.every((byte) => byte === 0) ||
      bytes[0] === 255 ||
      (bytes[0] === 254 && (bytes[1]! & 192) === 128)
    )
      return "invalid";
    return "public";
  }
  return "invalid";
}

function exactHost(host: string): string {
  if (isIP(host) === 6) return new URL(`http://[${host}]`).hostname;
  return host;
}

/** Resolve and approve the entire candidate set, then return one pinned dial address. */
export async function resolveMinecraftProfile(
  raw: MinecraftSettings,
  profileId: string,
  options: { readonly dns?: MinecraftDestinationDns } = {},
): Promise<MinecraftResolvedProfile> {
  const settings = MinecraftSettingsSchema.parse(raw);
  const profile = settings.profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new MinecraftDestinationError("unknown_profile");
  const dns = options.dns ?? systemDns;
  try {
    let targets = [{ host: profile.host, port: profile.port }];
    if (isIP(profile.host) === 0 && profile.port === 25_565) {
      let records: Awaited<ReturnType<MinecraftDestinationDns["resolveSrv"]>>;
      try {
        records = await dns.resolveSrv(`_minecraft._tcp.${profile.host}`);
      } catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ENODATA" && code !== "ENOTFOUND") throw error;
        records = [];
      }
      if (records.length > 16) throw new MinecraftDestinationError("destination_unavailable");
      if (records.length) {
        targets = [...records]
          .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
          .map((record) => ({
            host: MinecraftHostSchema.parse(record.name),
            port: record.port,
          }));
      }
    }
    const checked: { host: string; port: number }[] = [];
    for (const target of targets) {
      if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)
        throw new MinecraftDestinationError("destination_unavailable");
      const addresses = isIP(target.host)
        ? [{ address: target.host, family: isIP(target.host) }]
        : await dns.lookup(target.host);
      if (addresses.length === 0 || addresses.length > 16)
        throw new MinecraftDestinationError("destination_unavailable");
      for (const { address } of addresses) {
        const scope = addressClass(address);
        const allowed = settings.publicAllowlist.some(
          (entry) =>
            entry.port === target.port &&
            (exactHost(entry.host) === exactHost(target.host) ||
              exactHost(entry.host) === exactHost(address)),
        );
        if (scope === "invalid" || (scope === "public" && !allowed))
          throw new MinecraftDestinationError("destination_unapproved");
        checked.push({ host: address, port: target.port });
      }
    }
    const endpoint = checked[0]!;
    return { ...endpoint, version: profile.version, username: profile.username, auth: profile.auth };
  } catch (error) {
    if (error instanceof MinecraftDestinationError) throw error;
    throw new MinecraftDestinationError("destination_unavailable");
  }
}
