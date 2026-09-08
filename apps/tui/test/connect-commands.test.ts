import { emptySettings, type ClankieSettings, type SettingsStore } from "@clankie/settings";
import { describe, expect, it } from "vitest";
import {
  buildConnectCommands,
  type ConnectCommandServices as ConnectServices,
} from "../src/connect-commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";
import type { SetupFlow } from "../src/shell/setup-flow.ts";
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

describe("Linear follow setup", () => {
  function harness(options: {
    readonly selections: readonly string[];
    readonly secret?: string | undefined;
    readonly following?: boolean;
    readonly stored?: Record<string, unknown>;
    readonly gatewayHook?: ConnectServices["gatewayHook"];
  }) {
    let settings: ClankieSettings = {
      ...emptySettings(),
      linearWebhook: { following: options.following ?? false },
    };
    const selections = [...options.selections];
    const stored = new Map<string, string>();
    const removed: string[] = [];
    const lines: string[] = [];
    const results: string[] = [];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async () => selections.shift(),
      readSecret: async () => options.secret,
      renderLine: (line: string) => lines.push(line),
    } as unknown as SetupFlow;
    const shell = {
      setupFlow: flow,
      insertCommandResult: (_prompt: string, message: string) => results.push(message),
    } as unknown as ClankieFaceShell;
    const commands = buildConnectCommands({
      settings: {
        path: "/tmp/settings.json",
        load: async () => settings,
        update: async (mutate: (current: ClankieSettings) => ClankieSettings) => {
          settings = mutate(settings);
          return settings;
        },
      } as unknown as SettingsStore,
      listCredentials: async () => (options.stored ?? {}) as never,
      setCredential: async (providerId: string, key: string) => {
        stored.set(providerId, key);
      },
      storeProviderCredential: async () => undefined,
      removeCredential: async (providerId: string) => {
        removed.push(providerId);
        return true;
      },
      runDiscordWizard: (async () => undefined) as never,
      showDiscordInvite: (() => undefined) as never,
      runLinearOauth: async () => ({ type: "api", key: "unused" }) as never,
      gatewayHook:
        options.gatewayHook ?? (async () => ({ url: "https://api.clankie.bot", hostId: "host-abc" })),
    });
    const connect = commands.find((command) => command.name === "connect")!;
    return { connect, shell, stored, removed, lines, results, settings: () => settings };
  }

  it("stores the webhook secret without automatically enabling follow", async () => {
    const h = harness({ selections: ["follow", "setup"], secret: "sec-1234567890" });

    await h.connect.run("linear", h.shell);

    // The two things an owner would otherwise hand-edit: a provider id typed
    // into /auth, and a settings key.
    expect(h.stored.get("linear-webhook")).toBe("sec-1234567890");
    expect(h.settings().linearWebhook.following).toBe(false);
    expect(h.lines.join("\n")).toContain("Select all available activity events");
    expect(h.lines.join("\n")).toContain("https://api.clankie.bot/h/host-abc/v1/hooks/linear");
  });

  it("says what is wrong instead of printing an address Linear cannot reach", async () => {
    const h = harness({ selections: ["follow", "setup"], gatewayHook: async () => undefined });

    await h.connect.run("linear", h.shell);

    expect(h.results.join("\n")).toContain("/gateway");
    expect(h.stored.size).toBe(0);
  });

  it("removes the secret when he asks, and keeps it when he does not", async () => {
    const stored = { "linear-webhook": { type: "api", redacted: "sec…" } };
    const removeRun = harness({ selections: ["follow", "setup", "remove"], stored, following: true });
    await removeRun.connect.run("linear", removeRun.shell);
    expect(removeRun.removed).toEqual(["linear-webhook"]);

    const keepRun = harness({ selections: ["follow", "setup", "keep"], stored });
    await keepRun.connect.run("linear", keepRun.shell);
    expect(keepRun.removed).toEqual([]);
    expect(keepRun.settings().linearWebhook.following).toBe(false);
    expect(removeRun.settings().linearWebhook.following).toBe(false);
  });
  it("toggles follow without rotating a credential or needing a doorway", async () => {
    const stored = { "linear-webhook": { type: "api", redacted: "sec…" } };
    const on = harness({ selections: ["follow", "on"], stored, gatewayHook: async () => undefined });
    await on.connect.run("linear", on.shell);
    expect(on.settings().linearWebhook.following).toBe(true);
    expect(on.stored.size).toBe(0);
    const off = harness({
      selections: ["follow", "off"],
      following: true,
      gatewayHook: async () => undefined,
    });
    await off.connect.run("linear", off.shell);
    expect(off.settings().linearWebhook.following).toBe(false);
  });

  it("requires webhook setup before starting from the wizard", async () => {
    const h = harness({ selections: ["follow", "on"] });
    await h.connect.run("linear", h.shell);
    expect(h.settings().linearWebhook.following).toBe(false);
    expect(h.results.join("\n")).toContain("Configure the Linear webhook first");
  });
});
