/**
 * `/connect` is the owner-facing catalog for giving Clankie access to the
 * owner's own services (ADR 0093). Secrets go to the credential broker;
 * public identifiers go to settings.json — the same split `/discord` uses.
 */
import { LinearWakeSettingsSchema, SettingsStore, type EmailSettings } from "@clankie/settings";
import {
  connectLinearApp,
  LINEAR_MCP_RESOURCE,
  LINEAR_WEBHOOK_PROVIDER_ID,
  verifyLinearApiAccount,
  type ProviderAccount,
  type ProviderCredential,
  type RedactedCredential,
} from "@clankie/credential-broker";
import { LINEAR_WEBHOOK_PATH } from "@clankie/protocol/public-gateway";
import { runLinearCommand } from "./command/linear.ts";
import { describeRedactedCredential, runDiscordWizard, showDiscordInvite } from "./discord-commands.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";
import { providerAccountsSection, type ConnectionsMenuServices } from "./connections-menu.ts";

const LINEAR_PROVIDER_ID = "linear";
const EMAIL_PROVIDER_ID = "email";
const LINEAR_KEY_URL = "https://linear.app/settings/account/security";
const LINEAR_WEBHOOK_SETTINGS_URL = "https://linear.app/settings/api";

export type EmailPresetId = "gmail" | "icloud" | "fastmail" | "outlook" | "custom";

export const EMAIL_PRESETS: Readonly<Record<Exclude<EmailPresetId, "custom">, Partial<EmailSettings>>> = {
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    secure: true,
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    secure: true,
  },
  fastmail: {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 587,
    secure: true,
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    secure: true,
  },
};

export interface ConnectCommandServices {
  settings: SettingsStore;
  listCredentials: () => Promise<Record<string, RedactedCredential>>;
  getCredential: (providerId: string) => Promise<ProviderCredential | undefined>;
  setCredential: (providerId: string, key: string) => Promise<void>;
  storeProviderCredential: (providerId: string, credential: ProviderCredential) => Promise<void>;
  removeCredential: (providerId: string) => Promise<unknown>;
  runDiscordWizard: typeof runDiscordWizard;
  showDiscordInvite: typeof showDiscordInvite;
  runLinearOauth: () => Promise<ProviderCredential>;
  probeLinear?: typeof probeLinearKey;
  probeLinearMcp?: typeof probeLinearMcp;
  connectLinearApp?: typeof connectLinearApp;
  /** Body-owned account catalog and consent lifecycle; secrets stay on the body. */
  accounts?: ConnectionsMenuServices["accounts"];
  /**
   * The doorway this Mac answers on, for the webhook URL an owner pastes into
   * Linear (ADR 0165). Absent means remote access is not configured yet, which
   * the comment-wake flow reports rather than printing an address that 404s.
   */
  gatewayHook?: () => Promise<{ readonly url: string; readonly hostId: string } | undefined>;
}

export function buildConnectCommands(services: ConnectCommandServices): FaceShellCommand[] {
  return [
    {
      name: "connect",
      aliases: ["integrations"],
      description: "Connect accounts and configure local services for Clankie",
      argumentHint: "[accounts|status|linear|email|discord]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const selector = normalizeConnectArgument(argument);
        if (selector === "accounts") {
          if (!services.accounts) throw new Error("Account connections unavailable");
          await withFlow(shell, "connect accounts", () =>
            providerAccountsSection(shell.setupFlow, services.accounts!),
          );
          return;
        }
        if (selector === "status") {
          await showConnectStatus(shell, services);
          return;
        }
        if (selector === "linear") {
          await withFlow(shell, "connect linear", () => runLinearWizard(shell, services));
          return;
        }
        if (selector === "email") {
          await withFlow(shell, "connect email", () => runEmailWizard(shell, services));
          return;
        }
        if (selector === "discord") {
          await services.runDiscordWizard(shell, services);
          return;
        }
        await runConnectWizard(shell, services);
      },
    },
  ];
}

/** `/auth mcp linear` and `/mcp auth linear` both mean /connect linear. */
export function normalizeConnectArgument(argument: string): string {
  const words = argument
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words[0] === "auth" || words[0] === "install") return words[1] ?? "";
  if (words[0] === "mcp") return normalizeConnectArgument(words.slice(1).join(" "));
  return words[0] ?? "";
}

/**
 * Whether an OAuth credential works, asked of the service it was minted for.
 *
 * The browser flow requests its token with `resource:
 * https://mcp.linear.app/mcp` — RFC 8707 audience restriction — so Linear
 * issues one that is valid at the MCP server and nowhere else. Checking it
 * against `api.linear.app/graphql` therefore fails on a perfectly good
 * sign-in, with GraphQL's "Authentication required, not authenticated", and
 * the credential is discarded before it is ever stored. An API key is a
 * GraphQL credential and still probes there; this one asks MCP.
 *
 * MCP has no viewer to name, so a successful sign-in reports no account.
 */
export async function probeLinearMcp(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await fetchImpl(LINEAR_MCP_RESOURCE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        // Streamable HTTP may answer either way; both are a working token.
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "clankie", version: "0.2.0" },
        },
      }),
    });
    if (response.ok) return { ok: true };
    const body = await response.text().catch(() => "");
    const described = ((): string | undefined => {
      try {
        const parsed = JSON.parse(body) as { error_description?: string; error?: string };
        return parsed.error_description ?? parsed.error;
      } catch {
        return undefined;
      }
    })();
    return { ok: false, detail: described ?? `Linear MCP HTTP ${String(response.status)}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function probeLinearKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; viewer: string; account: ProviderAccount } | { ok: false; detail: string }> {
  try {
    const account = await verifyLinearApiAccount(apiKey, fetchImpl);
    return { ok: true, viewer: `${account.name} (${account.email}) · ${account.workspaceName}`, account };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function formatConnectStatus(input: {
  readonly discordBot: boolean;
  readonly linear: boolean;
  readonly email: boolean;
  readonly emailUsername?: string;
  readonly emailHost?: string;
}): string {
  const linear = input.linear ? "connected" : "not connected — /connect linear";
  const email = input.email
    ? `connected${input.emailUsername === undefined ? "" : ` · ${input.emailUsername}`}${
        input.emailHost === undefined ? "" : ` @ ${input.emailHost}`
      }`
    : "not connected — /connect email";
  return [
    `discord: ${input.discordBot ? "bot token stored · /discord for servers and allowlists" : "not connected — /connect discord"}`,
    `linear: ${linear}`,
    `email: ${email}`,
  ].join("\n");
}

async function withFlow(shell: ClankieFaceShell, title: string, run: () => Promise<void>): Promise<void> {
  shell.setupFlow.begin(title);
  try {
    await run();
  } finally {
    shell.setupFlow.end();
  }
}

async function showConnectStatus(shell: ClankieFaceShell, services: ConnectCommandServices): Promise<void> {
  const stored = await services.settings.load();
  const credentials = await services.listCredentials();
  shell.insertCommandResult(
    "/connect status",
    formatConnectStatus({
      discordBot: credentials.discord_bot !== undefined,
      linear: credentials[LINEAR_PROVIDER_ID] !== undefined,
      email: credentials[EMAIL_PROVIDER_ID] !== undefined,
      ...(stored.email.username === undefined ? {} : { emailUsername: stored.email.username }),
      ...(stored.email.imapHost === undefined ? {} : { emailHost: stored.email.imapHost }),
    }),
    "success",
  );
}

async function runConnectWizard(shell: ClankieFaceShell, services: ConnectCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("connect");
  try {
    for (;;) {
      const credentials = await services.listCredentials();
      const action = await flow.readSelect({
        message: "Give Clankie access to your services",
        options: [
          ...(services.accounts
            ? [
                {
                  value: "accounts",
                  label: "Account connections",
                  hint: "Body catalog · consent and access",
                  description: "Review available services and authorize Google access in your browser.",
                },
              ]
            : []),
          {
            value: "discord",
            label: "Discord",
            hint: credentials.discord_bot === undefined ? "create a bot, invite him" : "configured",
            description:
              "He joins your servers as a bot. You create the application; /discord walks the rest.",
          },
          {
            value: "linear",
            label: "Linear",
            hint: credentials[LINEAR_PROVIDER_ID] === undefined ? "browser OAuth" : "configured",
            description:
              "Sign in with Linear (same OAuth as their MCP). Search and file issues from every room.",
          },
          {
            value: "email",
            label: "Email",
            hint: credentials[EMAIL_PROVIDER_ID] === undefined ? "IMAP + app password" : "configured",
            description:
              "Read and send from the operator console only. Gmail, iCloud, Fastmail, Outlook, or custom.",
          },
          { value: "status", label: "Show status" },
          { value: "done", label: "Done" },
        ],
      });
      const choice = action;
      if (choice === undefined || choice === "done") break;
      if (choice === "accounts" && services.accounts) {
        await providerAccountsSection(flow, services.accounts);
        continue;
      }
      if (choice === "status") {
        await showConnectStatus(shell, services);
        continue;
      }
      if (choice === "discord") {
        const next = await flow.readSelect({
          message: "Discord",
          options: [
            { value: "configure", label: "Configure", hint: "token, servers, allowlists" },
            { value: "invite", label: "Invite link", hint: "needs an application id" },
          ],
          allowBack: true,
        });
        if (next === "configure") await services.runDiscordWizard(shell, services);
        else if (next === "invite") await services.showDiscordInvite(shell, services);
        continue;
      }
      if (choice === "linear") await runLinearWizard(shell, services);
      else if (choice === "email") await runEmailWizard(shell, services);
    }
  } finally {
    flow.end();
  }
}

async function runLinearWizard(shell: ClankieFaceShell, services: ConnectCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const listed = await services.listCredentials();
  const existing = listed[LINEAR_PROVIDER_ID];
  const following = (await services.settings.load()).linearWebhook.following;
  const followHint = existing === undefined ? "connect account" : following ? "on" : "off";
  if (existing !== undefined) {
    const decision = await flow.readSelect({
      message: `Linear is already stored — ${describeRedactedCredential(existing)}`,
      options: [
        { value: "keep", label: "Keep it" },
        { value: "follow", label: "Follow Linear", hint: followHint },
        { value: "oauth", label: "Sign in with Linear again", hint: "browser OAuth" },
        { value: "key", label: "Replace with an API key" },
        { value: "app", label: "Connect a Clankie app", hint: "worker names and avatars" },
        { value: "remove", label: "Disconnect Linear" },
      ],
      allowBack: true,
    });
    const choice = decision;
    if (choice === undefined || choice === "keep") return;
    if (choice === "follow") {
      await runLinearFollowFlow(shell, services);
      return;
    }
    if (choice === "remove") {
      await services.removeCredential(LINEAR_PROVIDER_ID);
      shell.insertCommandResult("/connect linear", "Disconnected Linear.", "success");
      return;
    }
    if (choice === "oauth") {
      await connectLinearOauth(shell, services);
      return;
    }
    if (choice === "key") {
      await connectLinearApiKey(shell, services);
      return;
    }
    if (choice === "app") {
      await connectLinearApplication(shell, services);
      return;
    }
  }

  const method = await flow.readSelect({
    message: "Connect Linear",
    options: [
      {
        value: "oauth",
        label: "Sign in with Linear",
        hint: "browser OAuth",
        description: "The same OAuth 2.1 flow their MCP uses. No API key to mint.",
      },
      {
        value: "key",
        label: "Paste an API key",
        hint: "advanced",
        description: `Personal key from ${LINEAR_KEY_URL}.`,
      },
      { value: "app", label: "Connect a Clankie app", hint: "worker names and avatars" },
      {
        value: "follow",
        label: "Follow Linear",
        hint: followHint,
        description: "Verified Linear activity in your chosen chat, with configurable wake rules.",
      },
    ],
    allowBack: true,
  });
  if (method === "oauth") await connectLinearOauth(shell, services);
  else if (method === "key") await connectLinearApiKey(shell, services);
  else if (method === "app") await connectLinearApplication(shell, services);
  else if (method === "follow") await runLinearFollowFlow(shell, services);
}

async function runLinearWakeFlow(shell: ClankieFaceShell, services: ConnectCommandServices): Promise<void> {
  const current = (await services.settings.load()).linearWebhook.wake;
  const fields = [
    ["actors", "Actors: owner, human, self (Clankie and workers), users"],
    ["ownerUserIds", "Owner's Linear user IDs"],
    ["ownerUserEmails", "Owner's Linear email addresses"],
    ["userIds", "Named Linear user IDs (for users)"],
    ["notificationTypes", "Notification types (none means all types)"],
    ["excludedNotificationTypes", "Excluded types (always win)"],
  ] as const;
  const patch: Record<string, string[]> = {};
  shell.setupFlow.renderLine(
    "Comma-separated values; enter none to clear. Unknown authors never wake. Changes apply to new signed webhook events.",
    "info",
  );
  for (const [key, message] of fields) {
    const value = await shell.setupFlow.readText({
      message,
      defaultValue: current[key].join(",") || "none",
      validate: (value) => {
        const values = value.trim() === "none" ? [] : value.split(",").map((part) => part.trim());
        return LinearWakeSettingsSchema.safeParse({ ...current, [key]: values }).success
          ? undefined
          : "Use valid comma-separated values.";
      },
    });
    if (value === undefined) return;
    patch[key] = value.trim() === "none" ? [] : value.split(",").map((part) => part.trim());
  }
  await services.settings.update((value) => ({
    ...value,
    linearWebhook: { ...value.linearWebhook, wake: LinearWakeSettingsSchema.parse(patch) },
  }));
  shell.insertCommandResult(
    "/linear",
    "Linear wake rules saved. Activity stays visible in your chosen chat.",
    "success",
  );
}

export async function runLinearFollowMenu(
  shell: ClankieFaceShell,
  services: ConnectCommandServices,
): Promise<void> {
  await withFlow(shell, "linear", () => runLinearFollowFlow(shell, services));
}

/** Configure the webhook independently of the switch that wakes the operator conversation. */
async function runLinearFollowFlow(shell: ClankieFaceShell, services: ConnectCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const options = { settings: services.settings, credentials: { get: services.getCredential } };
  const status = await runLinearCommand(["status"], options);
  const following = status.following;
  const action = await flow.readSelect({
    message:
      status.reason && following
        ? `Follow Linear is on but blocked: ${status.detail} [${status.reason}]`
        : `Follow Linear is ${following ? "on" : "off"}`,
    options: [
      {
        value: following ? "off" : "on",
        label: following ? "Stop following" : "Start following",
        hint: following
          ? "Keep activity visible in the chosen chat without waking him"
          : "Wake the chosen chat for verified events that match the wake rules",
      },
      { value: "wake", label: "Wake rules", hint: "Who and which events wake Clankie" },
      { value: "target", label: "Wake chat", hint: status.wakeConversationId },
      { value: "setup", label: "Configure webhook", hint: "URL, all activity events, signing secret" },
    ],
    allowBack: true,
  });
  if (action === undefined) return;
  if (action === "target") {
    const conversationId = await flow.readText({
      message: "Existing global chat ID",
      defaultValue: status.wakeConversationId,
      validate: (value) => (/^[a-zA-Z0-9_-]{1,256}$/u.test(value) ? undefined : "Enter a chat ID."),
    });
    if (conversationId === undefined) return;
    const result = await runLinearCommand(["target", "set", conversationId], options);
    shell.insertCommandResult("/linear", `Linear wake chat: ${result.wakeConversationId}`, "success");
    return;
  }
  if (action === "wake") {
    await runLinearWakeFlow(shell, services);
    return;
  }
  if (action === "on" || action === "off") {
    if (action === "on" && (await services.listCredentials())[LINEAR_PROVIDER_ID] === undefined) {
      shell.insertCommandResult("/connect linear", "Connect Clankie’s Linear account first.", "error");
      return;
    }
    const result = await runLinearCommand(["follow", action], options);
    if (!result.ok) {
      shell.insertCommandResult("/connect linear", `${result.error}: ${result.detail}`, "error");
      return;
    }
    shell.insertCommandResult(
      "/connect linear",
      result.following
        ? "Following verified Linear events in the chosen chat."
        : "Stopped following Linear. New activity stays visible in the chosen chat without waking him.",
      "success",
    );
    return;
  }
  const doorway = await services.gatewayHook?.();
  if (doorway === undefined) {
    shell.insertCommandResult(
      "/connect linear",
      [
        "Remote access is not configured, so there is no public address for Linear to call.",
        "Run /gateway first, then come back here.",
      ].join("\n"),
      "error",
    );
    return;
  }

  const webhookUrl = `${doorway.url.replace(/\/+$/u, "")}/h/${doorway.hostId}${LINEAR_WEBHOOK_PATH}`;
  flow.renderLine("Create the webhook in Linear, then paste what it shows you.", "info");
  flow.renderLine(`  URL:    ${webhookUrl}`, "info");
  flow.renderLine(
    "  Events: Select all available activity events (issues, comments, projects, and the rest)",
    "info",
  );
  flow.renderLine(`  Make it at ${LINEAR_WEBHOOK_SETTINGS_URL}`, "info");

  const listed = await services.listCredentials();
  const storedSecret = listed[LINEAR_WEBHOOK_PROVIDER_ID];
  if (storedSecret !== undefined) {
    const decision = await flow.readSelect({
      message: `Signing secret is stored — ${describeRedactedCredential(storedSecret)}`,
      options: [
        { value: "keep", label: "Keep it" },
        { value: "replace", label: "Paste a new one", hint: "after rotating it in Linear" },
        { value: "remove", label: "Remove it", hint: "stops receiving activity" },
      ],
      allowBack: true,
    });
    if (decision === undefined) return;
    if (decision === "remove") {
      await services.removeCredential(LINEAR_WEBHOOK_PROVIDER_ID);
      shell.insertCommandResult(
        "/connect linear",
        following
          ? "Removed the Linear webhook secret. Following is on but blocked: linear_webhook_required. Configure the webhook again to resume wakes."
          : "Removed the Linear webhook secret.",
        "success",
      );
      return;
    }
    if (decision === "replace") {
      const replacement = await flow.readSecret({
        message: "Signing secret from the webhook's detail page",
        validate: validateSigningSecret,
      });
      if (replacement === undefined) return;
      await services.setCredential(LINEAR_WEBHOOK_PROVIDER_ID, replacement.trim());
    }
  } else {
    const secret = await flow.readSecret({
      message: "Signing secret from the webhook's detail page",
      validate: validateSigningSecret,
    });
    if (secret === undefined) return;
    await services.setCredential(LINEAR_WEBHOOK_PROVIDER_ID, secret.trim());
  }

  await runLinearCommand(["webhook", "set", "--url", webhookUrl], options);
  shell.insertCommandResult(
    "/connect linear",
    [
      "Linear webhook ready. Select all activity events in Linear, including on an existing webhook.",
      `URL: ${webhookUrl}`,
      `Follow Linear is ${following ? "on" : "off"}. Use /connect linear → Follow Linear to change it.`,
    ].join("\n"),
    "success",
  );
}

function validateSigningSecret(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 8) return "That doesn't look like a signing secret.";
  if (/\s/u.test(trimmed)) return "A signing secret has no spaces — copy it again.";
  return undefined;
}

async function connectLinearOauth(shell: ClankieFaceShell, services: ConnectCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.setStatus("waiting for Linear sign-in… (/cancel to abort)");
  const interrupt = flow.waitForInterrupt();
  try {
    const credential = await Promise.race([
      services.runLinearOauth(),
      interrupt.promise.then(() => undefined),
    ]);
    if (credential === undefined) {
      flow.renderLine("Linear sign-in cancelled.", "warning");
      return;
    }
    if (credential.type !== "oauth") {
      flow.renderLine("Linear sign-in did not return an OAuth credential.", "error");
      return;
    }
    const result = await (services.probeLinearMcp ?? probeLinearMcp)(credential.access);
    if (!result.ok) {
      flow.renderLine(
        `Signed in, but Linear MCP rejected the token (${result.detail}). Nothing was stored.`,
        "error",
      );
      return;
    }
    await services.storeProviderCredential(LINEAR_PROVIDER_ID, credential);
    flow.renderLine("Connected to Linear.", "success");
    shell.insertCommandResult(
      "/connect linear",
      [
        "Linear connected via OAuth. Search and file issues from any room.",
        // This token cannot sign webhooks, and this is where an owner comes
        // looking for everything Linear (ADR 0165).
        "Waking on his Linear comments is a separate credential: /auth → Linear webhook secret.",
      ].join("\n"),
      "success",
    );
  } catch (cause) {
    // Say which of the several ways this fails actually happened. Linear's own
    // `error_description` reaches here through the exchange; swallowing it left
    // a stale code, a rejected client and a dead network as one sentence.
    const detail = cause instanceof Error ? cause.message : String(cause);
    flow.renderLine(
      `Linear sign-in failed: ${detail}. Nothing was stored; retry or paste an API key.`,
      "error",
    );
  } finally {
    interrupt.dispose();
  }
}

async function connectLinearApiKey(shell: ClankieFaceShell, services: ConnectCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.renderLine(`Create a personal API key at ${LINEAR_KEY_URL} (Settings → Account → Security).`, "info");
  const key = await flow.readSecret({
    message: "Linear API key",
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length < 8) return "That doesn't look like a Linear API key.";
      if (/\s/u.test(trimmed)) return "API keys cannot contain whitespace.";
      return undefined;
    },
  });
  if (key === undefined) return;

  const result = await (services.probeLinear ?? probeLinearKey)(key.trim());
  if (!result.ok) {
    flow.renderLine(`Linear rejected the key (${result.detail}). Nothing was stored.`, "error");
    return;
  }
  await services.storeProviderCredential(LINEAR_PROVIDER_ID, {
    type: "api",
    key: key.trim(),
    account: result.account,
  });
  flow.renderLine(`Connected as ${result.viewer}.`, "success");
  shell.insertCommandResult(
    "/connect linear",
    `Linear connected as ${result.viewer} with an API key. Search and file issues from any room.`,
    "success",
  );
}

async function connectLinearApplication(
  shell: ClankieFaceShell,
  services: ConnectCommandServices,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.renderLine(
    "Create a workspace OAuth application in Linear Settings → API and enable client credentials tokens. Its name and icon represent Clankie.",
    "info",
  );
  const clientId = await flow.readText({ message: "Linear application client ID" });
  if (!clientId?.trim()) return;
  const clientSecret = await flow.readSecret({ message: "Linear application client secret" });
  if (!clientSecret?.trim()) return;
  try {
    const credential = await (services.connectLinearApp ?? connectLinearApp)({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    });
    const account = credential.account!;
    await services.storeProviderCredential(LINEAR_PROVIDER_ID, credential);
    shell.insertCommandResult(
      "/connect linear",
      `Connected as ${account.name} (app) · ${account.workspaceName}. Worker posts can use their own names and avatars.`,
      "success",
    );
  } catch {
    flow.renderLine(
      "Linear could not verify the application. Check its client credentials setting and credentials. Nothing was stored.",
      "error",
    );
  }
}

async function runEmailWizard(shell: ClankieFaceShell, services: ConnectCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const listed = await services.listCredentials();
  const existing = listed[EMAIL_PROVIDER_ID];
  if (existing !== undefined) {
    const decision = await flow.readSelect({
      message: `Email is already stored — ${describeRedactedCredential(existing)}`,
      options: [
        { value: "keep", label: "Keep it" },
        { value: "replace", label: "Replace mailbox settings" },
        { value: "remove", label: "Disconnect email" },
      ],
      allowBack: true,
    });
    const choice = decision;
    if (choice === undefined || choice === "keep") return;
    if (choice === "remove") {
      await services.removeCredential(EMAIL_PROVIDER_ID);
      await services.settings.update((current) => ({
        ...current,
        email: { imapPort: 993, smtpPort: 587, secure: true },
      }));
      shell.insertCommandResult("/connect email", "Disconnected email.", "success");
      return;
    }
  }

  const preset = await flow.readSelect({
    message: "Mailbox provider",
    options: [
      { value: "gmail", label: "Gmail", hint: "needs an app password" },
      { value: "icloud", label: "iCloud", hint: "needs an app-specific password" },
      { value: "fastmail", label: "Fastmail" },
      { value: "outlook", label: "Outlook / Microsoft 365" },
      { value: "custom", label: "Custom IMAP/SMTP" },
    ],
    allowBack: true,
  });
  const presetId = preset as EmailPresetId | undefined;
  if (presetId === undefined) return;

  if (presetId === "gmail") {
    flow.renderLine(
      "Gmail: Google Account → Security → 2-Step Verification → App passwords. The ordinary account password will not work.",
      "info",
    );
  } else if (presetId === "icloud") {
    flow.renderLine("iCloud: appleid.apple.com → Sign-In and Security → App-Specific Passwords.", "info");
  }

  const current = (await services.settings.load()).email;
  const username = await flow.readText({
    message: "Mailbox username (usually your email address)",
    placeholder: current.username ?? "you@example.com",
    validate: (value) => (value.trim().length === 0 ? "Required." : undefined),
  });
  if (username === undefined) return;

  let hosts: Partial<EmailSettings> = presetId === "custom" ? {} : EMAIL_PRESETS[presetId];
  if (presetId === "custom") {
    const imapHost = await flow.readText({
      message: "IMAP host",
      placeholder: current.imapHost ?? "imap.example.com",
      validate: (value) => (value.trim().length === 0 ? "Required." : undefined),
    });
    if (imapHost === undefined) return;
    const smtpHost = await flow.readText({
      message: "SMTP host",
      placeholder: current.smtpHost ?? "smtp.example.com",
      validate: (value) => (value.trim().length === 0 ? "Required." : undefined),
    });
    if (smtpHost === undefined) return;
    hosts = {
      imapHost: imapHost.trim(),
      smtpHost: smtpHost.trim(),
      imapPort: 993,
      smtpPort: 587,
      secure: true,
    };
  }

  // Asked separately because a mailbox on his own domain usually forwards into
  // a provider box: the sign-in name is the provider's, the address he is known
  // by is not. Blank keeps them the same, which is the ordinary case.
  const fromAddress = await flow.readText({
    message: "Address he sends as (blank = the username above)",
    placeholder: current.fromAddress ?? username.trim(),
    validate: (value) =>
      value.trim().length === 0 || value.includes("@") ? undefined : "Must be an email address.",
  });
  if (fromAddress === undefined) return;

  const password = await flow.readSecret({
    message: "Mailbox password or app password",
    validate: (value) => (value.trim().length === 0 ? "Required." : undefined),
  });
  if (password === undefined) return;

  await services.setCredential(EMAIL_PROVIDER_ID, password.trim());
  await services.settings.update((currentSettings) => ({
    ...currentSettings,
    email: {
      imapPort: hosts.imapPort ?? 993,
      smtpPort: hosts.smtpPort ?? 587,
      secure: hosts.secure ?? true,
      ...(hosts.imapHost === undefined ? {} : { imapHost: hosts.imapHost }),
      ...(hosts.smtpHost === undefined ? {} : { smtpHost: hosts.smtpHost }),
      username: username.trim(),
      ...(fromAddress.trim().length === 0 ? {} : { fromAddress: fromAddress.trim() }),
    },
  }));
  const identity = fromAddress.trim().length === 0 ? username.trim() : fromAddress.trim();
  shell.insertCommandResult(
    "/connect email",
    `Email connected for ${identity}. Mail is console-only — he will not read or send it from Discord.`,
    "success",
  );
}
