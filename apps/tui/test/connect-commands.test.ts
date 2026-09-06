import { describe, expect, it } from "vitest";
import {
  EMAIL_PRESETS,
  formatConnectStatus,
  normalizeConnectArgument,
  probeLinearKey,
  probeLinearMcp,
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

describe("linear MCP probe", () => {
  it("accepts a token the MCP server answers and carries its refusal otherwise", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const ok: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") ?? undefined });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    };
    await expect(probeLinearMcp("mcp-token", ok)).resolves.toEqual({ ok: true });
    expect(seen).toEqual([{ url: "https://mcp.linear.app/mcp", auth: "Bearer mcp-token" }]);

    const refused: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: "invalid_token", error_description: "Missing or invalid access token" }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    await expect(probeLinearMcp("stale", refused)).resolves.toEqual({
      ok: false,
      detail: "Missing or invalid access token",
    });
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
    expect(DISCORD_BOT_INVITE_PERMISSIONS).toBe(2_721_172_560);
  });
});
