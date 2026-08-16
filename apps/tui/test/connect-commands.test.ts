import { describe, expect, it } from "vitest";
import {
  EMAIL_PRESETS,
  formatConnectStatus,
  normalizeConnectArgument,
  probeLinearKey,
} from "../src/connect-commands.ts";
import { DISCORD_BOT_INVITE_PERMISSIONS, discordBotInviteUrl } from "../src/discord-commands.ts";

describe("connect argument routing", () => {
  it("treats leftover mcp/auth phrasing as /connect linear", () => {
    expect(normalizeConnectArgument("linear")).toBe("linear");
    expect(normalizeConnectArgument("auth linear")).toBe("linear");
    expect(normalizeConnectArgument("mcp linear")).toBe("linear");
    expect(normalizeConnectArgument("mcp auth linear")).toBe("linear");
    expect(normalizeConnectArgument("status")).toBe("status");
    expect(normalizeConnectArgument("")).toBe("");
  });
});

describe("connect status", () => {
  it("tells the owner how to finish each connection", () => {
    expect(
      formatConnectStatus({
        discordBot: false,
        linear: false,
        email: false,
      }),
    ).toContain("/connect linear");
    expect(
      formatConnectStatus({
        discordBot: true,
        linear: true,
        email: true,
        emailUsername: "me@example.com",
        emailHost: "imap.gmail.com",
      }),
    ).toBe(
      [
        "discord: bot token stored · /discord for servers and allowlists",
        "linear: connected",
        "email: connected · me@example.com @ imap.gmail.com",
      ].join("\n"),
    );
  });
});

describe("email presets", () => {
  it("points Gmail at Google's IMAP/SMTP hosts", () => {
    expect(EMAIL_PRESETS.gmail).toMatchObject({
      imapHost: "imap.gmail.com",
      smtpHost: "smtp.gmail.com",
      secure: true,
    });
  });
});

describe("linear probe", () => {
  it("maps a viewer payload and surfaces GraphQL errors", async () => {
    const ok = await probeLinearKey("lin_api_test", async () =>
      Response.json({
        data: { viewer: { name: "Ada" }, organization: { name: "Acme" } },
      }),
    );
    expect(ok).toEqual({ ok: true, viewer: "Ada · Acme" });

    const failed = await probeLinearKey("lin_api_test", async () =>
      Response.json({ errors: [{ message: "invalid key" }] }),
    );
    expect(failed).toEqual({ ok: false, detail: "invalid key" });
  });
});

describe("discord invite URL", () => {
  it("is a bot+commands install for the stored application id", () => {
    const url = discordBotInviteUrl("123456789012345678");
    expect(url).toContain("client_id=123456789012345678");
    expect(url).toContain(`permissions=${String(DISCORD_BOT_INVITE_PERMISSIONS)}`);
    expect(url).toContain("scope=bot%20applications.commands");
    // Use Application Commands is 2^31; JS `1 << 31` is negative, so the
    // constant must be written as a number, not a shift.
    expect(DISCORD_BOT_INVITE_PERMISSIONS).toBeGreaterThan(0);
    expect(DISCORD_BOT_INVITE_PERMISSIONS).toBe(2_184_301_632);
  });
});
