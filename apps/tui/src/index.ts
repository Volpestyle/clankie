/**
 * Operator console entry point: the Clankie face shell (ported v1 TUI design)
 * connected to the durable local Eve captain session API.
 */
import { join, resolve } from "node:path";
import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { loadConfig, resolveRole, type ClankieConfig } from "@clankie/model-provider";
import { ClankieFaceShell } from "./shell/shell.ts";
import { buildConsoleCommands } from "./commands.ts";
import { buildProviderCommands, createProviderServices } from "./provider-commands.ts";
import { createInitialConsoleState } from "./session/state.ts";
import { EveCaptainSession } from "./session/eve-captain.ts";
import { CaptainSessionCursorStore } from "./session/session-cursor.ts";
import {
  createProductionOperatorConversationClient,
  OperatorConversationPromptSession,
  OperatorConversationSelection,
  OperatorConversationSelectionStore,
  OperatorConversationTailStore,
  parseDirectConversation,
  resolveInitialConversation,
} from "./session/operator-conversations.ts";
import { createOperatorConversationShellSink } from "./session/operator-conversation-renderer.ts";
import { runRecoveryProbe } from "./recovery-probe.ts";
import { MissionDashboard } from "./components/mission-dashboard.ts";
import { SqliteMissionEventSource } from "./observation/mission-events.ts";
import { MissionObserver } from "./observation/mission-observer.ts";
import { formatCaptainPresenceStatus } from "./shell/status-bar.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

if (process.argv.includes("--recovery-probe")) await runRecoveryProbe();

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  process.stderr.write("clankie: the operator console requires a TTY\n");
  process.exit(1);
}

const missionObserver = new MissionObserver({
  source: new SqliteMissionEventSource(
    resolve(process.env.CLANKIE_EVENT_STORE ?? join(repoRoot, "artifacts", "control-plane", "events.db")),
  ),
  checkpointPath: join(repoRoot, ".data", "tui", "mission-observer.json"),
});
await missionObserver.restore();
try {
  await missionObserver.refresh();
} catch {
  // The control plane may start after the face. The observer retries below and
  // keeps any durable checkpoint visible in the meantime.
}
const state = createInitialConsoleState();
const operatorCredential = await resolveOperatorCredential({ env: process.env });
const approvalClient = operatorCredential
  ? new ClankieApiClient({
      baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
      operatorToken: operatorCredential.token,
    })
  : undefined;
let currentModelRef: string | undefined;
const captain = new EveCaptainSession({
  host: process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4321",
  ...(process.env.CLANKIE_CAPTAIN_GENERATION === undefined
    ? {}
    : { generation: process.env.CLANKIE_CAPTAIN_GENERATION }),
  cursorStore: new CaptainSessionCursorStore(join(repoRoot, ".data", "tui", "captain-session.json")),
});
await captain.initialize();
const services = createProviderServices({
  cwd: repoRoot,
  onConfigChanged: (config) => {
    applyModelDisplay(config);
  },
});

// Production operator conversation client over the captain's authenticated
// dispatch route (Client.fetch). `--chat`/`/conversation` enumerate and select
// the real server-owned registry; the selection persists (fail-closed) and
// reloads across restart, confirmed against the server before attaching.
const conversationClient = createProductionOperatorConversationClient({
  host: process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4321",
  ...(process.env.CLANKIE_CAPTAIN_TOKEN === undefined
    ? {}
    : { captainToken: process.env.CLANKIE_CAPTAIN_TOKEN }),
});
const conversationSelectionStore = new OperatorConversationSelectionStore(
  join(repoRoot, ".data", "tui", "operator-conversation.json"),
);
const conversationSelection = new OperatorConversationSelection(conversationClient);
const conversationPrompt = new OperatorConversationPromptSession({
  client: conversationClient,
  selection: conversationSelection,
  tails: new OperatorConversationTailStore(join(repoRoot, ".data", "tui", "operator-conversation-tail.json")),
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
  await conversationSelection.select(initial.conversationId);
} catch (error) {
  // The captain may not be ready yet, or the store is corrupt; surface it and
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
    await conversationSelectionStore.write(conversation.conversationId);
    return conversation;
  },
};

const commands = [
  ...buildConsoleCommands({
    state,
    captain,
    observer: missionObserver,
    conversations: conversationsContext,
    ...(approvalClient ? { approvalClient } : {}),
  }),
  ...buildProviderCommands(services),
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
  server: `captain: ${captain.connectionState}`,
  ...(stage.value === undefined ? {} : { stage: stage.value }),
  ...(stage.label === undefined ? {} : { stageLabel: stage.label }),
};
const shell = new ClankieFaceShell({
  commands,
  cwd: repoRoot,
  bannerFields: baseBannerFields,
  historyPath: join(repoRoot, ".data", "tui", "prompt-history.jsonl"),
  statusExtras: () => [
    currentModelRef ?? "model unset — /provider then /model",
    formatCaptainPresenceStatus(missionObserver.captainPresence),
    captain.connectionState,
    missionObserver.dashboard.connection,
    ...(captain.tokenStatus.length === 0 ? [] : [captain.tokenStatus]),
  ],
  // The selected server-owned conversation is the only production prompt
  // path. Never fall back to EveCaptainSession's process-global/default session.
  onPrompt: (prompt, activeShell, signal) =>
    conversationPrompt.prompt(prompt, createOperatorConversationShellSink(activeShell), signal),
  interruptMode: "detach",
  onExit: () => {
    missionObserver.stop();
  },
});

function applyModelDisplay(config: ClankieConfig): void {
  currentModelRef = config.model;
  shell.setBannerFields({
    ...baseBannerFields,
    ...(currentModelRef === undefined ? {} : { model: currentModelRef }),
  });
  shell.refreshStatusView();
  void services.registry.catalog().then((catalog) => {
    const selected = resolveRole("model", { config, catalog });
    captain.setContextWindowTokens(selected?.model?.limit.context);
    shell.refreshStatusView();
  });
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
missionObserver.start(
  () => {
    shell.requestRender();
    shell.refreshStatusView();
  },
  (error) => {
    shell.refreshStatus(`mission observer: ${error.message}`);
  },
);
shell.insertMarkdown(
  [
    "**Notice**",
    "",
    captain.connectionState === "live"
      ? (captain.startupNotice ??
        "Connected to the durable local Eve captain. Plain prompts use the selected server-owned conversation.")
      : "The captain service is unavailable. Direct `clankie` startup normally launches it; check the captain log.",
    ...(conversationSelection.conversationId === undefined
      ? []
      : [`Conversation: ${conversationSelection.conversationId} · /conversation to list or switch.`]),
    ...(conversationNotice === undefined ? [] : [conversationNotice]),
    "Try /auth, /provider, /model, /status — or type a prompt.",
  ].join("\n"),
);
shell.insertCommandComponent("/mission", new MissionDashboard(() => missionObserver.dashboard), "success");
shell.refreshStatus("ready");
if (conversationSelection.conversationId !== undefined) {
  void conversationPrompt.restore(createOperatorConversationShellSink(shell)).catch(() => {
    shell.insertMarkdown(
      "**Conversation restore unavailable**\n\nThe durable transcript could not be restored. No prompt was sent.",
    );
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
