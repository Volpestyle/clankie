import { describe, expect, it } from "vitest";
import {
  authorizeAmbientCommand,
  authorizeVoicePresenceCommand,
  parseDiscordVoiceJoinPolicy,
  parseRoleIds,
} from "../src/authority.ts";

const bindings = {
  ambientRoleIds: new Set(["ambient-role"]),
  ambientUserIds: new Set(["owner-user"]),
};

const principal = (userId: string, ...roleIds: string[]) => ({
  userId,
  roleIds: new Set(roleIds),
});

describe("Discord role authority", () => {
  it("denies ambient commands unless a configured role is present", () => {
    expect(authorizeAmbientCommand(principal("someone", "other-role"), bindings)).toMatchObject({
      allowed: false,
      code: "role_not_authorized",
    });
    expect(authorizeAmbientCommand(principal("someone", "ambient-role"), bindings)).toEqual({
      allowed: true,
    });
  });

  it("grants the ambient tier to a named operator holding no mapped role", () => {
    // A single-operator deployment has nobody to hand a role to. Naming the
    // user directly is what lets voice open to a server while ambient commands
    // stay with one person.
    expect(authorizeAmbientCommand(principal("owner-user"), bindings)).toEqual({ allowed: true });
  });

  it("parses comma-separated role bindings without empty ids", () => {
    expect([...parseRoleIds(" one, two ,,one ")]).toEqual(["one", "two"]);
  });
});

describe("voice presence authority", () => {
  const stranger = principal("stranger", "unmapped-role");

  it("keeps voice on the ambient binding under the default policy", () => {
    expect(authorizeVoicePresenceCommand(stranger, bindings, "ambient")).toMatchObject({
      allowed: false,
      code: "role_not_authorized",
    });
  });

  it("admits any guild member once voice is deliberately opened", () => {
    expect(authorizeVoicePresenceCommand(stranger, bindings, "guild_members")).toEqual({
      allowed: true,
    });
  });

  it("never widens the ambient tier when voice is opened", () => {
    // The whole point of the split: opening a call to a room must not hand
    // that room the ambient command tier.
    expect(authorizeVoicePresenceCommand(stranger, bindings, "guild_members")).toEqual({
      allowed: true,
    });
    expect(authorizeAmbientCommand(stranger, bindings)).toMatchObject({ allowed: false });
  });

  it("falls back to the closed policy for absent or unrecognized values", () => {
    expect(parseDiscordVoiceJoinPolicy(undefined)).toBe("ambient");
    expect(parseDiscordVoiceJoinPolicy("")).toBe("ambient");
    expect(parseDiscordVoiceJoinPolicy("everyone")).toBe("ambient");
    expect(parseDiscordVoiceJoinPolicy("GUILD_MEMBERS")).toBe("ambient");
    expect(parseDiscordVoiceJoinPolicy(" guild_members ")).toBe("guild_members");
  });
});
