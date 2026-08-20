/**
 * `/connect` is the owner-facing catalog for giving Clankie access to the
 * owner's own services (ADR 0093). Secrets go to the credential broker;
 * public identifiers go to settings.json — the same split `/discord` uses.
 */
import { SettingsStore, type EmailSettings } from "@clankie/settings";
import type { ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import { describeRedactedCredential, runDiscordWizard, showDiscordInvite } from "./discord-commands.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export const LINEAR_PROVIDER_ID = "linear";
export const EMAIL_PROVIDER_ID = "email";
export const LINEAR_KEY_URL = "https://linear.app/settings/account/security";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

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
  setCredential: (providerId: string, key: string) => Promise<void>;
  storeProviderCredential: (providerId: string, credential: ProviderCredential) => Promise<void>;
  removeCredential: (providerId: string) => Promise<unknown>;
  runDiscordWizard: typeof runDiscordWizard;
  showDiscordInvite: typeof showDiscordInvite;
  runLinearOauth: () => Promise<ProviderCredential>;
  probeLinear?: typeof probeLinearKey;
}

export function buildConnectCommands(services: ConnectCommandServices): FaceShellCommand[] {
  return [
    {
      name: "connect",
      aliases: ["integrations"],
      description: "Connect Linear, email, and Discord so Clankie can use them",
      argumentHint: "[status|linear|email|discord]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const selector = normalizeConnectArgument(argument);
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

export async function probeLinearKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; viewer: string } | { ok: false; detail: string }> {
  try {
    const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query { viewer { name } organization { name } }`,
      }),
    });
    const payload = (await response.json()) as {
      data?: {
        viewer?: { name?: string };
        organization?: { name?: string };
      };
      errors?: readonly { message?: string }[];
    };
    if (payload.errors !== undefined && payload.errors.length > 0) {
      return { ok: false, detail: payload.errors.map((entry) => entry.message ?? "Linear error").join("; ") };
    }
    const name = payload.data?.viewer?.name;
    if (name === undefined || name.length === 0) {
      return {
        ok: false,
        detail: response.ok ? "Linear did not return a viewer" : `Linear HTTP ${String(response.status)}`,
      };
    }
    const organization = payload.data?.organization?.name;
    return { ok: true, viewer: organization === undefined ? name : `${name} · ${organization}` };
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
  if (existing !== undefined) {
    const decision = await flow.readSelect({
      message: `Linear is already stored — ${describeRedactedCredential(existing)}`,
      options: [
        { value: "keep", label: "Keep it" },
        { value: "oauth", label: "Sign in with Linear again", hint: "browser OAuth" },
        { value: "key", label: "Replace with an API key" },
        { value: "remove", label: "Disconnect Linear" },
      ],
      allowBack: true,
    });
    const choice = decision;
    if (choice === undefined || choice === "keep") return;
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
    ],
    allowBack: true,
  });
  if (method === "oauth") await connectLinearOauth(shell, services);
  else if (method === "key") await connectLinearApiKey(shell, services);
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
    const result = await (services.probeLinear ?? probeLinearKey)(credential.access);
    if (!result.ok) {
      flow.renderLine(
        `Signed in, but Linear GraphQL rejected the token (${result.detail}). Nothing was stored.`,
        "error",
      );
      return;
    }
    await services.storeProviderCredential(LINEAR_PROVIDER_ID, {
      ...credential,
      accountId: result.viewer,
    });
    flow.renderLine(`Connected as ${result.viewer}.`, "success");
    shell.insertCommandResult(
      "/connect linear",
      `Linear connected as ${result.viewer} via OAuth. Search and file issues from any room.`,
      "success",
    );
  } catch {
    flow.renderLine("Linear sign-in failed. Nothing was stored; retry or paste an API key.", "error");
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
  await services.setCredential(LINEAR_PROVIDER_ID, key.trim());
  flow.renderLine(`Connected as ${result.viewer}.`, "success");
  shell.insertCommandResult(
    "/connect linear",
    `Linear connected as ${result.viewer} with an API key. Search and file issues from any room.`,
    "success",
  );
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
