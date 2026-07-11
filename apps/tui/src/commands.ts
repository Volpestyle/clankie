/**
 * The operator console's slash commands. Display fields feed the ported
 * typeahead / Ctrl+/ workbench / autocomplete; `run` handlers speak to the
 * shell API and the current live-session/control-plane projections. Command UX follows v1:
 * results land as `done /cmd command` transcript blocks, configurators run as
 * guided SetupFlow wizards.
 */
import {
  AGENT_SPINNER_CYCLE_NAME,
  AGENT_SPINNER_NAMES,
  AGENT_SPINNER_PRESET_NAMES,
  normalizeAgentSpinnerSelection,
} from "./face/agent-spinners.ts";
import {
  parseAgentSpinnerCycleRateMs,
  parseInputPlacement,
  parseStatusPlacement,
} from "./shell/face-settings.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";
import type { MenuOption } from "./shell/setup-flow.ts";
import { MissionDashboard } from "./components/mission-dashboard.ts";
import type { MissionObserver } from "./observation/mission-observer.ts";
import { pushTimeline, type ConsoleState, type DoctrineSettings } from "./session/state.ts";

type StatusTone = "normal" | "active" | "ok" | "warn" | "bad" | "muted";

export interface ConsoleCommandContext {
  readonly state: ConsoleState;
  readonly observer?: MissionObserver;
  readonly captain?: {
    readonly connectionState: string;
    readonly hasActiveTurn: boolean;
    readonly tokenStatus: string;
    newSession(): Promise<void>;
  };
}

export function buildConsoleCommands(context: ConsoleCommandContext): FaceShellCommand[] {
  const { state, captain, observer } = context;
  const commands: FaceShellCommand[] = [];
  const dashboard = () => observer?.dashboard ?? state.dashboard;

  const statusHelpers = (shell: ClankieFaceShell) => {
    const { ansi } = shell.theme;
    return {
      title: (text: string) => ansi.bold(ansi.cyan(text)),
      line: (label: string, value: string, tone: StatusTone = "normal") =>
        `${ansi.dim(`${label}:`)} ${statusValue(shell, value, tone)}`,
      dim: ansi.dim,
    };
  };

  function statusValue(shell: ClankieFaceShell, value: string, tone: StatusTone): string {
    const { ansi } = shell.theme;
    if (tone === "normal" && value.includes("\x1b[")) return value;
    switch (tone) {
      case "active":
        return ansi.bold(ansi.cyan(value));
      case "ok":
        return ansi.green(value);
      case "warn":
        return ansi.yellow(value);
      case "bad":
        return ansi.red(value);
      case "muted":
        return ansi.dim(value);
      case "normal":
        return ansi.bold(value);
    }
  }

  commands.push(
    {
      name: "help",
      aliases: ["h"],
      description: "Show available commands",
      takesArgument: false,
      run(_argument, shell): void {
        const { ansi } = shell.theme;
        const lines = commands.map((command) => {
          const aliases =
            command.aliases.length > 0
              ? ansi.dim(` (${command.aliases.map((a) => `/${a}`).join(", ")})`)
              : "";
          const hint = command.argumentHint === undefined ? "" : ` ${ansi.dim(command.argumentHint)}`;
          return `${ansi.cyan(`/${command.name}`)}${hint}${aliases} ${ansi.dim("·")} ${command.description}`;
        });
        lines.push(
          "",
          `${ansi.dim("ctrl+/ command workbench · ctrl+t transcript focus · ! shell escape · esc detach")}`,
        );
        shell.insertCommandResult("/help", lines.join("\n"), "success");
      },
    },
    {
      name: "mission",
      aliases: ["m"],
      description: "Observe missions; select by id or move with next/prev",
      argumentHint: "[list|next|prev|<mission-id>]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const selector = argument.trim();
        if (selector.length > 0 && selector !== "list") {
          if (observer === undefined || !(await observer.selectMission(selector))) {
            shell.insertCommandResult(
              `/mission ${selector}`,
              `Unknown mission selector: ${selector}. Use /mission list.`,
              "error",
            );
            return;
          }
        }
        shell.insertCommandComponent(
          selector.length === 0 ? "/mission" : `/mission ${selector}`,
          new MissionDashboard(dashboard),
          "success",
        );
        shell.refreshStatusView();
      },
    },
    {
      name: "doctrine",
      aliases: ["d"],
      description: "Guided doctrine setup: granularity, parallelism, assurance, merge, visibility",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        await runDoctrineWizard(shell, state);
      },
    },
    {
      name: "approvals",
      aliases: ["a", "inbox"],
      description: "Review pending approvals with evidence and doctrine rationale",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        await runApprovalInbox(shell, state);
      },
    },
    {
      name: "eval",
      aliases: [],
      description: "Show how to refresh the lead-agent proof score",
      takesArgument: false,
      run(_argument, shell): void {
        shell.insertCommandResult(
          "/eval",
          "Run `pnpm eval:self-build` from the repo root to refresh the proof report; artifacts land in artifacts/.",
          "success",
        );
      },
    },
    {
      name: "layout",
      aliases: ["header", "banner"],
      description: "Configure header, chat input, status bar, and spinner",
      argumentHint:
        "[status|input top|input bottom|status above|status below|header on|header off|spinner <name>|spinner rate <ms>]",
      takesArgument: true,
      run(argument, shell): void {
        runLayoutCommand(shell, argument);
      },
    },
    {
      name: "clear",
      aliases: [],
      description: "Clear the transcript",
      takesArgument: false,
      run(_argument, shell): void {
        shell.clearTranscript();
        shell.refreshStatus("ready");
      },
    },
    {
      name: "new",
      aliases: ["n"],
      description: "Start a fresh captain session",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        await captain?.newSession();
        shell.clearTranscript();
        shell.insertMarkdown("**Notice**\n\nFresh captain session. Mission state is unchanged.");
        shell.refreshStatus("ready");
      },
    },
    {
      name: "status",
      aliases: [],
      description: "Show console, mission, and control-plane status",
      takesArgument: false,
      run(_argument, shell): void {
        const s = statusHelpers(shell);
        const observed = dashboard();
        shell.insertCommandResult(
          "/status",
          [
            s.title("Console"),
            s.line("mission", observed.mission, "active"),
            s.line("doctrine", observed.doctrine, "active"),
            s.line("workers", String(observed.agents.length), "normal"),
            s.line(
              "attention",
              String(observed.attention.length),
              observed.attention.length > 0 ? "warn" : "ok",
            ),
            s.line(
              "approvals pending",
              String(state.approvals.length),
              state.approvals.length > 0 ? "warn" : "ok",
            ),
            s.line(
              "captain",
              captain?.connectionState ?? "not configured",
              captain?.connectionState === "live" ? "ok" : "warn",
            ),
            ...(captain?.tokenStatus === undefined || captain.tokenStatus.length === 0
              ? []
              : [s.line("model usage", captain.tokenStatus, "normal")]),
            s.line(
              "mission observer",
              `${observed.connection} · cursor #${observed.cursor.toString()}`,
              "ok",
            ),
          ].join("\n"),
          "success",
        );
      },
    },
    {
      name: "exit",
      aliases: ["quit"],
      description: "Quit the console",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        await shell.shutdown(0, { abortTurn: true });
      },
    },
  );

  return commands;
}

const DOCTRINE_AXES: ReadonlyArray<{
  readonly key: keyof DoctrineSettings;
  readonly message: string;
  readonly description: string;
  readonly options: readonly MenuOption[];
}> = [
  {
    key: "granularity",
    message: "Change granularity — how aggressively the lead splits reviewable units",
    description: "How aggressively the lead splits reviewable units.",
    options: [
      { value: "Micro", label: "Micro", hint: "many tiny reviewable changes" },
      { value: "Small", label: "Small", hint: "default; one concern per change" },
      { value: "Balanced", label: "Balanced" },
      { value: "Batched", label: "Batched", hint: "fewer, larger changes" },
    ],
  },
  {
    key: "parallelism",
    message: "Parallel workers — hard scheduler cap, not a prompt preference",
    description: "Hard scheduler cap, not a prompt preference.",
    options: ["1", "2", "3", "4", "6", "8"].map((value) => ({ value, label: value })),
  },
  {
    key: "assurance",
    message: "Assurance — independent review and evidence requirements",
    description: "Controls independent review and evidence requirements.",
    options: [
      { value: "Fast", label: "Fast", hint: "trust the implementer" },
      { value: "Standard", label: "Standard" },
      { value: "Thorough", label: "Thorough", hint: "independent verify on every task" },
      { value: "Audited", label: "Audited", hint: "verify + review + evidence bundle" },
    ],
  },
  {
    key: "merge",
    message: "Lead merge authority — a hard capability policy evaluated outside the model",
    description: "A hard capability policy evaluated outside the model.",
    options: [
      { value: "Deny", label: "Deny", hint: "humans merge everything" },
      { value: "Approval", label: "Approval", hint: "lead proposes, human approves" },
      { value: "Conditional", label: "Conditional", hint: "policy-gated automerge" },
    ],
  },
  {
    key: "visibility",
    message: "Worker visibility — which runner workers receive visible panes",
    description: "Controls which runner workers receive visible panes.",
    options: [
      { value: "Summary", label: "Summary" },
      { value: "Write workers", label: "Write workers" },
      { value: "All workers", label: "All workers" },
    ],
  },
];

async function runDoctrineWizard(shell: ClankieFaceShell, state: ConsoleState): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("doctrine setup");
  const next: DoctrineSettings = { ...state.doctrine };
  for (const axis of DOCTRINE_AXES) {
    const selected = await flow.readSelect({
      kind: "single",
      message: axis.message,
      options: axis.options,
      currentValue: state.doctrine[axis.key],
      initialValue: next[axis.key],
      allowBack: false,
      required: true,
    });
    if (selected === undefined || selected[0] === undefined) {
      flow.end();
      shell.insertCommandResult("/doctrine", "Doctrine setup cancelled; nothing changed.", "error");
      return;
    }
    (next[axis.key] as string) = selected[0];
  }
  const changes = DOCTRINE_AXES.filter((axis) => state.doctrine[axis.key] !== next[axis.key]).map(
    (axis) => `${axis.key}: ${state.doctrine[axis.key]} → ${next[axis.key]}`,
  );
  Object.assign(state.doctrine, next);
  flow.end();
  if (changes.length === 0) {
    shell.insertCommandResult("/doctrine", "Doctrine unchanged.", "success");
    return;
  }
  for (const change of changes) pushTimeline(state, `doctrine preview changed: ${change}`);
  shell.insertCommandResult(
    "/doctrine",
    [
      "Doctrine preview updated (persistence lands with the doctrine backend):",
      ...changes.map((change) => `- ${change}`),
    ].join("\n"),
    "success",
  );
}

async function runApprovalInbox(shell: ClankieFaceShell, state: ConsoleState): Promise<void> {
  if (state.approvals.length === 0) {
    shell.insertCommandResult("/approvals", "No approvals pending.", "success");
    return;
  }
  const flow = shell.setupFlow;
  flow.begin("approval inbox");
  const picked = await flow.readSelect({
    kind: "single",
    message: `Pending approvals (${state.approvals.length})`,
    options: state.approvals.map((approval) => ({
      value: approval.id,
      label: approval.title,
      description: approval.summary,
    })),
    required: true,
  });
  const approval = state.approvals.find((candidate) => candidate.id === picked?.[0]);
  if (approval === undefined) {
    flow.end();
    shell.insertCommandResult("/approvals", "Approval review cancelled.", "error");
    return;
  }
  const decision = await flow.readSelect({
    kind: "single",
    message: approval.title,
    options: [
      { value: "approve", label: "Approve", description: approval.rationale },
      {
        value: "reject",
        label: "Reject",
        description: "Requires a reason; the lead receives it as steering.",
      },
      {
        value: "evidence",
        label: "Show evidence",
        description: approval.evidence.join(" · "),
      },
    ],
    required: true,
  });
  if (decision?.[0] === "evidence") {
    flow.end();
    shell.insertCommandResult(
      "/approvals",
      [`Evidence for "${approval.title}":`, ...approval.evidence.map((item) => `- ${item}`)].join("\n"),
      "success",
    );
    return;
  }
  if (decision?.[0] === "approve") {
    state.approvals = state.approvals.filter((candidate) => candidate.id !== approval.id);
    pushTimeline(state, `approval granted: ${approval.title}`);
    flow.end();
    shell.insertCommandResult("/approvals", `Approved: ${approval.title}`, "success");
    return;
  }
  if (decision?.[0] === "reject") {
    const reason = await flow.readText({
      message: "Rejection reason (sent to the lead)",
      placeholder: "why this should not proceed",
      validate: (value) => (value.trim().length === 0 ? "A reason is required." : undefined),
    });
    if (reason === undefined) {
      flow.end();
      shell.insertCommandResult("/approvals", "Approval review cancelled.", "error");
      return;
    }
    state.approvals = state.approvals.filter((candidate) => candidate.id !== approval.id);
    pushTimeline(state, `approval rejected: ${approval.title} — ${reason.trim()}`);
    flow.end();
    shell.insertCommandResult(
      "/approvals",
      `Rejected: ${approval.title}\nReason: ${reason.trim()}`,
      "success",
    );
    return;
  }
  flow.end();
  shell.insertCommandResult("/approvals", "Approval review cancelled.", "error");
}

function runLayoutCommand(shell: ClankieFaceShell, argument: string): void {
  const { ansi } = shell.theme;
  const normalized = argument.trim().toLowerCase();
  const words = normalized.split(/\s+/u).filter((word) => word.length > 0);

  if (normalized.length === 0 || normalized === "status") {
    const statusPlacement =
      shell.layoutSettings.statusPlacement === "above-input" ? "above input" : "below input";
    shell.insertCommandResult(
      "/layout",
      [
        `${ansi.bold(ansi.cyan("Layout"))}`,
        `${ansi.dim("input:")} ${ansi.bold(ansi.cyan(shell.layoutSettings.inputPlacement))}`,
        `${ansi.dim("status:")} ${ansi.bold(ansi.cyan(statusPlacement))}`,
        `${ansi.dim("spinner:")} ${ansi.bold(ansi.cyan(shell.spinner.name))}`,
        `${ansi.dim("spinner rate:")} ${ansi.bold(ansi.cyan(`${shell.spinnerCycleRateMs}ms/style`))}`,
        `${ansi.dim("header:")} ${shell.headerVisible ? ansi.green("on") : ansi.dim("off")}`,
        ansi.dim(
          "Usage: /layout [status|input top|bottom|status above|below|spinner <name|preset>|spinner rate <ms>|header on|off|toggle]",
        ),
      ].join("\n"),
      "success",
    );
    return;
  }

  if (words[0] === "input") {
    const placement = parseInputPlacement(words[1]);
    if (placement === undefined) {
      shell.insertCommandResult("/layout", "Usage: /layout input top|bottom", "error");
      return;
    }
    shell.setLayoutSettings({ inputPlacement: placement });
    shell.insertCommandResult("/layout", `Input placement: ${placement}.`, "success");
    return;
  }

  if (words[0] === "status" && words.length > 1) {
    const placement = parseStatusPlacement(words[1]);
    if (placement === undefined) {
      shell.insertCommandResult("/layout", "Usage: /layout status above|below", "error");
      return;
    }
    shell.setLayoutSettings({ statusPlacement: placement });
    shell.insertCommandResult(
      "/layout",
      `Status placement: ${placement === "above-input" ? "above input" : "below input"}.`,
      "success",
    );
    return;
  }

  if (words[0] === "header") {
    const value = words[1] ?? "toggle";
    const visible =
      value === "on" ? true : value === "off" ? false : value === "toggle" ? !shell.headerVisible : undefined;
    if (visible === undefined) {
      shell.insertCommandResult("/layout", "Usage: /layout header on|off|toggle", "error");
      return;
    }
    shell.setHeaderVisible(visible);
    shell.insertCommandResult("/layout", `Header: ${visible ? "on" : "off"}.`, "success");
    return;
  }

  if (words[0] === "spinner" && words[1] === "rate") {
    const rate = parseAgentSpinnerCycleRateMs(words[2], shell.spinnerCycleRateMs);
    if (rate === undefined) {
      shell.insertCommandResult("/layout", "Usage: /layout spinner rate <ms|fast|normal|slow>", "error");
      return;
    }
    shell.setSpinnerCycleRateMs(rate);
    shell.insertCommandResult("/layout", `Spinner cycle rate: ${rate}ms/style.`, "success");
    return;
  }

  if (words[0] === "spinner") {
    const selection = normalizeAgentSpinnerSelection(words.slice(1).join(" "));
    if (selection === undefined) {
      const available = [AGENT_SPINNER_CYCLE_NAME, ...AGENT_SPINNER_PRESET_NAMES, ...AGENT_SPINNER_NAMES];
      shell.insertCommandResult(
        "/layout",
        `Unknown spinner "${words.slice(1).join(" ")}". Available: ${available.join(", ")}`,
        "error",
      );
      return;
    }
    shell.setSpinner(selection);
    shell.insertCommandResult("/layout", `Spinner: ${shell.spinner.name}.`, "success");
    return;
  }

  shell.insertCommandResult(
    "/layout",
    "Usage: /layout [status|input top|bottom|status above|below|spinner <name|preset>|spinner rate <ms>|header on|off|toggle]",
    "error",
  );
}
