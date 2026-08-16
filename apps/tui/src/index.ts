/**
 * Operator console entry point: the Clankie face shell (ported v1 TUI design)
 * connected to the single clankie service on port 4310.
 */
import { join, resolve } from "node:path";
import { ClankieApiClient } from "@clankie/api-client";
import {
  resolveOperatorCredential,
  runLinearBrowserLogin,
  type ProviderCredential,
} from "@clankie/credential-broker";
import { loadConfig, type ClankieConfig } from "@clankie/model-provider";
import { SettingsStore } from "@clankie/settings";
import type { OperatorConversationContextUsage } from "@clankie/protocol";
import { ClankieFaceShell } from "./shell/shell.ts";
import { buildConsoleCommands } from "./commands.ts";
import { buildProviderCommands, createProviderServices } from "./provider-commands.ts";
import { buildConnectCommands } from "./connect-commands.ts";
import { buildDiscordCommands, runDiscordWizard, showDiscordInvite } from "./discord-commands.ts";
import { buildPersonaCommands } from "./persona-commands.ts";
import { buildVoiceCommands } from "./voice-commands.ts";
import { buildMemoryCommands } from "./memory-commands.ts";
import {
  createCaptainRouteClient,
  createCaptainOperatorConversationClient,
  OperatorConversationPromptSession,
  OperatorConversationSelection,
  OperatorConversationSelectionStore,
  OperatorConversationTailStore,
  parseDirectConversation,
  resolveCaptainRouteToken,
  resolveInitialConversation,
} from "./session/operator-conversations.ts";
import { createOperatorConversationShellSink } from "./session/operator-conversation-renderer.ts";
import { CaptainLaneTraceController, createCaptainLaneClient } from "./session/lane-observation.ts";
import { HerdrRoster } from "./observation/herdr-roster.ts";
import { ensureHerdLeadCompanion, formatHerdLeadCompanionResult } from "./observation/herd-lead-companion.ts";
import { herdrPaneIdFromEnv, reportHerdrAgent, reportHerdrMetadata } from "./session/herdr-report.ts";
import { PresencePoller } from "./observation/presence.ts";
import { formatCaptainContextStatus, formatCaptainPresenceStatus } from "./shell/status-bar.ts";
import { discoverClankieSkills } from "./skill-catalog.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const skillCatalog = await discoverClankieSkills(repoRoot);

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  process.stderr.write("clankie: the operator console requires a TTY\n");
  process.exit(1);
}

// One service serves every console-side route: the operator APIs, the
// operator conversation dispatch, and the lane listing.
const serviceUrl =
  process.env.CLANKIE_CONTROL_PLANE_URL ?? process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4310";

const herdrRoster = new HerdrRoster();
const operatorCredential = await resolveOperatorCredential({ env: process.env });
const operatorClient = operatorCredential
  ? new ClankieApiClient({ baseUrl: serviceUrl, operatorToken: operatorCredential.token })
  : undefined;
const presence = new PresencePoller({
  baseUrl: serviceUrl,
  operatorToken: operatorCredential?.token,
});
let currentModelRef: string | undefined;
const services = createProviderServices({
  cwd: repoRoot,
  onConfigChanged: (config) => {
    applyModelDisplay(config);
  },
});

// Production operator conversation client over the service's authenticated
// dispatch route. `--chat`/`/conversation` enumerate and select the real
// server-owned registry; the selection persists (fail-closed) and reloads
// across restart, confirmed against the server before attaching. The bearer
// resolves through the credential broker (env override first), so a
// shell-launched face matches the token the launcher injected into the service.
const captainRouteToken = await resolveCaptainRouteToken({ env: process.env });
const captainRouteClient = createCaptainRouteClient({
  host: serviceUrl,
  ...(captainRouteToken === undefined ? {} : { captainToken: captainRouteToken }),
});
const conversationClient = createCaptainOperatorConversationClient(captainRouteClient);
// Read-only tails onto the rooms the console is not talking in (ADR 0083).
const laneTrace = new CaptainLaneTraceController({
  lanes: createCaptainLaneClient(captainRouteClient),
});
const conversationSelectionStore = new OperatorConversationSelectionStore(
  join(repoRoot, ".data", "tui", "operator-conversation.json"),
);
const conversationSelection = new OperatorConversationSelection(conversationClient);
let currentContextUsage: OperatorConversationContextUsage | undefined;
const conversationPrompt = new OperatorConversationPromptSession({
  client: conversationClient,
  selection: conversationSelection,
  tails: new OperatorConversationTailStore(join(repoRoot, ".data", "tui", "operator-conversation-tail.json")),
  herdrPaneId: () => herdrPaneIdFromEnv(),
});
await conversationPrompt.initialize();
let conversationNotice: string | undefined;
try {
  const directConversationId = parseDirectConversation(process.argv.slice(2)).conversationId;
  const initial = await resolveInitialConversation({
    client: conversationClient,
    store: conversationSelectionStore,
    ...(directConversationId === undefined ? {} : { directConversationId }),
  });
  const selected = await conversationSelection.select(initial.conversationId);
  currentContextUsage = selected.contextUsage;
} catch (error) {
  // The service may not be ready yet, or the store is corrupt; surface it and
  // keep the console usable (the /conversation command re-checks on demand).
  conversationNotice = `conversation selection unavailable: ${error instanceof Error ? error.message : String(error)}`;
}

const conversationsContext = {
  get conversationId(): string | undefined {
    return conversationSelection.conversationId;
  },
  conversations: () => conversationSelection.conversations(),
  select: async (conversationId: string) => {
    const conversation = await conversationSelection.select(conversationId);
    currentContextUsage = conversation.contextUsage;
    await conversationSelectionStore.write(conversation.conversationId);
    shell.refreshStatusView();
    return conversation;
  },
};

const settingsStore = new SettingsStore();
const brokeredCommands = {
  settings: settingsStore,
  listCredentials: () => services.store.list(),
  setCredential: (providerId: string, key: string) => services.store.set(providerId, { type: "api", key }),
  storeProviderCredential: (providerId: string, credential: ProviderCredential) =>
    services.store.set(providerId, credential),
  removeCredential: (providerId: string) => services.store.delete(providerId),
  ...(operatorClient === undefined ? {} : { userSessionOptIn: operatorClient }),
};
const commands = [
  ...buildConsoleCommands({
    conversations: conversationsContext,
    laneTrace,
    presence: () => presence.snapshot,
    contextUsage: () => currentContextUsage,
    herdrRoster: () => (herdrRoster.active ? herdrRoster.snapshot() : undefined),
    ...(operatorClient
      ? {
          activityClient: operatorClient,
          activityWatchUrl: `http://127.0.0.1:${process.env.CLANKIE_ACTIVITY_PORT ?? "4320"}`,
        }
      : {}),
  }),
  ...buildProviderCommands(services),
  ...buildConnectCommands({
    ...brokeredCommands,
    runDiscordWizard,
    showDiscordInvite,
    runLinearOauth: () => runLinearBrowserLogin(),
  }),
  ...buildDiscordCommands(brokeredCommands),
  ...buildPersonaCommands({ settings: settingsStore }),
  ...buildVoiceCommands(brokeredCommands),
  ...buildMemoryCommands(operatorClient === undefined ? {} : { client: operatorClient }),
];

function stageFromEnv(): { label?: string; value?: string } {
  if (process.env.HERDR_ENV === "1") {
    const pane = process.env.HERDR_PANE_ID;
    return { label: "herdr", value: pane === undefined ? "session" : `pane ${pane}` };
  }
  if (process.env.TMUX !== undefined && process.env.TMUX.length > 0) {
    const pane = process.env.TMUX_PANE;
    return { label: "tmux", value: pane === undefined ? "session" : `pane ${pane}` };
  }
  return { label: "stage", value: "none" };
}

const stage = stageFromEnv();
const baseBannerFields = {
  title: "Clankie",
  tagline: "clankie agent os · operator console",
  hint: "/help for commands · ctrl+c to exit",
  cwd: repoRoot.replace(process.env.HOME ?? " ", "~"),
  server: serviceUrl,
  ...(stage.value === undefined ? {} : { stage: stage.value }),
  ...(stage.label === undefined ? {} : { stageLabel: stage.label }),
};
const shell = new ClankieFaceShell({
  commands,
  cwd: repoRoot,
  autocomplete: { listSkills: () => skillCatalog },
  skills: skillCatalog,
  bannerFields: baseBannerFields,
  historyPath: join(repoRoot, ".data", "tui", "prompt-history.jsonl"),
  statusExtras: () => [
    currentModelRef ?? "model unset — /provider then /model",
    formatCaptainContextStatus(currentContextUsage),
    formatCaptainPresenceStatus(presence.snapshot),
  ],
  // The selected server-owned conversation is the only production prompt path.
  onPrompt: async (prompt, activeShell, signal) => {
    await reportHerdrAgent("working", { source: "clankie", agent: "clankie", message: "turn" });
    try {
      await conversationPrompt.prompt(
        prompt,
        createOperatorConversationShellSink(activeShell, {
          localEchoText: prompt,
          onContextUsage: (usage) => {
            currentContextUsage = usage;
            activeShell.refreshStatusView();
          },
        }),
        signal,
      );
    } finally {
      await reportHerdrAgent("idle", { source: "clankie", agent: "clankie" });
    }
  },
  interruptMode: "detach",
  onExit: async () => {
    presence.stop();
    herdrRoster.stop();
    await reportHerdrAgent("idle", { source: "clankie", agent: "clankie" });
  },
});

function applyModelDisplay(config: ClankieConfig): void {
  currentModelRef = config.model;
  shell.setBannerFields({
    ...baseBannerFields,
    ...(currentModelRef === undefined ? {} : { model: currentModelRef }),
  });
  shell.refreshStatusView();
}

// Crash-safety envelope: Node >=24 terminates on an unhandled rejection with no
// cleanup, which would leave SGR mouse tracking + raw mode enabled (corrupt
// terminal). Restore the terminal, then exit non-zero.
let fatalErrorHandled = false;
function handleFatalError(kind: string, reason: unknown): void {
  if (fatalErrorHandled) return;
  fatalErrorHandled = true;
  try {
    shell.restoreTerminal();
  } catch {
    // Best-effort: never let cleanup mask the original failure.
  }
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`clankie: fatal ${kind}: ${message}\n`);
  process.exit(1);
}
process.on("uncaughtException", (error) => {
  handleFatalError("uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
  handleFatalError("unhandledRejection", reason);
});

shell.start();
void reportHerdrMetadata({ source: "clankie", agent: "clankie", title: "Clankie" });
void reportHerdrAgent("idle", { source: "clankie", agent: "clankie", message: "operator console" });
herdrRoster.start(() => {
  shell.requestRender();
});
presence.start(() => {
  shell.refreshStatusView();
});
shell.insertMarkdown(
  [
    "**Notice**",
    "",
    conversationSelection.conversationId === undefined
      ? "Clankie is unavailable. Direct `clankie` startup normally launches him; check the Clankie log."
      : "Connected to Clankie. Plain prompts use the selected server-owned conversation.",
    ...(conversationSelection.conversationId === undefined
      ? []
      : [`Conversation: ${conversationSelection.conversationId} · /conversation to list or switch.`]),
    ...(conversationNotice === undefined ? [] : [conversationNotice]),
    "Try /auth, /provider, /model, /status, /board — or type a prompt.",
  ].join("\n"),
);
shell.refreshStatus("ready");
if (conversationSelection.conversationId !== undefined) {
  void conversationPrompt
    .restore(
      createOperatorConversationShellSink(shell, {
        onContextUsage: (usage) => {
          currentContextUsage = usage;
          shell.refreshStatusView();
        },
      }),
    )
    .catch(() => {
      shell.insertMarkdown(
        "**Conversation restore unavailable**\n\nThe durable transcript could not be restored. No prompt was sent.",
      );
      shell.refreshStatus("conversation restore unavailable");
    });
}
void ensureHerdLeadCompanion().then((result) => {
  if (result.outcome === "skipped") return;
  const formatted = formatHerdLeadCompanionResult(result, "open");
  shell.insertMarkdown(`**Herd lead**\n\n${formatted.text} \`/board\` reopens.`);
});
void loadConfig({ env: process.env, cwd: repoRoot })
  .then(({ config }) => {
    applyModelDisplay(config);
  })
  .catch(() => {
    // Config problems surface in /model and /auth; the face still boots.
  });
