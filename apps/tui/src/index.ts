/**
 * Operator console entry point: the Clankie face shell (ported v1 TUI design)
 * connected to the single clankie service on port 4310.
 */
import { join, resolve } from "node:path";
import { homedir } from "node:os";
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
import { buildProviderCommands, createProviderServices, formatModelBanner } from "./provider-commands.ts";
import { buildConnectCommands } from "./connect-commands.ts";
import { buildDiscordCommands, runDiscordWizard, showDiscordInvite } from "./discord-commands.ts";
import { buildPersonaCommands } from "./persona-commands.ts";
import { buildVoiceCommands } from "./voice-commands.ts";
import { buildMemoryCommands } from "./memory-commands.ts";
import { buildGatewayCommands } from "./gateway-commands.ts";
import {
  createCaptainRouteClient,
  createCaptainOperatorConversationClient,
  newConversationTitle,
  OperatorConversationPromptSession,
  OperatorConversationSelection,
  OperatorConversationTailStore,
  parseDirectConversation,
  resolveCaptainRouteToken,
  resolveInitialConversation,
  resolveWorkspaceConversation,
} from "./session/operator-conversations.ts";
import { conversationWorkspace, launchWorkspace, resolveWorkspacePath } from "./session/workspace.ts";
import { createOperatorConversationShellSink } from "./session/operator-conversation-renderer.ts";
import { CaptainLaneTraceController, createCaptainLaneClient } from "./session/lane-observation.ts";
import { createDiscordVoiceTranscriptClient } from "./session/voice-transcripts.ts";
import { HerdrRoster } from "./observation/herdr-roster.ts";
import { herdrPaneIdFromEnv, reportHerdrAgent, reportHerdrMetadata } from "./session/herdr-report.ts";
import { PresencePoller } from "./observation/presence.ts";
import { formatCaptainPresenceStatus } from "./shell/footer.ts";
import { discoverClankieSkills } from "./skill-catalog.ts";
import { statusCommand } from "./command/status.ts";
import { doctorCommand } from "./command/doctor.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
const tuiStateRoot = process.env.CLANKIE_INSTALL_ROOT
  ? join(stateHome, "clankie", "tui")
  : join(repoRoot, ".data", "tui");
const skillCatalog = await discoverClankieSkills(repoRoot);
// The launcher resolves either the checkout or installed release as repoRoot.
// Where the operator typed `clankie` is what decides the room they land in.
const launchedWorkspace = launchWorkspace(process.cwd(), repoRoot);

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  process.stderr.write("clankie: the TUI requires a TTY\n");
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
let currentModelDisplay: string | undefined;
const services = createProviderServices({
  cwd: repoRoot,
  onConfigChanged: (config) => {
    void applyModelDisplay(config);
  },
});

// Production operator conversation client over the service's authenticated
// dispatch route. A process creates one fresh server-owned conversation;
// `--chat` is the explicit resume path. The bearer resolves through the
// credential broker (env override first), so a shell-launched face matches the
// token the launcher injected into the service.
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
const voiceTranscripts = createDiscordVoiceTranscriptClient(captainRouteClient);
const conversationSelection = new OperatorConversationSelection(conversationClient);
let currentContextUsage: OperatorConversationContextUsage | undefined;
let sideConversation: { readonly parentConversationId: string; readonly conversationId: string } | undefined;
const conversationPrompt = new OperatorConversationPromptSession({
  client: conversationClient,
  selection: conversationSelection,
  tails: new OperatorConversationTailStore(join(tuiStateRoot, "operator-conversation-tail.json")),
  herdrPaneId: () => herdrPaneIdFromEnv(),
});
await conversationPrompt.initialize();
let conversationObservation:
  | { readonly controller: AbortController; readonly done: Promise<void> }
  | undefined;
let conversationNotice: string | undefined;
let currentWorkspace = launchedWorkspace ?? repoRoot;
let currentConversationTitle: string | undefined;
try {
  const directConversationId = parseDirectConversation(process.argv.slice(2)).conversationId;
  const initial = await resolveInitialConversation({
    client: conversationClient,
    ...(directConversationId === undefined ? {} : { directConversationId }),
    ...(launchedWorkspace === undefined ? {} : { workspace: launchedWorkspace }),
  });
  const selected = await conversationSelection.select(initial.conversationId);
  currentConversationTitle = selected.title;
  currentContextUsage = selected.contextUsage;
  currentWorkspace = conversationWorkspace(selected) ?? repoRoot;
} catch (error) {
  // The service may not be ready yet; surface it and keep the console usable
  // (the /conversation command re-checks on demand).
  conversationNotice = `conversation selection unavailable: ${error instanceof Error ? error.message : String(error)}`;
}

const conversationsContext = {
  get conversationId(): string | undefined {
    return conversationSelection.conversationId;
  },
  get title(): string | undefined {
    return currentConversationTitle;
  },
  get workspace(): string {
    return currentWorkspace;
  },
  conversations: () => conversationSelection.conversations(),
  close: (conversationId: string) => conversationClient.close(conversationId),
  autonomy: async (command: Parameters<typeof conversationClient.autonomy>[1]) => {
    const conversationId = conversationSelection.conversationId;
    if (conversationId === undefined) throw new Error("No conversation is selected");
    return await conversationClient.autonomy(conversationId, command);
  },
  select: async (conversationId: string) => {
    await shell.detachActiveTurn();
    await stopConversationObservation();
    try {
      const conversation = await selectConversation(conversationId);
      shell.clearTranscript();
      if (!(await conversationPrompt.restoreHistory(conversationShellSink()))) {
        throw new Error("The selected conversation history is no longer available");
      }
      startConversationObservation();
      shell.refreshStatus("ready");
      return conversation;
    } catch (error) {
      startConversationObservation();
      throw error;
    }
  },
  fork: async () => {
    const parentConversationId = conversationSelection.conversationId;
    if (parentConversationId === undefined) throw new Error("No conversation is selected");
    if (sideConversation !== undefined) throw new Error("A side conversation is already open");
    await stopConversationObservation();
    try {
      const child = await conversationClient.fork(parentConversationId);
      const selected = await selectConversation(child.conversationId);
      sideConversation = { parentConversationId, conversationId: child.conversationId };
      return selected;
    } catch (error) {
      startConversationObservation();
      throw error;
    }
  },
  create: async (title?: string) => {
    const conversationId = conversationSelection.conversationId;
    if (conversationId === undefined) throw new Error("No conversation is selected");
    const current = await conversationClient.get(conversationId);
    if (current === undefined) throw new Error("Selected conversation no longer exists");
    const created = await conversationClient.create({
      scope: current.scope,
      title: title ?? newConversationTitle(),
    });
    return await conversationsContext.select(created.conversationId);
  },
  // `/cd`: the room for a directory, opened on first visit. The service repo is
  // not one workspace among many — it is where the global conversation lives.
  open: async (path: string) => {
    const workspace = resolveWorkspacePath(path, currentWorkspace);
    const conversation =
      launchWorkspace(workspace, repoRoot) === undefined
        ? (await conversationClient.list({ kind: "global" }))[0]
        : await resolveWorkspaceConversation({ client: conversationClient, workspace });
    if (conversation === undefined) throw new Error("No global conversation is available");
    return await conversationsContext.select(conversation.conversationId);
  },
};

async function selectConversation(conversationId: string) {
  const conversation = await conversationSelection.select(conversationId);
  currentConversationTitle = conversation.title;
  currentContextUsage = conversation.contextUsage;
  currentWorkspace = conversationWorkspace(conversation) ?? repoRoot;
  // The console's own shell escape, path completion, and footer follow the
  // captain into the directory his session now works in.
  shell.setCwd(currentWorkspace);
  shell.refreshStatusView();
  return conversation;
}

function conversationShellSink() {
  return createOperatorConversationShellSink(shell, {
    onContextUsage: (usage) => {
      currentContextUsage = usage;
      shell.refreshStatusView();
    },
  });
}

function startConversationObservation(): void {
  if (conversationSelection.conversationId === undefined || conversationObservation !== undefined) return;
  const controller = new AbortController();
  const done = conversationPrompt
    .observe(conversationShellSink(), controller.signal)
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const detail = error instanceof Error ? error.message : "Unknown observation error";
      shell.insertMarkdown(`**Live conversation unavailable**\n\n${detail}. History remains durable.`);
      shell.refreshStatus("live conversation unavailable");
    });
  conversationObservation = { controller, done };
  void done.finally(() => {
    if (conversationObservation?.controller === controller) conversationObservation = undefined;
  });
}

async function stopConversationObservation(): Promise<void> {
  const observation = conversationObservation;
  if (observation === undefined) return;
  conversationObservation = undefined;
  observation.controller.abort();
  await observation.done;
}

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
    settings: settingsStore,
    commandStatus: () =>
      statusCommand({
        repoRoot,
        env: process.env,
        stderr: { write: () => undefined },
      }),
    commandDoctor: () => doctorCommand({ repoRoot, env: process.env }),
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
  ...buildGatewayCommands({ settings: settingsStore, credentials: services.store }),
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

const shell = new ClankieFaceShell({
  commands,
  cwd: currentWorkspace,
  autocomplete: { listSkills: () => skillCatalog },
  skills: skillCatalog,
  bannerFields: { title: "Clankie" },
  historyPath: join(tuiStateRoot, "prompt-history.jsonl"),
  voiceTranscripts,
  // The pi-style footer: cwd · conversation, context %, model, presence.
  footerData: () => ({
    contextUsage: currentContextUsage,
    model: currentModelDisplay,
    title: currentConversationTitle,
  }),
  statusExtras: () => [
    ...(sideConversation === undefined ? [] : ["side · ctrl+c to return"]),
    formatCaptainPresenceStatus(presence.snapshot),
  ],
  // The selected server-owned conversation is the only production prompt path.
  onPrompt: async (prompt, activeShell, signal) => {
    await stopConversationObservation();
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
      startConversationObservation();
      await reportHerdrAgent("idle", { source: "clankie", agent: "clankie" });
    }
  },
  // Esc while a turn streams: cancel the run server-side (Clankie stops); the
  // tail settles on the durable `cancelled` event. Detach remains the fallback.
  onInterrupt: () => conversationPrompt.interruptActive(),
  onSideExit: returnFromSideConversation,
  onExit: async () => {
    await stopConversationObservation();
    presence.stop();
    herdrRoster.stop();
    if (sideConversation !== undefined) {
      await conversationClient.close(sideConversation.conversationId);
      sideConversation = undefined;
    }
    await reportHerdrAgent("idle", { source: "clankie", agent: "clankie" });
  },
});

async function returnFromSideConversation(): Promise<void> {
  const side = sideConversation;
  if (side === undefined) return;
  await stopConversationObservation();
  let closed: boolean;
  try {
    closed = await conversationClient.close(side.conversationId);
  } catch (error) {
    startConversationObservation();
    throw error;
  }
  if (!closed) {
    startConversationObservation();
    throw new Error("The side conversation could not be closed");
  }
  await selectConversation(side.parentConversationId);
  sideConversation = undefined;
  shell.endSideConversation();
  await conversationPrompt.restore(conversationShellSink());
  startConversationObservation();
  shell.refreshStatus("ready");
}

async function applyModelDisplay(config: ClankieConfig): Promise<void> {
  try {
    currentModelDisplay = await formatModelBanner(config, services.captainModels);
  } catch {
    currentModelDisplay = undefined;
  }
  // The footer reads the model lazily; a repaint is all a change needs.
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
void reportHerdrAgent("idle", { source: "clankie", agent: "clankie", message: "Clankie TUI" });
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
      : "Connected to Clankie. Plain prompts continue in the current conversation.",
    ...(conversationSelection.conversationId === undefined
      ? []
      : [`Conversation: ${currentConversationTitle ?? "current"} · /conversation to list or switch.`]),
    ...(conversationNotice === undefined ? [] : [conversationNotice]),
    "Try /auth, /provider, /model, /status, /board — or type a prompt.",
  ].join("\n"),
);
shell.refreshStatus("ready");
if (conversationSelection.conversationId !== undefined) {
  void conversationPrompt
    .restoreHistory(conversationShellSink())
    .then((restored) => {
      if (restored) startConversationObservation();
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "Unknown restore error";
      shell.insertMarkdown(`**Conversation restore unavailable**\n\n${detail}. No prompt was sent.`);
      shell.refreshStatus("conversation restore unavailable");
    });
}
void loadConfig({ env: process.env, cwd: repoRoot })
  .then(({ config }) => {
    applyModelDisplay(config);
  })
  .catch(() => {
    // Config problems surface in /model and /auth; the face still boots.
  });
