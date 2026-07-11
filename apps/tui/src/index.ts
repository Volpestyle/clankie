import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  ProcessTerminal,
  SettingsList,
  TUI,
  matchesKey,
  type EditorTheme,
  type SelectListTheme,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { MissionDashboard, type DashboardState } from "./components/mission-dashboard.ts";

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => chalk.cyan(text),
  selectedText: (text) => chalk.bold(text),
  description: (text) => chalk.dim(text),
  scrollInfo: (text) => chalk.dim(text),
  noMatch: (text) => chalk.red(text),
};
const editorTheme: EditorTheme = {
  borderColor: (text) => chalk.dim(text),
  selectList: selectTheme,
};
const settingsTheme: SettingsListTheme = {
  label: (text, selected) => (selected ? chalk.bold.cyan(text) : text),
  value: (text, selected) => (selected ? chalk.bold(text) : chalk.dim(text)),
  description: (text) => chalk.dim(text),
  cursor: chalk.cyan("›"),
  hint: (text) => chalk.dim(text),
};

const state: DashboardState = {
  mission: "Lead-agent proof mission",
  doctrine: "self-build-lab",
  agents: [
    {
      id: "captain-main",
      harness: "eve",
      state: "working",
      task: "coordinating mission",
      location: "Observatory",
    },
    {
      id: "codex-builder-1",
      harness: "codex",
      state: "completed",
      task: "retry utility",
      location: "Build Grove",
    },
    {
      id: "claude-verifier-1",
      harness: "claude",
      state: "failed",
      task: "initial verification",
      location: "Recovery Shed",
    },
    {
      id: "pi-debugger-1",
      harness: "pi",
      state: "working",
      task: "repair off-by-one",
      location: "Recovery Shed",
    },
  ],
  attention: ["Merge action will require a human decision after re-verification."],
  timeline: [
    "mission.created",
    "context contract extracted",
    "implementation completed",
    "verification failed: final retry attempt skipped",
    "debug task added",
  ],
};

const dashboard = new MissionDashboard(() => state);
tui.addChild(dashboard);

function appendTimeline(message: string): void {
  state.timeline.push(message);
  tui.requestRender();
}

function showDoctrine(): void {
  const settings = new SettingsList(
    [
      {
        id: "granularity",
        label: "Change granularity",
        description: "How aggressively the lead splits reviewable units.",
        currentValue: "Small",
        values: ["Micro", "Small", "Balanced", "Batched"],
      },
      {
        id: "parallelism",
        label: "Parallel workers",
        description: "Hard scheduler cap, not a prompt preference.",
        currentValue: "3",
        values: ["1", "2", "3", "4", "6", "8"],
      },
      {
        id: "assurance",
        label: "Assurance",
        description: "Controls independent review and evidence requirements.",
        currentValue: "Thorough",
        values: ["Fast", "Standard", "Thorough", "Audited"],
      },
      {
        id: "merge",
        label: "Lead merge authority",
        description: "A hard capability policy evaluated outside the model.",
        currentValue: "Approval",
        values: ["Deny", "Approval", "Conditional"],
      },
      {
        id: "visibility",
        label: "Worker visibility",
        description: "Controls which runner workers receive visible panes.",
        currentValue: "Write workers",
        values: ["Summary", "Write workers", "All workers"],
      },
    ],
    8,
    settingsTheme,
    (id, value) => appendTimeline(`doctrine preview changed: ${id}=${value}`),
    () => appendTimeline("doctrine editor closed"),
  );
  tui.showOverlay(settings, { width: "80%", maxHeight: "75%", anchor: "center" });
}

const editor = new Editor(tui, editorTheme, { paddingX: 1 });
editor.setAutocompleteProvider(
  new CombinedAutocompleteProvider(
    [
      { name: "doctrine", description: "Open orchestration doctrine controls" },
      { name: "eval", description: "Show the latest lead-agent score" },
      { name: "help", description: "Show available commands" },
      { name: "quit", description: "Exit the TUI" },
    ],
    process.cwd(),
  ),
);
editor.onSubmit = (value) => {
  const command = value.trim();
  if (command === "/quit") {
    tui.stop();
    process.exit(0);
  } else if (command === "/doctrine") {
    showDoctrine();
  } else if (command === "/eval") {
    appendTimeline("run `pnpm eval:self-build` to refresh the proof report");
  } else if (command === "/help") {
    appendTimeline("select agents, inspect attention, edit doctrine, or open a terminal pane");
  } else if (command) {
    appendTimeline(`captain steering queued: ${command}`);
  }
};
tui.addChild(editor);
tui.setFocus(editor);

tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl("c"))) {
    tui.stop();
    process.exit(0);
  }
  if (matchesKey(data, Key.ctrlShift("d"))) {
    showDoctrine();
  }
  return undefined;
});

tui.onDebug = () =>
  appendTimeline(`debug snapshot: agents=${state.agents.length} attention=${state.attention.length}`);
tui.start();
