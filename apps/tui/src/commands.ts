import { runDesktopCommand } from "./command/desktop.ts";
import { runWorkerToolRefreshCommand, runWorkerToolRestartCommand } from "./command/harness.ts";
import { runClaudeAccountsCommand } from "./command/claude-accounts.ts";
import { runProjectRolesMenu } from "./project-role-menu.ts";
import { runProjectsMenu } from "./project-menu.ts";
import { runAccessMenu } from "./access-menu.ts";
import { runAccountsMenu } from "./accounts-menu.ts";
import { formatDoctorReport } from "./doctor-report.ts";
import { formatUpdateState, runUpdateMenu } from "./update-menu.ts";
import { runMinecraftMenu } from "./minecraft-menu.ts";
import { runProjectCommand } from "./command/project.ts";
import { runMachinesCommand } from "./command/machines.ts";
import { runProjectSettingsCommand } from "./command/project-settings.ts";
import { planSeat, parseSeatArgs } from "./command/seat.ts";
import { formatRivals, formatSeatPlan } from "./command-format.ts";
import { runRivalsMenu } from "./rivals-menu.ts";
import { onOff, runSettingsMenu } from "./settings-menu.ts";
import { runCodexAccountsCommand } from "./command/codex-accounts.ts";
import { runRuntimeCommand } from "./command/runtime.ts";
import { runWorkCommand } from "./command/work.ts";
import { runLinearCommand } from "./command/linear.ts";
import { runAgentsCommand, splitQuotedArguments } from "./command/agents.ts";
import { runAccountsCommand } from "./command/accounts.ts";
import { Readable } from "node:stream";
import {
  runConnectionsMenu,
  runMachineConnectionsMenu,
  type ConnectionsMenuServices,
} from "./connections-menu.ts";
import { runAccessCommand } from "./command/access.ts";
import { runEvaluatorCommand, formatEvaluatorStatus } from "./command/evaluator.ts";
import { openHerdr, type HerdrConnectionOptions } from "./session/herdr-connection.ts";
/**
 * The operator console's slash commands. Display fields feed the ported
 * typeahead / Ctrl+/ workbench / autocomplete; `run` handlers speak to the
 * shell API and the clankie service. Results land as compact command transcript
 * blocks; configurators run as guided SetupFlow wizards.
 */
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";
import type { BrowserSettings, GameplaySettings, SettingsStore } from "@clankie/settings";
import { DEFAULT_POKEMON_PLAY_MAX_TOKENS } from "@clankie/protocol";
import { formatActivityObservation, type ActivityObservationClient } from "./activity-command.ts";
import { runShareCommand, shareConsoleCommand } from "./command/share.ts";
import { hostedTransportFor } from "./command/hosted.ts";
import {
  formatLaneListing,
  laneKey,
  selectLanes,
  type CaptainLaneTraceController,
} from "./session/lane-observation.ts";
import type {
  ObservableCaptainLane,
  OperatorAutonomyCommand,
  HerdrBinding,
  OperatorAutonomyStatus,
  OperatorConversationContextUsage,
  OperatorConversationSessionState,
  EvaluatorStatus,
  OperatorConversationScope,
  OperatorAgentPersona,
} from "@clankie/protocol";
import type { PresenceSnapshot } from "./observation/presence.ts";
import type { HerdrRosterSnapshot } from "./observation/herdr-roster.ts";
import {
  closeHerdLeadCompanion,
  ensureHerdLeadCompanion,
  focusHerdLeadCompanion,
  formatHerdLeadCompanionResult,
  type HerdLeadCompanionResult,
} from "./observation/herd-lead-companion.ts";
import { describeHerdrBinding, formatCaptainContextUsage } from "./shell/footer.ts";
import { formatHerdrJumpResult, type HerdrSessionEntry } from "./session/herdr-report.ts";
import {
  browserHarnesses,
  browserSetDelegation,
  browserSetRecording,
  browserStatus,
  type BrowserHarnessesResult,
} from "./command/browser.ts";
import { runSkillsCommand } from "./command/skills.ts";
import { gamesSet, gamesStatus, gamesBudgetSet } from "./command/games.ts";
import { runRivalsCommand } from "./command/rivals.ts";
import { runMinecraftCommand } from "./command/minecraft.ts";
import { runMinecraftDriverMenu } from "./minecraft-driver-menu.ts";
import { runHerdrCommand, type HerdrCommandResult } from "./command/herdr.ts";
import type { StatusCommandResult } from "./command/status.ts";
import type { InstallDoctorReport } from "./command/doctor.ts";
import type { AwakeCommandResult } from "./command/awake.ts";
import {
  formatRuntimeHealth,
  parseRuntimeHealthArgs,
  type runRuntimeHealthCommand,
} from "./command/runtime-health.ts";

type StatusTone = "normal" | "active" | "ok" | "warn" | "bad" | "muted";

export interface ConsoleCommandContext {
  readonly repoRoot?: string;
  readonly linearFollowMenu?: (shell: ClankieFaceShell) => Promise<void>;
  readonly settings?: SettingsStore;
  readonly herdrOptions?: HerdrConnectionOptions;
  /** Herdr's saved sessions, for the `/herdr` session picker. */
  readonly herdrSessions?: () => Promise<readonly HerdrSessionEntry[]>;
  /** The binding the running service holds, as last read; the footer shows it. */
  readonly herdrBinding?: () => HerdrBinding | undefined;
  /** Re-read the live binding after anything that could move it. */
  readonly refreshHerdrBinding?: () => Promise<void>;
  readonly restartCaptain?: () => Promise<void>;
  readonly commandUpdate?: (args: readonly string[]) => Promise<unknown>;
  readonly commandStatus?: () => Promise<StatusCommandResult>;
  readonly commandDoctor?: () => Promise<InstallDoctorReport>;
  /** `clankie awake`: the launcher-supervised keep-awake, and the power state it answers to. */
  readonly commandAwake?: (args: readonly string[]) => Promise<AwakeCommandResult>;
  readonly commandRuntimeHealth?: (args: readonly string[]) => ReturnType<typeof runRuntimeHealthCommand>;
  readonly activityClient?: ActivityObservationClient;
  readonly activityWatchUrl?: string;
  /** Read-only tails onto the lanes the operator is not talking in (ADR 0083). */
  readonly laneTrace?: CaptainLaneTraceController;
  /** Latest polled presence snapshot for /status. */
  readonly presence?: () => PresenceSnapshot | undefined;
  /** Latest durable context occupancy for the selected conversation. */
  readonly contextUsage?: () => OperatorConversationContextUsage | undefined;
  /** Clankie service fleet, shared by every console. */
  readonly herdrRoster?: () => HerdrRosterSnapshot | undefined;
  /** herdr-lead board: companion dashboard beside this console. */
  readonly herdLead?: {
    ensure(): Promise<HerdLeadCompanionResult>;
    focus(): Promise<HerdLeadCompanionResult>;
    close(): Promise<HerdLeadCompanionResult>;
  };
  readonly conversations?: {
    question?(argument: string): Promise<string>;
    readonly conversationId?: string | undefined;
    readonly title?: string | undefined;
    /** Directory the selected conversation's session works in. */
    readonly workspace?: string;
    agents?(): Promise<readonly OperatorAgentPersona[]>;
    openAgent?(agent: OperatorAgentPersona): Promise<{ readonly title: string }>;
    conversations(): Promise<
      readonly {
        readonly conversationId: string;
        readonly title: string;
        readonly isDefault: boolean;
        readonly revision: number;
        readonly sessionState: OperatorConversationSessionState;
        readonly scope: OperatorConversationScope;
      }[]
    >;
    designateHead?(headConversationId: string | null): Promise<void>;
    select(conversationId: string): Promise<{ readonly conversationId: string; readonly title: string }>;
    /** Forks and selects an ephemeral Pi branch from the current conversation. */
    fork?(): Promise<{ readonly conversationId: string; readonly title: string }>;
    reset?(): Promise<{ archiveId: string }>;
    close?(conversationId: string): Promise<boolean>;
    /** Creates and selects a conversation with fresh model context in the current scope. */
    create?(title?: string): Promise<{ readonly conversationId: string; readonly title: string }>;
    /** Opens the conversation rooted at a directory, creating it on first visit. */
    open?(path: string): Promise<{ readonly conversationId: string; readonly title: string }>;
    autonomy?(command: OperatorAutonomyCommand): Promise<OperatorAutonomyStatus>;
  };
}

export function buildConsoleCommands(context: ConsoleCommandContext): FaceShellCommand[] {
  const {
    activityClient,
    activityWatchUrl,
    conversations,
    laneTrace,
    presence,
    contextUsage,
    herdrRoster,
    herdLead,
    settings,
  } = context;
  const openBoard = herdLead?.ensure ?? (() => ensureHerdLeadCompanion());
  const focusBoard = herdLead?.focus ?? (() => focusHerdLeadCompanion());
  const closeBoard = herdLead?.close ?? (() => closeHerdLeadCompanion());
  const commands: FaceShellCommand[] = [];
  if (conversations?.question)
    commands.push({
      name: "question",
      aliases: [],
      description: "Read, answer or cancel the current preference question",
      takesArgument: true,
      argumentHint: "[answer NUMBER | text TEXT | cancel]",
      async run(argument, shell) {
        try {
          shell.insertCommandResult("/question", await conversations.question!(argument), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/question",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    });

  commands.push({
    name: "update",
    aliases: [],
    description: "Stage a runtime update or read its durable result",
    argumentHint: "[--ref REF | status | canary]",
    takesArgument: true,
    async run(argument, shell) {
      if (!context.commandUpdate) {
        shell.insertCommandResult("/update", "Runtime update is unavailable on this connection", "error");
        return;
      }
      const args = argument.trim().split(/\s+/u).filter(Boolean);
      if (!args.length) {
        await runUpdateMenu(shell, context.commandUpdate);
        return;
      }
      try {
        const result = await context.commandUpdate(args);
        shell.insertCommandResult(
          "/update",
          args[0] === "status" ? formatUpdateState(result) : JSON.stringify(result, null, 2),
          "success",
        );
      } catch (error) {
        shell.insertCommandResult("/update", String(error), "error");
      }
    },
  });
  commands.push({
    name: "refresh-tools",
    aliases: [],
    description: "Refresh running workers' Clankie tools in place",
    argumentHint: "[--pane PANE]",
    takesArgument: true,
    async run(argument, shell) {
      try {
        const result = await runWorkerToolRefreshCommand([
          "refresh-tools",
          ...splitQuotedArguments(argument),
        ]);
        shell.insertCommandResult(
          "/refresh-tools",
          JSON.stringify(result, null, 2),
          result.seats.some((seat) => seat.outcome === "failed") ? "error" : "success",
        );
      } catch (error) {
        shell.insertCommandResult("/refresh-tools", String(error), "error");
      }
    },
  });
  commands.push({
    name: "restart-tools",
    aliases: [],
    description: "Check native restart admission; current local Codex exit is unavailable",
    argumentHint: "--pane PANE [--report /absolute/report]",
    takesArgument: true,
    async run(argument, shell) {
      try {
        const result = await runWorkerToolRestartCommand([
          "restart-tools",
          ...splitQuotedArguments(argument),
        ]);
        shell.insertCommandResult(
          "/restart-tools",
          JSON.stringify(result, null, 2),
          result.outcome === "restarted" ? "success" : "error",
        );
      } catch (error) {
        shell.insertCommandResult("/restart-tools", String(error), "error");
      }
    },
  });
  const connectionServices = (): ConnectionsMenuServices => ({
    machines: (args) => runMachinesCommand(args),
    runtime: (args) => runRuntimeCommand(args),
    agents: (args) => runAgentsCommand(args),
    accounts: (args, input) =>
      runAccountsCommand(args, input === undefined ? {} : { stdin: Readable.from([input]) }),
  });

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

  async function reviewHarnessLaunch(
    harness: "claude" | "codex" | "opencode" | "grok",
    argument: string,
    shell: ClankieFaceShell,
  ): Promise<void> {
    const extra = splitQuotedArguments(argument);
    if (!context.repoRoot) {
      shell.insertCommandResult(`/${harness}`, "Install location unavailable", "error");
      return;
    }
    try {
      const args = [
        ...extra,
        ...(conversations?.conversationId && !extra.includes("--conversation")
          ? ["--conversation", conversations.conversationId]
          : []),
      ];
      const plan = await planSeat(parseSeatArgs(args, harness), {
        repoRoot: context.repoRoot,
        harnessCommand: harness,
      });
      shell.insertCommandResult(
        `/${harness}`,
        [
          formatSeatPlan(plan),
          "",
          `Launch from a terminal: clankie ${harness} ${args.map((value) => JSON.stringify(value)).join(" ")}`,
          "Native permissions remain owner decisions. /skills lists the shipped skills.",
        ].join("\n"),
        "success",
      );
    } catch (error) {
      shell.insertCommandResult(`/${harness}`, String(error), "error");
    }
  }

  // Keep metadata literal so the public console reference reads the same commands.
  commands.push(
    {
      name: "claude",
      aliases: [],
      description: "Review a Clankie launch in claude",
      argumentHint: "[--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]",
      takesArgument: true,
      run: (argument, shell) => reviewHarnessLaunch("claude", argument, shell),
    },
    {
      name: "codex",
      aliases: [],
      description: "Review a Clankie launch in codex",
      argumentHint: "[--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]",
      takesArgument: true,
      run: (argument, shell) => reviewHarnessLaunch("codex", argument, shell),
    },
    {
      name: "opencode",
      aliases: [],
      description: "Review a Clankie launch in opencode",
      argumentHint: "[--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]",
      takesArgument: true,
      run: (argument, shell) => reviewHarnessLaunch("opencode", argument, shell),
    },
    {
      name: "grok",
      aliases: [],
      description: "Review a Clankie launch in Grok Build",
      argumentHint: "[--resume] [--conversation ID] [--dry-run]",
      takesArgument: true,
      run: (argument, shell) => reviewHarnessLaunch("grok", argument, shell),
    },
  );

  commands.push(
    {
      name: "evaluator",
      aliases: [],
      description: "Developer diagnostic: the independent evaluator in Herdr",
      argumentHint: "[status|enable --harness codex|claude|disable|open|retry ID]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const args = argument.trim().split(/\s+/u).filter(Boolean);
        if (args.length === 0) {
          await runEvaluatorMenu(shell);
          return;
        }
        const result = await runEvaluatorCommand(args);
        shell.insertCommandResult(
          "/evaluator",
          result.ok ? formatEvaluatorStatus(result.evaluator) : result.error,
          result.ok ? "success" : "error",
        );
      },
    },
    {
      name: "work",
      aliases: [],
      description: "Read project work, releases and goals; set the repo tracker",
      argumentHint: "[project|list|init --release-source tags|milestones|both --release-lane NAME]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const result = await runWorkCommand(
          splitQuotedArguments(argument),
          context.repoRoot ? { cwd: context.repoRoot } : {},
        );
        shell.insertCommandResult(
          "/work",
          JSON.stringify(result.body, null, 2),
          result.ok ? "success" : "error",
        );
      },
    },
    {
      name: "linear",
      aliases: [],
      description: "Configure Linear webhook wakes, rules and chat target",
      takesArgument: true,
      argumentHint: "[status|follow on/off|wake show/set|target show/set|routes show/set|deliveries]",
      async run(argument, shell): Promise<void> {
        if (!argument.trim()) {
          if (!context.linearFollowMenu) throw new Error("Linear settings menu is unavailable");
          await context.linearFollowMenu(shell);
          return;
        }
        const result = await runLinearCommand(argument.trim().split(/\s+/u).filter(Boolean));
        shell.insertCommandResult(
          "/linear",
          JSON.stringify(result, null, 2),
          result.ok === false ? "error" : "success",
        );
      },
    },
    {
      name: "connections",
      aliases: [],
      description: "Manage machines and accounts",
      argumentHint: "[json]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "") {
          await runConnectionsMenu(shell, connectionServices());
          return;
        }
        const result = await runRuntimeCommand(["inventory"]);
        shell.insertCommandResult("/connections", JSON.stringify(result, null, 2), "success");
      },
    },
    {
      name: "project",
      aliases: ["projects"],
      description: "Create or edit projects, roles, limits and tracked work; read live membership",
      takesArgument: true,
      argumentHint:
        "[list | settings PROJECT [--closure lead|owner|inherit] [--machine-setup lead|owner|inherit] | create PROJECT --settings FILE.json --revision REVISION | update PROJECT --changes FILE.json --revision REVISION | membership SEAT_ID OCCUPANT_ID]",
      async run(argument, shell): Promise<void> {
        if (!argument.trim()) {
          await runProjectsMenu(shell, {
            settings: (args) => runProjectSettingsCommand(args),
            workspace: (args) => runProjectCommand(args, settings ? { settings } : {}),
            roles: (projectId) => runProjectRolesMenu(shell, projectId),
            cwd: process.cwd(),
          });
          return;
        }
        try {
          const result = await runProjectSettingsCommand(splitQuotedArguments(argument));
          shell.insertCommandResult("/project", JSON.stringify(result, null, 2), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/project",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "machines",
      aliases: [],
      description: "Discover machines, connect sessions and manage workers",
      takesArgument: true,
      argumentHint: "[discover | add NAME --ssh HOST | sessions NAME | remove NAME]",
      async run(argument, shell): Promise<void> {
        if (!argument.trim()) {
          await runMachineConnectionsMenu(shell, connectionServices());
          return;
        }
        try {
          const result = await runMachinesCommand(splitQuotedArguments(argument));
          shell.insertCommandResult("/machines", JSON.stringify(result, null, 2), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/machines",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "runtime",
      aliases: [],
      description: "Manage machine connections (compatibility command)",
      argumentHint: "[list | connect ID --session NAME | disconnect ID]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "") {
          await runMachineConnectionsMenu(shell, connectionServices());
          return;
        }
        try {
          const result = await runRuntimeCommand(argument.trim().split(/\s+/u).filter(Boolean));
          shell.insertCommandResult("/runtime", JSON.stringify(result, null, 2), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/runtime",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "agents",
      aliases: [],
      description: "Live agents, and past ones that kept a thread",
      takesArgument: true,
      argumentHint:
        '[contacts | roles | role NAME "ROLE"|none [--project PROJECT] | rename NAME "NEW NAME" | legacy session commands; see /sessions]',
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "roles") {
          await runProjectRolesMenu(shell);
          return;
        }
        if (argument.trim()) {
          const result = await runAgentsCommand(splitQuotedArguments(argument));
          shell.insertCommandResult("/agents", JSON.stringify(result, null, 2), "success");
          return;
        }
        if (!conversations?.agents || !conversations.openAgent) {
          shell.insertCommandResult("/agents", "Agent directory is unavailable.", "error");
          return;
        }
        const flow = shell.setupFlow;
        flow.begin("agents");
        try {
          // Every hire leaves an identity behind, so the directory opens on who is
          // reachable now. Past agents are only worth listing when a thread
          // survives them; the rest cannot be opened at all.
          const agents = await conversations.agents();
          const live = agents.filter(agentIsLive);
          const past = agents
            .filter((agent) => !agentIsLive(agent) && agent.conversationId !== undefined)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
          if (!live.length && !past.length) {
            flow.renderLine(
              "No live agents and no saved agent threads. /sessions browses saved harness sessions.",
            );
            return;
          }
          const option = (agent: OperatorAgentPersona) => ({
            value: agent.personaId,
            label: agent.name,
            hint: `Herdr · ${agent.harness}${agent.role ? ` · ${agent.role}` : ""}${agentIsLive(agent) ? "" : " · offline"}`,
            description: agent.personaId,
          });
          let id = await flow.readSelect({
            message: live.length ? `Live agents (${live.length})` : "No live agents",
            options: [
              ...live.map(option),
              ...(past.length
                ? [
                    {
                      value: "past",
                      label: `Past agents (${past.length})…`,
                      hint: "offline, with a saved thread",
                    },
                  ]
                : []),
            ],
          });
          if (id === "past")
            id = await flow.readSelect({
              message: "Past agents",
              options: past.map(option),
              allowBack: true,
            });
          const agent = agents.find((entry) => entry.personaId === id);
          if (!agent) return;
          const selected = await conversations.openAgent(agent);
          shell.insertCommandResult("/agents", `Opened ${selected.title}.`, "success");
        } finally {
          flow.end();
        }
      },
    },
    {
      name: "sessions",
      aliases: [],
      description: "List or read Claude/Codex/Grok/Pi sessions here or on SSH hosts",
      takesArgument: true,
      argumentHint:
        "[list [--host ID]|read HOST:SESSION [--tail N]|send HOST:SESSION MESSAGE|runs [RUN]|cancel RUN|release RUN|hosts|hosts add ID --ssh TARGET [--shell powershell]|hosts remove ID]",
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "") {
          await runMachineConnectionsMenu(shell, connectionServices());
          return;
        }
        try {
          const result = await runAgentsCommand(argument.trim().split(/\s+/u).filter(Boolean));
          shell.insertCommandResult("/sessions", JSON.stringify(result, null, 2), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/sessions",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "access",
      aliases: [],
      description: "Inspect and revoke worker access to connected accounts",
      takesArgument: true,
      argumentHint: "[list | revoke ID | linear [verify]]",
      async run(argument, shell): Promise<void> {
        if (!argument.trim()) {
          await runAccessMenu(shell, (args) => runAccessCommand(args));
          return;
        }
        try {
          const args = argument.trim().split(/\s+/u).filter(Boolean);
          if (args[0] === "issue")
            throw new Error(
              "Issue from your terminal: clankie access issue REQUEST.json --out GRANT.json, or clankie access project NAME SERVER",
            );
          const result = await runAccessCommand(args);
          shell.insertCommandResult("/access", JSON.stringify(result, null, 2), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/access",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "herdr",
      aliases: [],
      description: "Use an existing Herdr session or create one for Clankie",
      takesArgument: true,
      argumentHint: "[status | open | create | disable | use NAME]",
      async run(argument, shell): Promise<void> {
        try {
          if (argument.trim() === "") {
            await showHerdrMenu(shell, context);
            return;
          }
          if (argument.trim() === "open") {
            if (!context.herdrOptions) throw new Error("Herdr connection is unavailable");
            const code = await shell.withTerminal(() => openHerdr(context.herdrOptions!));
            if (code !== 0) throw new Error(`Herdr viewer exited with status ${code}`);
            return;
          }
          const result = await runHerdrCommand(argument.trim().split(/\s+/u).filter(Boolean), {
            ...context.herdrOptions,
            ...(settings === undefined ? {} : { settings }),
          });
          shell.insertCommandResult(
            "/herdr",
            `${result.active ? `Active: ${describeHerdrBinding(result.active)}` : (result.unavailable ?? "")}\nApply changes with ${result.restart}`,
            "success",
          );
        } catch (error) {
          shell.insertCommandResult(
            "/herdr",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "help",
      aliases: ["h"],
      description: "Show available commands",
      takesArgument: false,
      availableInSideConversation: true,
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
          `${ansi.dim("ctrl+/ command workbench · ctrl+t transcript focus · ctrl+shift+v voice transcripts · ! shell escape · esc detach")}`,
        );
        shell.insertCommandResult("/help", lines.join("\n"), "success");
      },
    },
    ...[
      {
        name: "chats",
        aliases: ["chat", "conversation", "conversations"],
        description: "Talk with Clankie in personal and workspace chats",
        argumentHint: "[<name-or-path>]",
        takesArgument: true,
        title: "Chats",
        kinds: ["global", "workspace"],
      },
      {
        name: "rooms",
        aliases: [],
        description: "Group channels and Discord text or voice history",
        argumentHint: "[<name-or-path>]",
        takesArgument: true,
        title: "Rooms",
        kinds: ["channel", "room"],
      },
      {
        name: "history",
        aliases: [],
        description: "Browse all retained threads, including offline agents",
        argumentHint: "[<name-or-path>]",
        takesArgument: true,
        title: "History",
        kinds: [],
      },
    ].map(
      ({ name, aliases, title, description, kinds, argumentHint, takesArgument }): FaceShellCommand => ({
        name,
        aliases,
        description,
        argumentHint,
        takesArgument,
        async run(argument, shell): Promise<void> {
          if (conversations === undefined) {
            shell.insertCommandResult(`/${name}`, "Conversations are unavailable.", "error");
            return;
          }
          if (name === "chats" && argument.trim().startsWith("head ")) {
            const target = argument.trim().slice(5).trim();
            if (conversations.designateHead === undefined || !target || /\s/u.test(target))
              throw new Error("Use /conversation head HEAD_ID|none with operator authority");
            await conversations.designateHead(target === "none" ? null : target);
            shell.insertCommandResult(
              "/conversation head",
              target === "none" ? "Designated head cleared." : `Designated head: ${target}`,
              "success",
            );
            return;
          }
          const selector = argument.trim();
          if (selector.length === 0) {
            const flow = shell.setupFlow;
            flow.begin(name);
            try {
              flow.renderLine(
                "/chats · Clankie   /agents · directory   /rooms · shared spaces   /history · all threads",
              );
              for (;;) {
                const rows = (await conversations.conversations()).filter(
                  (item) => kinds.length === 0 || kinds.includes(item.scope.kind),
                );
                if (!rows.length) {
                  flow.renderLine(`No saved threads in ${title.toLowerCase()}.`);
                  return;
                }
                const currentConversationId = conversations.conversationId;
                let conversationIdToClose: string | undefined;
                const picked = await flow.readSelect({
                  message: title,
                  options: rows.map((item) => ({
                    value: item.conversationId,
                    label: item.title,
                    hint: conversationHint(item),
                    ...(item.scope.kind === "workspace" ? { description: item.scope.workspaceId } : {}),
                  })),
                  ...(currentConversationId === undefined ||
                  !rows.some((item) => item.conversationId === currentConversationId)
                    ? {}
                    : { currentValue: currentConversationId, initialValue: currentConversationId }),
                  ...(conversations.close === undefined
                    ? {}
                    : { onClose: (conversationId: string) => (conversationIdToClose = conversationId) }),
                });
                if (conversationIdToClose !== undefined && conversations.close !== undefined) {
                  const closing = rows.find((item) => item.conversationId === conversationIdToClose);
                  const closed = await conversations.close(conversationIdToClose);
                  if (!closed) {
                    flow.renderLine(
                      closing?.isDefault === true
                        ? "The default conversation stays available."
                        : closing?.sessionState === "active"
                          ? "That conversation is still active."
                          : "That conversation could not be closed.",
                      "warning",
                    );
                    continue;
                  }
                  if (conversationIdToClose === currentConversationId) {
                    const remaining = await conversations.conversations();
                    const fallback =
                      remaining.find((item) => item.isDefault && item.scope.kind === "global") ??
                      remaining[0];
                    if (fallback === undefined) throw new Error("No conversation remains after close");
                    await conversations.select(fallback.conversationId);
                  }
                  flow.renderLine(`Closed ${closing?.title ?? "conversation"}.`, "success");
                  continue;
                }
                const conversationId = picked;
                if (conversationId === undefined) return;
                const selected = await conversations.select(conversationId);
                shell.insertCommandResult(`/${name}`, `Switched to ${selected.title}.`, "success");
                return;
              }
            } finally {
              flow.end();
            }
          }
          const rows = (await conversations.conversations()).filter(
            (item) => kinds.length === 0 || kinds.includes(item.scope.kind),
          );
          const byId = rows.find((item) => item.conversationId === selector);
          const matches =
            byId === undefined
              ? rows.filter(
                  (item) =>
                    item.title.toLowerCase() === selector.toLowerCase() ||
                    (item.scope.kind === "workspace" && item.scope.workspaceId === selector) ||
                    (item.scope.kind === "room" &&
                      (item.scope.targetId === selector ||
                        item.scope.targetId.split(":").at(-1) === selector)),
                )
              : [byId];
          if (matches.length === 0) {
            shell.insertCommandResult(
              `/${name} ${selector}`,
              `No conversation matches ${selector}. Run /${name} to choose one; /history searches all retained threads.`,
              "error",
            );
            return;
          }
          if (matches.length > 1) {
            shell.insertCommandResult(
              `/${name} ${selector}`,
              `More than one thread is named ${selector}. Use its conversation ID to choose one.`,
              "error",
            );
            return;
          }
          const selected = await conversations.select(matches[0]!.conversationId);
          shell.insertCommandResult(`/${name} ${selector}`, `Switched to ${selected.title}.`, "success");
        },
      }),
    ),
    {
      name: "new",
      aliases: [],
      description: "Start a fresh conversation in the current workspace",
      argumentHint: "[<title>]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (conversations?.create === undefined) {
          shell.insertCommandResult("/new", "Conversations are unavailable.", "error");
          return;
        }
        const title = argument.trim() || undefined;
        const created = await conversations.create(title);
        shell.clearTranscript();
        shell.insertCommandResult(
          title === undefined ? "/new" : `/new ${title}`,
          `Started ${created.title} with fresh context.`,
          "success",
        );
      },
    },
    {
      name: "btw",
      aliases: ["side"],
      description: "Ask an ephemeral side question on a fork of the current context",
      argumentHint: "[<question>]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (conversations?.fork === undefined) {
          shell.insertCommandResult("/btw", "Side conversations are unavailable.", "error");
          return;
        }
        if (shell.sideConversationActive) {
          shell.insertCommandResult(
            "/btw",
            shell.sideConversationVisible
              ? "A side conversation is already open. Press ctrl+c to return before starting another."
              : "A side conversation is already open. Press ctrl+x to go back to it.",
            "error",
          );
          return;
        }
        await conversations.fork();
        await shell.detachActiveTurn();
        shell.beginSideConversation();
        shell.insertCommandResult(
          "/btw",
          "Side conversation · inherited history is reference only · ctrl+x to switch · ctrl+c to close.",
          "success",
        );
        const question = argument.trim();
        if (question.length > 0) await shell.submitUserPrompt(question);
      },
    },
    {
      name: "goal",
      aliases: [],
      description: "Show, accept, start, pause, resume, or clear this conversation's goal",
      argumentHint: "[accept|pause|resume|clear|--tokens <n> <objective>|<objective>]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (conversations?.autonomy === undefined) {
          shell.insertCommandResult("/goal", "Goals are unavailable.", "error");
          return;
        }
        const input = argument.trim();
        let command: OperatorAutonomyCommand;
        if (input.length === 0 || input === "status") command = { action: "status" };
        else if (input === "accept") command = { action: "accept_goal" };
        else if (input === "pause" || input === "resume") {
          command = { action: "set_goal_status", status: input === "pause" ? "paused" : "active" };
        } else if (input === "clear") command = { action: "clear_goal" };
        else {
          const budget = /^--tokens\s+(\d+)\s+([\s\S]+)$/u.exec(input);
          if (input.startsWith("--tokens") && budget === null) {
            shell.insertCommandResult(
              "/goal",
              "Usage: /goal [--tokens <positive integer>] <objective>",
              "error",
            );
            return;
          }
          command = {
            action: "set_goal",
            objective: budget?.[2]?.trim() ?? input,
            ...(budget === null ? {} : { tokenBudget: Number.parseInt(budget[1]!, 10) }),
          };
        }
        try {
          const status = await conversations.autonomy(command);
          shell.insertCommandResult(
            "/goal",
            formatAutonomyStatus(status),
            status.error === undefined ? "success" : "error",
          );
        } catch (error) {
          shell.insertCommandResult("/goal", error instanceof Error ? error.message : String(error), "error");
        }
      },
    },
    {
      name: "autonomy",
      aliases: [],
      description: "Show or switch Clankie's autonomous goal and wake runner",
      argumentHint: "[on|off|clear]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (conversations?.autonomy === undefined) {
          shell.insertCommandResult("/autonomy", "Autonomy controls are unavailable.", "error");
          return;
        }
        const input = argument.trim().toLowerCase();
        if (input === "") {
          const autonomy = conversations.autonomy;
          await runSettingsMenu(shell, "/autonomy", async () => {
            const status = await autonomy({ action: "status" });
            const [title, ...details] = formatAutonomyStatus(status).split("\n");
            return {
              title: `${title} · ${details.join(" · ")}`,
              actions: [
                {
                  value: "toggle",
                  label: status.enabled ? "Turn autonomy off" : "Turn autonomy on",
                  hint: "goal and wake runner",
                  async run() {
                    await autonomy({ action: "set_enabled", enabled: !status.enabled });
                    return `Autonomy ${onOff(!status.enabled)}.`;
                  },
                },
                ...(status.wake === undefined
                  ? []
                  : [
                      {
                        value: "clear",
                        label: "Clear the scheduled wake",
                        hint: status.wake.at,
                        async run() {
                          await autonomy({ action: "clear_wake" });
                          return "Wake cleared.";
                        },
                      },
                    ]),
              ],
            };
          });
          return;
        }
        const command: OperatorAutonomyCommand | undefined =
          input.length === 0 || input === "status"
            ? { action: "status" }
            : input === "on" || input === "off"
              ? { action: "set_enabled", enabled: input === "on" }
              : input === "clear"
                ? { action: "clear_wake" }
                : undefined;
        if (command === undefined) {
          shell.insertCommandResult("/autonomy", "Usage: /autonomy [on|off|clear]", "error");
          return;
        }
        try {
          const status = await conversations.autonomy(command);
          shell.insertCommandResult(
            "/autonomy",
            formatAutonomyStatus(status),
            status.error === undefined ? "success" : "error",
          );
        } catch (error) {
          shell.insertCommandResult(
            "/autonomy",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "cd",
      aliases: ["workspace"],
      description: "Work in another directory — opens that workspace's conversation",
      argumentHint: "[<path>]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const target = argument.trim();
        if (conversations?.open === undefined) {
          shell.insertCommandResult("/cd", "Conversations are unavailable.", "error");
          return;
        }
        if (target.length === 0) {
          shell.insertCommandResult("/cd", `Working in ${conversations.workspace ?? "unknown"}.`, "success");
          return;
        }
        const opened = await conversations.open(target);
        shell.insertCommandResult(
          `/cd ${target}`,
          `Switched to ${opened.title} · ${conversations.workspace ?? target}.`,
          "success",
        );
      },
    },
    {
      name: "trace",
      aliases: [],
      description: "Watch another lane's activity (Discord servers, voice, gameplay)",
      argumentHint: "[<lane>|<guild:channel>|all|off]",
      takesArgument: true,
      availableInSideConversation: true,
      async run(argument, shell): Promise<void> {
        const selector = argument.trim();
        const label = selector.length === 0 ? "/trace" : `/trace ${selector}`;
        if (laneTrace === undefined) {
          shell.insertCommandResult(label, "Clankie's lane listing is unavailable.", "error");
          return;
        }
        if (selector === "off") {
          const stopped = laneTrace.detachAll();
          shell.insertCommandResult(
            label,
            stopped === 0 ? "No lane was being traced." : `Stopped tracing ${String(stopped)} lane(s).`,
            "success",
          );
          return;
        }
        let lanes: readonly ObservableCaptainLane[];
        try {
          lanes = await laneTrace.lanes();
        } catch (error) {
          shell.insertCommandResult(label, error instanceof Error ? error.message : String(error), "error");
          return;
        }
        if (selector.length === 0 || selector === "status") {
          shell.insertCommandResult(label, formatLaneListing(lanes, laneTrace.watched), "success");
          return;
        }
        const selected = selectLanes(lanes, selector);
        if (selected.length === 0) {
          shell.insertCommandResult(
            label,
            `No lane matches ${selector}.\n\n${formatLaneListing(lanes, laneTrace.watched)}`,
            "error",
          );
          return;
        }
        const attached = selected.filter((lane) =>
          laneTrace.attach({ lane: lane.lane, targetId: lane.targetId }, shell),
        );
        shell.insertCommandResult(
          label,
          attached.length === 0
            ? "Already tracing every matching lane."
            : `Tracing ${attached.map((lane) => laneKey(lane)).join(", ")}. Use /trace off to stop.`,
          "success",
        );
      },
    },
    {
      name: "vt",
      aliases: ["voice-log", "voice-transcripts"],
      description: "Live tail of retained Discord voice transcripts",
      argumentHint: "[off]",
      takesArgument: true,
      availableInSideConversation: true,
      run(argument, shell): void {
        const selector = argument.trim().toLowerCase();
        const label = selector.length === 0 ? "/vt" : `/vt ${selector}`;
        if (selector === "off") {
          shell.closeVoiceTranscripts();
          shell.insertCommandResult(label, "Closed the voice transcript tail.", "success");
          return;
        }
        if (selector.length > 0 && selector !== "on") {
          shell.insertCommandResult(label, "Usage: /vt [off]", "error");
          return;
        }
        if (!shell.openVoiceTranscripts()) {
          shell.insertCommandResult(label, "Clankie's voice transcript listing is unavailable.", "error");
        }
      },
    },
    {
      name: "layout",
      aliases: ["header", "banner"],
      description: "Show or hide the Clankie header banner",
      argumentHint: "[status|header on|header off|header toggle]",
      takesArgument: true,
      availableInSideConversation: true,
      run(argument, shell): void {
        runLayoutCommand(shell, argument);
      },
    },
    {
      name: "accounts",
      aliases: [],
      description: "Register local Claude profiles and Codex accounts/headroom",
      argumentHint: "[codex|claude [list | add HOME --label LABEL | remove LABEL]]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const words = splitQuotedArguments(argument);
        if (words.length <= 1 && (words[0] === undefined || words[0] === "codex" || words[0] === "claude")) {
          const options = settings ? { settings } : {};
          await runAccountsMenu(
            shell,
            {
              claude: (args) => runClaudeAccountsCommand(args, options),
              codex: (args) => runCodexAccountsCommand(args, options),
            },
            words[0],
          );
          return;
        }
        if (!["codex", "claude"].includes(words[0] ?? ""))
          throw new Error("Use /accounts codex|claude [list | add HOME --label LABEL | remove LABEL]");
        const result = await (words[0] === "claude" ? runClaudeAccountsCommand : runCodexAccountsCommand)(
          words.slice(1),
          settings ? { settings } : {},
        );
        shell.insertCommandResult("/accounts", JSON.stringify(result, null, 2), "success");
      },
    },
    {
      name: "skills",
      aliases: [],
      description: "List the skills shipped with Clankie",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        if (!context.repoRoot) {
          shell.insertCommandResult("/skills", "The shipped skill catalog is unavailable.", "error");
          return;
        }
        const result = await runSkillsCommand([], { repoRoot: context.repoRoot });
        shell.insertCommandResult(
          "/skills",
          `${result.catalog.map((skill) => skill.name).join("\n")}\n\nEvery shipped skill is always on.`,
          "success",
        );
      },
    },
    {
      name: "desktop",
      aliases: [],
      description: "Set desktop quiet hours",
      argumentHint: "[status | quiet-hours START END TIME_ZONE | quiet-hours off]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (settings === undefined) {
          shell.insertCommandResult("/desktop", "Desktop settings are unavailable.", "error");
          return;
        }
        if (!argument.trim()) {
          await runSettingsMenu(shell, "/desktop", async () => {
            const hours = (await runDesktopCommand([], { settings })).desktop.quietHours;
            return {
              title: hours
                ? `Desktop · quiet ${hours.start}–${hours.end} (${hours.timeZone})`
                : "Desktop · no quiet hours",
              actions: [
                {
                  value: "set",
                  label: "Quiet hours…",
                  hint: hours ? `${hours.start}–${hours.end}` : "off",
                  async run(flow) {
                    const time = (message: string, current?: string) =>
                      flow.readText({
                        message,
                        placeholder: "HH:MM",
                        ...(current ? { defaultValue: current } : {}),
                        allowBack: true,
                        validate: (value) => (/^\d{2}:\d{2}$/u.test(value.trim()) ? undefined : "Use HH:MM."),
                      });
                    const start = await time("Quiet from", hours?.start ?? "22:00");
                    if (start === undefined) return undefined;
                    const end = await time("Quiet until", hours?.end ?? "08:00");
                    if (end === undefined) return undefined;
                    const zone = await flow.readText({
                      message: "Time zone",
                      defaultValue: hours?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
                      allowBack: true,
                    });
                    if (zone === undefined) return undefined;
                    await runDesktopCommand(["quiet-hours", start.trim(), end.trim(), zone.trim()], {
                      settings,
                    });
                    return `Quiet ${start.trim()}–${end.trim()}.`;
                  },
                },
                ...(hours
                  ? [
                      {
                        value: "off",
                        label: "Turn quiet hours off",
                        async run() {
                          await runDesktopCommand(["quiet-hours", "off"], { settings });
                          return "Quiet hours off.";
                        },
                      },
                    ]
                  : []),
              ],
            };
          });
          return;
        }
        try {
          const result = await runDesktopCommand(argument.trim().split(/\s+/u).filter(Boolean), { settings });
          const hours = result.desktop.quietHours;
          shell.insertCommandResult(
            "/desktop",
            hours === undefined
              ? "Desktop quiet hours are off."
              : `Desktop quiet hours: ${hours.start}–${hours.end} (${hours.timeZone}).`,
            "success",
          );
        } catch (error) {
          shell.insertCommandResult(
            "/desktop",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    shareConsoleCommand(async (args) =>
      runShareCommand(
        args,
        (await settings?.load())?.client?.mode === "hosted"
          ? { request: (await hostedTransportFor(process.env)).request }
          : {},
      ),
    ),
    {
      name: "games",
      aliases: ["gameplay"],
      description: "Configure Clankie's PokeAgent play",
      argumentHint: "[on|off]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (settings === undefined) {
          shell.insertCommandResult("/games", "Gameplay settings are unavailable.", "error");
          return;
        }
        const words = argument.trim().toLowerCase().split(/\s+/u).filter(Boolean);
        if (words.length === 0) {
          await runGameplayWizard(shell, settings);
          return;
        }
        if (words.length === 1 && words[0] === "status") {
          const result = await gamesStatus({ settings });
          shell.insertCommandResult("/games", formatGameplaySettings(result.games), "success");
          return;
        }
        const [state] = words;
        if ((state !== "on" && state !== "off") || words.length !== 1) {
          shell.insertCommandResult("/games", "Usage: /games [on|off]", "error");
          return;
        }
        const next = await gamesSet(state === "on", { settings });
        shell.insertCommandResult(
          "/games",
          `${formatGameplaySettings(next.games)}\n\nRestart Clankie to apply this change.`,
          "success",
        );
      },
    },
    {
      name: "browser",
      aliases: [],
      description: "Recording, and the computer-use harnesses he can hire",
      argumentHint: "[record on|off | delegate on|off | harnesses]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (settings === undefined) {
          shell.insertCommandResult("/browser", "Browser settings are unavailable.", "error");
          return;
        }
        const words = argument.trim().toLowerCase().split(/\s+/u).filter(Boolean);
        if (words.length === 0) {
          await runSettingsMenu(shell, "/browser", async () => {
            const { browser } = await browserStatus({ settings });
            return {
              title: "Browser",
              actions: [
                {
                  value: "record",
                  label: "Record browsing",
                  hint: `${onOff(browser.recordSessions)} · newest 50 kept`,
                  async run() {
                    await browserSetRecording(!browser.recordSessions, { settings });
                    return `Recording ${onOff(!browser.recordSessions)}; applies from his next burst of browsing.`;
                  },
                },
                {
                  value: "delegate",
                  label: "Offer computer-use harnesses",
                  hint: browser.harnessDelegation ? "offered" : "off",
                  async run() {
                    await browserSetDelegation(!browser.harnessDelegation, { settings });
                    return `Harnesses ${browser.harnessDelegation ? "off" : "offered"}; applies from his next session.`;
                  },
                },
                {
                  value: "harnesses",
                  label: "Which harnesses are ready",
                  async run() {
                    shell.insertCommandResult(
                      "/browser harnesses",
                      formatBrowserHarnesses(await browserHarnesses({ settings })),
                      "success",
                    );
                    return undefined;
                  },
                },
              ],
            };
          });
          return;
        }
        if (words.length === 1 && words[0] === "status") {
          const result = await browserStatus({ settings });
          shell.insertCommandResult("/browser", formatBrowserSettings(result.browser), "success");
          return;
        }
        if (words.length === 1 && words[0] === "harnesses") {
          try {
            const result = await browserHarnesses({ settings });
            shell.insertCommandResult("/browser", formatBrowserHarnesses(result), "success");
          } catch (error) {
            shell.insertCommandResult(
              "/browser",
              error instanceof Error ? error.message : String(error),
              "error",
            );
          }
          return;
        }
        if (
          words.length !== 2 ||
          (words[0] !== "record" && words[0] !== "delegate") ||
          (words[1] !== "on" && words[1] !== "off")
        ) {
          shell.insertCommandResult(
            "/browser",
            "Usage: /browser [record on|off | delegate on|off | harnesses]",
            "error",
          );
          return;
        }
        if (words[0] === "delegate") {
          const next = await browserSetDelegation(words[1] === "on", { settings });
          shell.insertCommandResult(
            "/browser",
            `${formatBrowserSettings(next.browser)}\n\nApplies from his next session.`,
            "success",
          );
          return;
        }
        const next = await browserSetRecording(words[1] === "on", { settings });
        shell.insertCommandResult(
          "/browser",
          `${formatBrowserSettings(next.browser)}\n\nApplies from his next burst of browsing.`,
          "success",
        );
      },
    },
    {
      name: "rivals",
      aliases: [],
      description: "Connect, play, observe, and share Spider-Man",
      argumentHint: "[status|connect URL|start MODE|objective|observe|share|stop]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const options = settings === undefined ? {} : { settings };
        if (!argument.trim()) {
          await runRivalsMenu(shell, (args) => runRivalsCommand(args, options));
          return;
        }
        try {
          const result = await runRivalsCommand(argument.trim().split(/\s+/u).filter(Boolean), options);
          shell.insertCommandResult(
            "/rivals",
            formatRivals(result),
            result.outcome === "refused" ? "error" : "success",
          );
        } catch (error) {
          shell.insertCommandResult(
            "/rivals",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "minecraft",
      aliases: [],
      description: "Host, invite, administer, configure, and play in Minecraft",
      argumentHint:
        "[configure play --model PROVIDER/MODEL --max-cost-usd N|driver|configure|status|join PROFILE|leave|cancel|pause|resume|chat|follow]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const options = {
          ...(settings === undefined ? {} : { settings }),
          ...(conversations?.conversationId === undefined
            ? {}
            : { conversationId: conversations.conversationId }),
        };
        if (!argument.trim()) {
          await runMinecraftMenu(shell, (args) => runMinecraftCommand(args, options));
          return;
        }
        try {
          if (argument.trim() === "driver") {
            await runMinecraftDriverMenu(shell, options);
            return;
          }
          const result = await runMinecraftCommand(argument.trim().split(/\s+/u).filter(Boolean), options);
          shell.insertCommandResult("/minecraft", JSON.stringify(result, null, 2), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/minecraft",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "reset",
      aliases: [],
      description: "Archive this conversation and start with fresh model context",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        if (conversations?.reset === undefined) throw new Error("Conversation reset is unavailable");
        const result = await conversations.reset();
        shell.insertCommandResult(
          "/reset",
          `Started fresh context. Previous session archived as ${result.archiveId}.`,
          "success",
        );
      },
    },
    {
      name: "clear",
      aliases: [],
      description: "Clear the screen (keeps model context)",
      takesArgument: false,
      run(_argument, shell): void {
        shell.clearTranscript();
        shell.refreshStatus("ready");
      },
    },
    {
      name: "cancel",
      aliases: [],
      description: "Abort the setup flow or sign-in that is waiting",
      takesArgument: false,
      run(_argument, shell): void {
        // The flows print "(/cancel to abort)", so the token has to resolve
        // here too: the shell's fast path handles it mid-flow, and this entry
        // is what puts it in /help and the typeahead and answers when idle.
        if (shell.setupFlow.isWaitingForInput()) {
          shell.setupFlow.handleSubmit("/cancel");
          return;
        }
        shell.insertCommandResult("/cancel", "Nothing to cancel.", "error");
      },
    },
    {
      name: "activity",
      aliases: ["watch"],
      description: "Show Clankie's current activity and live watch surface",
      takesArgument: false,
      availableInSideConversation: true,
      async run(_argument, shell): Promise<void> {
        if (activityClient === undefined) {
          shell.insertCommandResult(
            "/activity",
            "Activity observation is unavailable until operator authentication is configured.",
            "error",
          );
          return;
        }
        try {
          const observation = await activityClient.getCurrentActivityObservation();
          shell.insertCommandResult(
            "/activity",
            formatActivityObservation(
              observation,
              activityWatchUrl === undefined ? {} : { watchUrl: activityWatchUrl },
            ),
            "success",
          );
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "Error";
          shell.insertCommandResult(
            "/activity",
            `Activity observation is temporarily unavailable (${errorName}).`,
            "error",
          );
        }
      },
    },
    {
      name: "board",
      aliases: ["herdr-lead", "herd-lead"],
      description: "Open, focus, or close the herdr-lead companion board",
      argumentHint: "[focus|close]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const token = argument.trim().toLowerCase();
        const verb = token === "focus" || token === "close" ? token : "open";
        const result =
          verb === "focus" ? await focusBoard() : verb === "close" ? await closeBoard() : await openBoard();
        const formatted = formatHerdLeadCompanionResult(result, verb);
        shell.insertCommandResult("/board", formatted.text, formatted.tone);
      },
    },
    {
      name: "jump",
      aliases: ["go"],
      description: "Focus a herdr agent by pane id or name (or click one he wrote)",
      argumentHint: "<pane|agent>",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const target = argument.trim();
        if (target.length === 0) {
          const roster = herdrRoster?.();
          const known = (roster?.agents ?? []).map((agent) => `${agent.paneId} ${agent.agent}`).join(" · ");
          shell.insertCommandResult(
            "/jump",
            known.length === 0 ? "Name a pane id or agent, such as `/jump w18:p1`." : `Pick one: ${known}`,
            "error",
          );
          return;
        }
        const formatted = formatHerdrJumpResult(await shell.focusHerdrAgent(target));
        shell.insertCommandResult(`/jump ${target}`, formatted.text, formatted.tone);
      },
    },
    {
      name: "status",
      aliases: [],
      description: "Show console and clankie service status",
      takesArgument: false,
      availableInSideConversation: true,
      async run(_argument, shell): Promise<void> {
        const s = statusHelpers(shell);
        await context.refreshHerdrBinding?.();
        const binding = context.herdrBinding?.();
        const snapshot = presence?.();
        const currentContextUsage = contextUsage?.();
        const roster = herdrRoster?.();
        const launcher = await context.commandStatus?.();
        shell.insertCommandResult(
          "/status",
          [
            ...(launcher === undefined
              ? []
              : [
                  s.title("Launcher"),
                  s.line("status", launcher.status, launcher.ok ? "ok" : "bad"),
                  s.line(
                    "runtime",
                    launcher.runtimeHealth ? formatRuntimeHealth(launcher.runtimeHealth) : "unknown",
                    launcher.runtimeHealth?.state === "alarm"
                      ? "bad"
                      : launcher.runtimeHealth
                        ? "normal"
                        : "warn",
                  ),
                  s.line(
                    "Clankie",
                    launcher.presence?.detail ?? "Unreachable",
                    launcher.presence === undefined ? "warn" : "ok",
                  ),
                  ...(launcher.presence === undefined
                    ? []
                    : [
                        s.line("agents", String(launcher.presence.activeSeats), "normal"),
                        ...(launcher.presence.pendingOwnerItem === undefined
                          ? []
                          : [s.line("waiting for you", launcher.presence.pendingOwnerItem.title, "warn")]),
                      ]),
                  s.line(
                    "operator credential",
                    `${launcher.operatorCredential.source} · ${launcher.operatorCredential.consistency}`,
                    launcher.operatorCredential.present &&
                      launcher.operatorCredential.consistency !== "mismatch"
                      ? "ok"
                      : "bad",
                  ),
                  ...launcher.services.map((service) =>
                    s.line(
                      service.id,
                      `${service.state}${service.detail === undefined ? "" : ` · ${service.detail}`}`,
                      service.state === "healthy" ? "ok" : "warn",
                    ),
                  ),
                  "",
                ]),
            s.title("Console"),
            s.line("discord", snapshot?.phase ?? "unavailable", snapshot === undefined ? "warn" : "ok"),
            s.line(
              "herdr",
              binding === undefined ? "unavailable" : describeHerdrBinding(binding),
              binding === undefined ? "warn" : "ok",
            ),
            s.line("conversation", conversations?.title ?? "none selected", "active"),
            s.line("workspace", conversations?.workspace ?? "unknown", "normal"),
            s.line(
              "context",
              formatCaptainContextUsage(currentContextUsage),
              currentContextUsage === undefined ? "warn" : "normal",
            ),
            s.line(
              "activity",
              activityClient === undefined ? "authentication unavailable" : "live · /activity",
              activityClient === undefined ? "warn" : "ok",
            ),
            ...(roster === undefined
              ? []
              : [
                  ...(roster.resources === undefined
                    ? []
                    : [
                        s.line(
                          "heavy slots",
                          `${roster.resources.capacity.used}/${roster.resources.capacity.heavySlots} · ${roster.resources.queue.length} waiting`,
                          roster.resources.pressure.healthy ? "normal" : "warn",
                        ),
                        ...roster.resources.leases.map((lease) =>
                          s.line(
                            "resource holder",
                            `${lease.seatId ?? (lease.pid === undefined ? "unidentified" : `pid ${lease.pid}`)} · ${lease.kind} · ${lease.executable ?? lease.deviceId ?? lease.state}`,
                            "normal",
                          ),
                        ),
                      ]),
                  s.line(
                    "herdr workers",
                    roster.error === undefined
                      ? roster.agents.length === 0
                        ? "none"
                        : roster.agents
                            .map((agent) => `${agent.agent} ${agent.status} (${agent.paneId})`)
                            .join(" · ")
                      : `roster error: ${roster.error}`,
                    roster.error === undefined ? "normal" : "warn",
                  ),
                ]),
          ].join("\n"),
          "success",
        );
      },
    },
    {
      name: "awake",
      aliases: [],
      description: "Keep this Mac awake while plugged in, so Discord and the app stay reachable",
      argumentHint: "[on|off]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (context.commandAwake === undefined) {
          shell.insertCommandResult("/awake", "Keep-awake is unavailable.", "error");
          return;
        }
        const words = argument.trim().toLowerCase().split(/\s+/u).filter(Boolean);
        if (words.length > 1 || (words[0] !== undefined && !["status", "on", "off"].includes(words[0]))) {
          shell.insertCommandResult("/awake", "Usage: /awake [on|off]", "error");
          return;
        }
        if (!words.length) {
          const awake = context.commandAwake;
          await runSettingsMenu(shell, "/awake", async () => {
            const result = await awake([]);
            const [title, power] = formatAwake(result).split("\n");
            return {
              title: `${title} · ${power}`,
              actions: [
                {
                  value: "toggle",
                  label: result.keepAwake ? "Let this Mac sleep" : "Keep this Mac awake",
                  hint: "while plugged in",
                  async run() {
                    return formatAwake(await awake([result.keepAwake ? "off" : "on"])).split("\n")[0];
                  },
                },
              ],
            };
          });
          return;
        }
        try {
          const result = await context.commandAwake(words);
          shell.insertCommandResult("/awake", formatAwake(result), "success");
        } catch (error) {
          shell.insertCommandResult(
            "/awake",
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    },
    {
      name: "runtime-health",
      aliases: [],
      description: "Runtime CPU and slow-health alarms, thresholds, and cooldown",
      argumentHint: "[status|on|off|set --cpu-percent N …]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const command = context.commandRuntimeHealth;
        if (!command) {
          shell.insertCommandResult("/runtime-health", "Runtime health unavailable.", "error");
          return;
        }
        const words = argument.trim().split(/\s+/u).filter(Boolean);
        if (words.length) {
          try {
            shell.insertCommandResult(
              "/runtime-health",
              formatRuntimeHealth((await command(words)).observation),
              "success",
            );
          } catch (error) {
            shell.insertCommandResult(
              "/runtime-health",
              error instanceof Error ? error.message : String(error),
              "error",
            );
          }
          return;
        }
        await runSettingsMenu(shell, "/runtime-health", async () => {
          const result = await command([]);
          const fields = [
            ["cpuPercent", "CPU threshold (%)", "--cpu-percent", 1],
            ["healthLatencyMs", "Health latency threshold (ms)", "--health-ms", 1],
            ["sustainedMs", "Sustained duration (seconds)", "--sustained-seconds", 1000],
            ["sampleIntervalMs", "Sample interval (seconds)", "--sample-seconds", 1000],
            ["cooldownMs", "Alert cooldown (seconds)", "--cooldown-seconds", 1000],
          ] as const;
          return {
            title: `${formatRuntimeHealth(result.observation)} · alarms ${result.settings.enabled ? "on" : "off"}`,
            actions: [
              {
                value: "toggle",
                label: result.settings.enabled ? "Disable alarms" : "Enable alarms",
                async run() {
                  await command([result.settings.enabled ? "off" : "on"]);
                  return "Runtime health setting saved; applies on the next sample.";
                },
              },
              ...fields.map(([field, label, flag, multiplier]) => ({
                value: field,
                label,
                hint: String(result.settings[field] / multiplier),
                async run(flow: import("./shell/setup-flow.ts").SetupFlow) {
                  const value = await flow.readText({
                    message: label,
                    defaultValue: String(result.settings[field] / multiplier),
                    allowBack: true,
                    validate: (value) => {
                      try {
                        parseRuntimeHealthArgs(["set", flag, value.trim()]);
                        return undefined;
                      } catch {
                        return "Enter a value within the supported range.";
                      }
                    },
                  });
                  if (value === undefined) return undefined;
                  await command(["set", flag, value.trim()]);
                  return "Runtime health setting saved; applies on the next sample.";
                },
              })),
            ],
          };
        });
      },
    },
    {
      name: "doctor",
      aliases: [],
      description: "Show this install's canonical doctor report",
      argumentHint: "[json]",
      takesArgument: true,
      availableInSideConversation: true,
      async run(argument, shell): Promise<void> {
        if (context.commandDoctor === undefined) {
          shell.insertCommandResult("/doctor", "Install doctor is unavailable.", "error");
          return;
        }
        const report = await context.commandDoctor();
        shell.insertCommandResult(
          "/doctor",
          argument.trim() === "json" ? JSON.stringify(report, null, 2) : formatDoctorReport(report),
          report.captain.ready && report.remediations.length === 0 ? "success" : "error",
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

/** What kind of room a row is, so a seat thread and a channel do not read as global. */
function conversationHint(conversation: {
  readonly scope: OperatorConversationScope;
  readonly isDefault: boolean;
}): string {
  switch (conversation.scope.kind) {
    case "room":
      return `${conversation.scope.lane === "discord_voice" ? "voice" : "Discord"} · read-only`;
    case "workspace":
      return "workspace";
    case "seat":
      return "agent thread · legacy";
    case "persona":
      return "agent thread · availability in /agents";
    case "channel":
      return "channel";
    case "global":
      // The default global room is the head (ADR 0152) — the same thread the
      // app pins as Clankie. Name it that here too, so one room does not read
      // as two things depending on which face you opened.
      return conversation.isDefault ? "Clankie" : "personal chat";
  }
}

function formatAutonomyStatus(status: OperatorAutonomyStatus): string {
  const goal = status.goal;
  const wake = status.wake;
  return [
    `Autonomy: ${status.enabled ? "on" : "off"}`,
    ...(status.error === undefined ? [] : ["State: unreadable · autonomy is fail-closed"]),
    goal === undefined ? "Goal: none" : `Goal: ${goal.status} · ${goal.objective}`,
    ...(goal?.status === "proposed" ? ["Confirm: /goal accept"] : []),
    ...(goal?.tokenBudget === undefined
      ? []
      : [`Budget: ${String(goal.tokensUsed)} / ${String(goal.tokenBudget)} tokens`]),
    wake === undefined ? "Wake: none" : `Wake: ${wake.at} · ${wake.reason}`,
  ].join("\n");
}

function formatBrowserSettings(settings: BrowserSettings): string {
  return [
    `Record browsing: ${settings.recordSessions ? "on" : "off"}`,
    "Videos: ~/.clankie/runner/browser/recordings/ (newest 50)",
    `Computer-use harnesses: ${settings.harnessDelegation ? "offered" : "off"} (/browser harnesses lists them)`,
  ].join("\n");
}

function formatBrowserHarnesses(result: BrowserHarnessesResult): string {
  if (!result.detected)
    return "This body has no owner desktop, so no harness is offered; his own browser is the path.";
  if (result.harnesses.length === 0) return "No Codex or Claude install here; his own browser is the path.";
  const lines = result.harnesses.map((entry) => {
    const ready = entry.signedIn && entry.surfaces.length > 0;
    const detail = ready
      ? `${entry.surfaces.join(", ")}${entry.chromeNeedsHireFlag ? " (hired with --chrome)" : ""}`
      : (entry.missing ?? "not ready");
    return `${ready ? "✓" : "·"} ${entry.machineId === undefined ? "" : `${entry.machineId}/`}${entry.harness}${entry.platform === "win32" ? " (Windows; input unproven)" : ""}: ${detail}`;
  });
  return [
    ...lines,
    "",
    `Offered to him: ${result.harnessDelegation ? "yes" : "no (/browser delegate on)"}`,
  ].join("\n");
}

function formatGameplaySettings(settings: GameplaySettings): string {
  return `PokeAgent MMO: ${settings.pokeagentMmoEnabled ? "enabled" : "disabled"}`;
}

/** Reachable now: a live Herdr seat. */
function agentIsLive(agent: OperatorAgentPersona): boolean {
  return agent.activeSeatId !== undefined;
}

/** `/evaluator` with no arguments: the same controls as the CLI, as a menu. */
async function runEvaluatorMenu(shell: ClankieFaceShell): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("evaluator");
  try {
    let result = await runEvaluatorCommand([]);
    while (result.ok) {
      const status: EvaluatorStatus = result.evaluator;
      const failed = status.jobs.filter((job) => job.status === "failed").slice(0, 5);
      const selected = await flow.readSelect({
        message: [
          `Evaluator: ${status.enabled ? "on" : "off"} · ${status.harness} · ${status.queued} queued`,
          ...(status.error === undefined ? [] : [`Attention: ${status.error}`]),
        ].join("\n"),
        options: [
          {
            value: "toggle",
            label: `${status.enabled ? "✓" : "○"} Independent evaluator`,
            hint: status.enabled ? "on" : "off",
            description: "Assesses finished tasks from a Herdr pane.",
          },
          {
            value: "harness",
            label: `Harness: ${status.harness}`,
            hint: status.enabled ? "switch" : "switch and turn on",
            description: "Which agent runs the assessments.",
          },
          ...(status.paneId === undefined
            ? []
            : [{ value: "open", label: "Open evaluator pane", hint: status.paneId }]),
          { value: "report", label: "Show recent assessments", hint: `${status.jobs.length} jobs` },
          ...failed.map((job) => ({
            value: `retry:${job.id}`,
            label: `Retry ${job.taskId}`,
            hint: "failed",
            ...(job.error === undefined ? {} : { description: job.error }),
          })),
        ],
        statusActions: [{ value: "done", label: "Done" }],
        initialValue: "toggle",
      });
      if (selected === undefined || selected === "done") break;
      if (selected === "report") {
        flow.renderLine(formatEvaluatorStatus(status));
        continue;
      }
      let args: string[];
      if (selected === "toggle") args = [status.enabled ? "disable" : "enable"];
      else if (selected === "open") args = ["open"];
      else if (selected.startsWith("retry:")) args = ["retry", selected.slice("retry:".length)];
      else {
        const harness = await flow.readSelect({
          message: "Evaluator harness",
          options: [
            { value: "codex", label: "Codex" },
            { value: "claude", label: "Claude Code" },
          ],
          currentValue: status.harness,
          initialValue: status.harness,
          allowBack: true,
        });
        if (harness === undefined) continue;
        args = ["enable", "--harness", harness];
      }
      result = await runEvaluatorCommand(args);
      if (result.ok) flow.renderLine(`Evaluator: ${args.join(" ")} done.`, "success");
    }
    if (!result.ok) flow.renderLine(result.error, "error");
  } finally {
    flow.end();
  }
}

async function runGameplayWizard(shell: ClankieFaceShell, settings: SettingsStore): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("games");
  try {
    for (;;) {
      const gameplay = (await settings.load()).gameplay;
      const selected = await flow.readSelect({
        message: "Toggle PokeAgent play\nEnter toggles availability.",
        options: [
          {
            value: "mmo",
            label: `${gameplay.pokeagentMmoEnabled ? "✓" : "○"} PokeAgent MMO`,
            hint: gameplay.pokeagentMmoEnabled ? "enabled" : "disabled",
            description: "FireRed or Emerald in the hosted multiplayer world.",
          },
          {
            value: "tokens",
            label: "Pokémon token cap",
            hint: String(gameplay.pokemonBudget?.maxTokens ?? DEFAULT_POKEMON_PLAY_MAX_TOKENS),
          },
          {
            value: "cost",
            label: "Pokémon cost cap (USD)",
            hint: String(gameplay.pokemonBudget?.maxCostUsd ?? "off"),
          },
        ],
        statusActions: [{ value: "done", label: "Done", hint: "restart Clankie to apply changes" }],
        initialValue: "mmo",
      });
      if (selected === "tokens" || selected === "cost") {
        const key = selected === "tokens" ? "maxTokens" : "maxCostUsd";
        const value = await flow.readText({
          message:
            selected === "tokens"
              ? "Tokens per Pokémon session (default restores 250000)"
              : "USD per Pokémon session (default removes cost cap)",
          defaultValue: String(
            gameplay.pokemonBudget?.[key] ??
              (selected === "tokens" ? DEFAULT_POKEMON_PLAY_MAX_TOKENS : "default"),
          ),
          allowBack: true,
          validate: (text) =>
            text === "default" ||
            (Number.isFinite(Number(text)) &&
              Number(text) > 0 &&
              (selected === "cost" || Number.isSafeInteger(Number(text))))
              ? undefined
              : "Use a positive number or default.",
        });
        if (value !== undefined) {
          await gamesBudgetSet(key, value === "default" ? undefined : Number(value), { settings });
          flow.renderLine("Pokémon budget updated.", "success");
        }
        continue;
      }
      if (selected !== "mmo") break;
      const enabled = !gameplay.pokeagentMmoEnabled;
      await gamesSet(enabled, { settings });
      flow.renderLine(`PokeAgent MMO ${enabled ? "enabled" : "disabled"}.`, "success");
    }
  } finally {
    flow.end();
  }
}

function runLayoutCommand(shell: ClankieFaceShell, argument: string): void {
  const { ansi } = shell.theme;
  const normalized = argument.trim().toLowerCase();
  const words = normalized.split(/\s+/u).filter((word) => word.length > 0);

  if (normalized.length === 0 || normalized === "status") {
    shell.insertCommandResult(
      "/layout",
      [
        `${ansi.bold(ansi.cyan("Layout"))}`,
        `${ansi.dim("header:")} ${shell.headerVisible ? ansi.green("on") : ansi.dim("off")}`,
        ansi.dim("Usage: /layout [status|header on|off|toggle]"),
      ].join("\n"),
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

  shell.insertCommandResult("/layout", "Usage: /layout [status|header on|off|toggle]", "error");
}

async function showHerdrMenu(shell: ClankieFaceShell, context: ConsoleCommandContext): Promise<void> {
  const flow = shell.setupFlow;
  const options = { ...context.herdrOptions, ...(context.settings ? { settings: context.settings } : {}) };
  let ended = false;
  flow.begin("herdr");
  try {
    const current = await runHerdrCommand(["status"], options);
    flow.renderLine(
      `Selected: ${current.herdr.runtime === "disabled" ? "No worker workspace" : current.herdr.runtime === "bundled" ? "Clankie’s own session" : current.herdr.runtime === "auto" ? "Use the saved connection, or Clankie’s own session" : current.herdr.session}`,
    );
    flow.renderLine(herdrActiveLine(current));
    flow.renderLine(
      "Clankie’s own session follows official Herdr releases. Updates apply when the session next starts.",
    );
    const action = await flow.readSelect({
      message: "Herdr",
      options: [
        {
          value: "create",
          label: "Keep his own workspace (recommended)",
          hint: "His own workers, separate from your other sessions",
        },
        {
          value: "session",
          label: "Lead your Herdr session",
          hint: "He can see and message every pane in it",
        },
        {
          value: "disable",
          label: "Run without Herdr",
          hint: "Keep conversations; no worker workspace",
        },
        { value: "open", label: "Open active session" },
        ...(context.restartCaptain
          ? [{ value: "restart", label: "Apply saved changes", hint: "Restart Clankie, relay and Discord" }]
          : []),
      ],
      allowBack: true,
    });
    if (action === undefined) return;
    if (action === "open") {
      if (!context.herdrOptions) throw new Error("Herdr connection is unavailable");
      flow.end();
      ended = true;
      const code = await shell.withTerminal(() => openHerdr(context.herdrOptions!));
      if (code !== 0) throw new Error(`Herdr viewer exited with status ${code}`);
      return;
    }
    if (action === "create" || action === "disable") await runHerdrCommand([action], options);
    if (action === "session") {
      const sessions = [...((await context.herdrSessions?.()) ?? [])].sort(
        (left, right) => Number(right.running) - Number(left.running),
      );
      if (sessions.length === 0) {
        flow.renderLine("No Herdr sessions found. Start one with `herdr --session NAME`.", "warning");
        return;
      }
      const session = await flow.readSelect({
        message: "Herdr session",
        options: sessions.map((entry) => ({
          value: entry.name,
          label: entry.name,
          hint: entry.running ? "running" : "stopped",
        })),
        allowBack: true,
      });
      if (session === undefined) return;
      await runHerdrCommand(["use", session], options);
    }
    if (action !== "restart") {
      flow.renderLine("Saved. Restart to apply the workspace choice.", "success");
      if (!context.restartCaptain) return;
      const apply = await flow.readSelect({
        message: "Apply Herdr changes?",
        options: [
          {
            value: "restart",
            label: "Restart now",
            hint: "Clankie, relay and Discord; Herdr panes stay open",
          },
          { value: "later", label: "Later" },
        ],
        allowBack: true,
      });
      if (apply !== "restart") return;
    }
    flow.setStatus("Restarting Clankie…");
    await context.restartCaptain?.();
    await context.refreshHerdrBinding?.();
    // Report active capability separately from saved intent.
    const applied = await runHerdrCommand(["status"], options);
    const missed =
      applied.herdr.runtime === "external" &&
      applied.active !== undefined &&
      (applied.active.runtime !== "external" || applied.active.session !== applied.herdr.session);
    flow.renderLine(
      missed
        ? `${herdrActiveLine(applied)} (${applied.herdr.session} did not answer)`
        : herdrActiveLine(applied),
      applied.active === undefined || missed ? "warning" : "success",
    );
  } finally {
    if (!ended) flow.end();
  }
}

function herdrActiveLine(status: HerdrCommandResult): string {
  return status.herdr.runtime === "disabled" && status.active === undefined
    ? "Herdr disabled in settings; restart to apply any pending change"
    : status.active
      ? `Active: ${describeHerdrBinding(status.active)}`
      : (status.unavailable ?? "Active session unavailable");
}

function formatAwake(result: AwakeCommandResult): string {
  const { power } = result;
  const lines = [
    `keep-awake: ${result.keepAwake ? "on" : "off"} · ${result.service.state}${result.service.detail === undefined ? "" : ` · ${result.service.detail}`}`,
    `power: ${power.state.replace("_", " ")} · ${power.source}${power.sleepAfterMinutes === null ? "" : power.sleepAfterMinutes === 0 ? " · never sleeps" : ` · sleeps after ${String(power.sleepAfterMinutes)} min`}`,
  ];
  if (power.heldAwakeBy.length > 0) lines.push(`held awake by: ${power.heldAwakeBy.join(", ")}`);
  if (power.advice !== undefined) lines.push(power.advice);
  lines.push(result.note);
  return lines.join("\n");
}
