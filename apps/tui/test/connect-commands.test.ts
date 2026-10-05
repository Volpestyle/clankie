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
    const ok = await probeLinearKey("lin_api_test", async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("lin_api_test");
      return Response.json({
        data: {
          viewer: { id: "u1", name: "Ada", email: "ada@example.com" },
          organization: { id: "w1", name: "Acme" },
        },
      });
    });
    expect(ok).toMatchObject({
      ok: true,
      viewer: "Ada (ada@example.com) · Acme",
      account: { userId: "u1", workspaceId: "w1", email: "ada@example.com" },
    });

    const failed = await probeLinearKey("lin_api_test", async () =>
      Response.json({ errors: [{ message: "invalid key" }] }),
    );
    expect(failed).toEqual({ ok: false, detail: "invalid key" });
    expect(
      await probeLinearKey("key", async () =>
        Response.json({ data: { viewer: { name: "Ada" }, organization: { name: "Acme" } } }),
      ),
    ).toMatchObject({ ok: false });
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
    expect(new URL(url).searchParams.get("scope")).toBe("bot applications.commands");
    // Use Application Commands is 2^31; JS `1 << 31` is negative, so the
    // constant must be written as a number, not a shift.
    expect(DISCORD_BOT_INVITE_PERMISSIONS).toBeGreaterThan(0);
    expect(DISCORD_BOT_INVITE_PERMISSIONS).toBe(311_421_946_944);
    expect(BigInt(DISCORD_BOT_INVITE_PERMISSIONS) & 8n).toBe(0n);
  });
});

describe("Linear follow setup", () => {
  function harness(options: {
    readonly texts?: readonly (string | undefined)[];
    readonly selections: readonly string[];
    readonly secret?: string | undefined;
    readonly following?: boolean;
    readonly url?: string | undefined;
    readonly stored?: Record<string, unknown>;
    readonly gatewayHook?: ConnectServices["gatewayHook"];
    readonly connectLinearApp?: ConnectServices["connectLinearApp"];
    readonly storeProviderCredential?: ConnectServices["storeProviderCredential"];
  }) {
    let settings: ClankieSettings = {
      ...emptySettings(),
      linearWebhook: {
        ...emptySettings().linearWebhook,
        following: options.following ?? false,
        url: options.url,
      },
    };
    const selections = [...options.selections];
    const texts = options.texts ? [...options.texts] : undefined;
    const stored = new Map<string, string>();
    const removed: string[] = [];
    const lines: string[] = [];
    const results: string[] = [];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async (input: { message: string }) => {
        lines.push(input.message);
        return selections.shift();
      },
      readSecret: async () => options.secret,
      readText: async () => (texts ? texts.shift() : "application-id"),
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
      getCredential: async (id) =>
        !removed.includes(id) && (stored.has(id) || options.stored?.[id])
          ? { type: "api", key: stored.get(id) ?? "fixture-secret" }
          : undefined,
      setCredential: async (providerId: string, key: string) => {
        stored.set(providerId, key);
      },
      storeProviderCredential: options.storeProviderCredential ?? (async () => undefined),
      ...(options.connectLinearApp ? { connectLinearApp: options.connectLinearApp } : {}),
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

  it("edits every wake rule under Follow Linear without changing following, and cancels atomically", async () => {
    const h = harness({
      selections: ["follow", "wake"],
      texts: [
        "owner,self,users",
        "james",
        "volpestyle@gmail.com",
        "teammate",
        "issueMention",
        "issueSubscribed",
      ],
      stored: { linear: { type: "oauth" } },
    });
    await h.connect.run("linear", h.shell);
    expect(h.settings().linearWebhook.wake).toEqual({
      actors: ["owner", "self", "users"],
      ownerUserIds: ["james"],
      ownerUserEmails: ["volpestyle@gmail.com"],
      userIds: ["teammate"],
      notificationTypes: ["issueMention"],
      excludedNotificationTypes: ["issueSubscribed"],
    });
    expect(h.settings().linearWebhook.following).toBe(false);
    const cancelled = harness({
      selections: ["follow", "wake"],
      texts: ["self", undefined],
      stored: { linear: { type: "oauth" } },
    });
    await cancelled.connect.run("linear", cancelled.shell);
    expect(cancelled.settings().linearWebhook.wake.actors).toEqual(["owner"]);
  });

  it("connects a verified app using concealed secret entry and reports the workspace", async () => {
    const saved: string[] = [];
    const h = harness({
      selections: ["app"],
      secret: "private-client-secret",
      connectLinearApp: async (client) => {
        expect(client).toEqual({ clientId: "application-id", clientSecret: "private-client-secret" });
        return {
          type: "oauth",
          linearAuth: "app",
          access: "private-access",
          refresh: "",
          expires: 1,
          account: {
            provider: "linear",
            actor: "app",
            name: "Clankie",
            workspaceName: "Personal",
            userId: "app",
            workspaceId: "workspace",
            connectionId: "00000000-0000-4000-8000-000000000001",
            verifiedAt: new Date().toISOString(),
          },
        };
      },
      storeProviderCredential: async (id) => {
        saved.push(id);
      },
    });
    await h.connect.run("linear", h.shell);
    expect(saved).toEqual(["linear"]);
    expect(h.results.join("\n")).toContain("Clankie (app) · Personal");
    expect([...h.lines, ...h.results].join("\n")).not.toContain("private-");
  });

  it("stores the webhook secret without automatically enabling follow", async () => {
    const h = harness({ selections: ["follow", "setup"], secret: "sec-1234567890" });

    await h.connect.run("linear", h.shell);

    // The two things an owner would otherwise hand-edit: a provider id typed
    // into /auth, and a settings key.
    expect(h.stored.get("linear-webhook")).toBe("sec-1234567890");
    expect(h.settings().linearWebhook.following).toBe(false);
    expect(h.settings().linearWebhook.url).toBe("https://api.clankie.bot/h/host-abc/v1/hooks/linear");
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
    expect(removeRun.results.join("\n")).toContain("Following is on but blocked: linear_webhook_required");

    const keepRun = harness({ selections: ["follow", "setup", "keep"], stored });
    await keepRun.connect.run("linear", keepRun.shell);
    expect(keepRun.removed).toEqual([]);
    expect(keepRun.settings().linearWebhook.following).toBe(false);
    expect(removeRun.settings().linearWebhook.following).toBe(true);
  });
  it("toggles follow with a registered webhook without rotating its credential", async () => {
    const stored = {
      linear: { type: "oauth", expires: 0 },
      "linear-webhook": { type: "api", redacted: "sec…" },
    };
    const on = harness({
      selections: ["follow", "on"],
      stored,
      url: "https://hooks.example.test/v1/hooks/linear",
    });
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

  it.each([
    { url: undefined, secret: false, missing: "url, secret" },
    { url: "https://hooks.example.test/v1/hooks/linear", secret: false, missing: "secret" },
    { url: undefined, secret: true, missing: "url" },
  ])("refuses to follow with missing $missing", async ({ url, secret, missing }) => {
    const h = harness({
      selections: ["follow", "on"],
      url,
      stored: { linear: { type: "oauth" }, ...(secret ? { "linear-webhook": { type: "api" } } : {}) },
    });
    await h.connect.run("linear", h.shell);
    expect(h.settings().linearWebhook.following).toBe(false);
    expect(h.results.join("\n")).toContain("linear_webhook_required");
    expect(h.results.join("\n")).toContain(`missing: ${missing}`);
  });

  it("shows blocked status when a configured follow loses its webhook", async () => {
    const h = harness({
      selections: ["follow"],
      following: true,
      url: "https://hooks.example.test/v1/hooks/linear",
      stored: { linear: { type: "oauth" } },
    });
    await h.connect.run("linear", h.shell);
    expect(h.lines.join("\n")).toContain("on but blocked");
    expect(h.lines.join("\n")).toContain("linear_webhook_required");
  });

  it("requires a connected Linear account before starting from the wizard", async () => {
    const h = harness({ selections: ["follow", "on"] });
    await h.connect.run("linear", h.shell);
    expect(h.settings().linearWebhook.following).toBe(false);
    expect(h.results.join("\n")).toContain("Connect Clankie’s Linear account first");
  });
});
