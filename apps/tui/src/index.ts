/**
 * Operator console entry point: the Clankie face shell (ported v1 TUI design)
 * connected to the durable local Eve captain session API.
 */
import { join, resolve } from "node:path";
import { ClankieApiClient } from "@clankie/api-client";
import { loadConfig, resolveRole, type ClankieConfig } from "@clankie/model-provider";
import { ClankieFaceShell } from "./shell/shell.ts";
import { buildConsoleCommands } from "./commands.ts";
import { buildProviderCommands, createProviderServices } from "./provider-commands.ts";
import { createInitialConsoleState } from "./session/state.ts";
import { EveCaptainSession } from "./session/eve-captain.ts";
import { CaptainSessionCursorStore } from "./session/session-cursor.ts";
import { runRecoveryProbe } from "./recovery-probe.ts";
import { MissionDashboard } from "./components/mission-dashboard.ts";
import { SqliteMissionEventSource } from "./observation/mission-events.ts";
import { MissionObserver } from "./observation/mission-observer.ts";

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
const approvalClient = process.env.CLANKIE_OPERATOR_TOKEN
  ? new ClankieApiClient({
      baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
      operatorToken: process.env.CLANKIE_OPERATOR_TOKEN,
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
const commands = [
  ...buildConsoleCommands({
    state,
    captain,
    observer: missionObserver,
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
    captain.connectionState,
    missionObserver.dashboard.connection,
    ...(captain.tokenStatus.length === 0 ? [] : [captain.tokenStatus]),
  ],
  onPrompt: (prompt, activeShell, signal) => captain.prompt(prompt, activeShell, signal),
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
        "Connected to the durable local Eve captain. Plain prompts now reach the configured model.")
      : "The captain service is unavailable. Direct `clankie` startup normally launches it; check the captain log.",
    "Try /auth, /provider, /model, /status — or type a prompt.",
  ].join("\n"),
);
shell.insertCommandComponent("/mission", new MissionDashboard(() => missionObserver.dashboard), "success");
shell.refreshStatus("ready");
void loadConfig({ env: process.env, cwd: repoRoot })
  .then(({ config }) => {
    applyModelDisplay(config);
  })
  .catch(() => {
    // Config problems surface in /model and /auth; the face still boots.
  });
void captain.attach(shell).catch((error: unknown) => {
  shell.insertMarkdown(
    `**Session stream error**\n\n${error instanceof Error ? error.message : String(error)}`,
  );
  shell.refreshStatus("captain stream failed");
});
