/**
 * The operator console's slash commands. Display fields feed the ported
 * typeahead / Ctrl+/ workbench / autocomplete; `run` handlers speak to the
 * shell API and the clankie service. Results land as compact command transcript
 * blocks; configurators run as guided SetupFlow wizards.
 */
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";
import type { GameplaySettings, SettingsStore } from "@clankie/settings";
import { formatActivityObservation, type ActivityObservationClient } from "./activity-command.ts";
import {
  formatLaneListing,
  laneKey,
  selectLanes,
  type CaptainLaneTraceController,
} from "./session/lane-observation.ts";
import type {
  ObservableCaptainLane,
  OperatorAutonomyCommand,
  OperatorAutonomyStatus,
  OperatorConversationContextUsage,
  OperatorConversationSessionState,
  OperatorConversationScope,
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
import { formatCaptainContextUsage } from "./shell/footer.ts";
import { formatHerdrJumpResult, jumpToHerdrAgent } from "./session/herdr-report.ts";

type StatusTone = "normal" | "active" | "ok" | "warn" | "bad" | "muted";

export interface ConsoleCommandContext {
  readonly settings?: SettingsStore;
  readonly activityClient?: ActivityObservationClient;
  readonly activityWatchUrl?: string;
  /** Read-only tails onto the lanes the operator is not talking in (ADR 0083). */
  readonly laneTrace?: CaptainLaneTraceController;
  /** Latest polled presence snapshot for /status. */
  readonly presence?: () => PresenceSnapshot | undefined;
  /** Latest durable context occupancy for the selected conversation. */
  readonly contextUsage?: () => OperatorConversationContextUsage | undefined;
  /** Sibling Herdr pane agents, when running inside Herdr. */
  readonly herdrRoster?: () => HerdrRosterSnapshot | undefined;
  /** herdr-lead board: companion dashboard beside this console. */
  readonly herdLead?: {
    ensure(): Promise<HerdLeadCompanionResult>;
    focus(): Promise<HerdLeadCompanionResult>;
    close(): Promise<HerdLeadCompanionResult>;
  };
  readonly conversations?: {
    readonly conversationId?: string | undefined;
    readonly title?: string | undefined;
    /** Directory the selected conversation's session works in. */
    readonly workspace?: string;
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
    select(conversationId: string): Promise<{ readonly conversationId: string; readonly title: string }>;
    /** Forks and selects an ephemeral Pi branch from the current conversation. */
    fork?(): Promise<{ readonly conversationId: string; readonly title: string }>;
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
    {
      name: "conversation",
      aliases: ["chat"],
      description: "Choose or switch persistent chat conversations",
      argumentHint: "[<name-or-path>]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (conversations === undefined) {
          shell.insertCommandResult("/conversation", "Conversations are unavailable.", "error");
          return;
        }
        const selector = argument.trim();
        if (selector.length === 0) {
          const flow = shell.setupFlow;
          flow.begin("conversation");
          try {
            for (;;) {
              const rows = await conversations.conversations();
              const currentConversationId = conversations.conversationId;
              let conversationIdToClose: string | undefined;
              const picked = await flow.readSelect({
                message: "Conversations",
                options: rows.map((item) => ({
                  value: item.conversationId,
                  label: item.title,
                  hint:
                    item.scope.kind === "workspace"
                      ? "workspace"
                      : item.isDefault
                        ? "global · default"
                        : "global",
                  ...(item.scope.kind === "workspace" ? { description: item.scope.workspaceId } : {}),
                })),
                ...(currentConversationId === undefined
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
                  const fallback = (await conversations.conversations())[0];
                  if (fallback === undefined) throw new Error("No conversation remains after close");
                  await conversations.select(fallback.conversationId);
                }
                flow.renderLine(`Closed ${closing?.title ?? "conversation"}.`, "success");
                continue;
              }
              const conversationId = picked;
              if (conversationId === undefined) return;
              const selected = await conversations.select(conversationId);
              shell.insertCommandResult("/conversation", `Switched to ${selected.title}.`, "success");
              return;
            }
          } finally {
            flow.end();
          }
        }
        const rows = await conversations.conversations();
        const byId = rows.find((item) => item.conversationId === selector);
        const matches =
          byId === undefined
            ? rows.filter(
                (item) =>
                  item.title.toLowerCase() === selector.toLowerCase() ||
                  (item.scope.kind === "workspace" && item.scope.workspaceId === selector),
              )
            : [byId];
        if (matches.length === 0) {
          shell.insertCommandResult(
            `/conversation ${selector}`,
            `No conversation matches ${selector}. Run /conversation to choose one.`,
            "error",
          );
          return;
        }
        if (matches.length > 1) {
          shell.insertCommandResult(
            `/conversation ${selector}`,
            `More than one conversation is named ${selector}. Use /cd <path> to choose its workspace.`,
            "error",
          );
          return;
        }
        const selected = await conversations.select(matches[0]!.conversationId);
        shell.insertCommandResult(`/conversation ${selector}`, `Switched to ${selected.title}.`, "success");
      },
    },
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
          shell.insertCommandResult("/btw", "A side conversation is already open.", "error");
          return;
        }
        await conversations.fork();
        await shell.detachActiveTurn();
        shell.beginSideConversation();
        shell.insertCommandResult("/btw", "Side conversation · Ctrl+C to discard and return.", "success");
        const question = argument.trim();
        if (question.length > 0) await shell.submitUserPrompt(question);
      },
    },
    {
      name: "goal",
      aliases: [],
      description: "Show, start, pause, resume, or clear this conversation's goal",
      argumentHint: "[pause|resume|clear|--tokens <n> <objective>|<objective>]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (conversations?.autonomy === undefined) {
          shell.insertCommandResult("/goal", "Goals are unavailable.", "error");
          return;
        }
        const input = argument.trim();
        let command: OperatorAutonomyCommand;
        if (input.length === 0 || input === "status") command = { action: "status" };
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
      name: "games",
      aliases: ["gameplay"],
      description: "Configure Clankie's PokeAgent game bodies",
      argumentHint: "[solo|mmo] [on|off]",
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
          shell.insertCommandResult(
            "/games",
            formatGameplaySettings((await settings.load()).gameplay),
            "success",
          );
          return;
        }
        const [mode, state] = words;
        if (
          (mode !== "solo" && mode !== "mmo") ||
          (state !== "on" && state !== "off") ||
          words.length !== 2
        ) {
          shell.insertCommandResult("/games", "Usage: /games [solo|mmo] [on|off]", "error");
          return;
        }
        const enabled = state === "on";
        const next = await setGameplayEnabled(settings, mode, enabled);
        shell.insertCommandResult(
          "/games",
          `${formatGameplaySettings(next.gameplay)}\n\nRestart Clankie to apply this change.`,
          "success",
        );
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
        const formatted = formatHerdrJumpResult(await jumpToHerdrAgent(target));
        shell.insertCommandResult(`/jump ${target}`, formatted.text, formatted.tone);
      },
    },
    {
      name: "status",
      aliases: [],
      description: "Show console and clankie service status",
      takesArgument: false,
      availableInSideConversation: true,
      run(_argument, shell): void {
        const s = statusHelpers(shell);
        const snapshot = presence?.();
        const currentContextUsage = contextUsage?.();
        const roster = herdrRoster?.();
        shell.insertCommandResult(
          "/status",
          [
            s.title("Console"),
            s.line("discord", snapshot?.phase ?? "unavailable", snapshot === undefined ? "warn" : "ok"),
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

function formatAutonomyStatus(status: OperatorAutonomyStatus): string {
  const goal = status.goal;
  const wake = status.wake;
  return [
    `Autonomy: ${status.enabled ? "on" : "off"}`,
    ...(status.error === undefined ? [] : ["State: unreadable · autonomy is fail-closed"]),
    goal === undefined ? "Goal: none" : `Goal: ${goal.status} · ${goal.objective}`,
    ...(goal?.tokenBudget === undefined
      ? []
      : [`Budget: ${String(goal.tokensUsed)} / ${String(goal.tokenBudget)} tokens`]),
    wake === undefined ? "Wake: none" : `Wake: ${wake.at} · ${wake.reason}`,
  ].join("\n");
}

function formatGameplaySettings(settings: GameplaySettings): string {
  return [
    `Pokémon emulator (solo): ${settings.pokemonEmulatorEnabled ? "enabled" : "disabled"}`,
    `PokeAgent MMO: ${settings.pokeagentMmoEnabled ? "enabled" : "disabled"}`,
    "Live session: one across both modes",
  ].join("\n");
}

async function setGameplayEnabled(settings: SettingsStore, mode: "solo" | "mmo", enabled: boolean) {
  return await settings.update((current) => ({
    ...current,
    gameplay:
      mode === "solo"
        ? { ...current.gameplay, pokemonEmulatorEnabled: enabled }
        : { ...current.gameplay, pokeagentMmoEnabled: enabled },
  }));
}

async function runGameplayWizard(shell: ClankieFaceShell, settings: SettingsStore): Promise<void> {
  const flow = shell.setupFlow;
  let initialValue = "solo";
  flow.begin("games");
  try {
    for (;;) {
      const gameplay = (await settings.load()).gameplay;
      const selected = await flow.readSelect({
        message:
          "Toggle a PokeAgent game\nEnter toggles availability. Both may be enabled; one live session runs across them.",
        options: [
          {
            value: "solo",
            label: `${gameplay.pokemonEmulatorEnabled ? "✓" : "○"} Pokémon emulator (solo)`,
            hint: gameplay.pokemonEmulatorEnabled ? "enabled" : "disabled",
            description: "FireRed or Emerald on Clankie's local GBA emulator.",
          },
          {
            value: "mmo",
            label: `${gameplay.pokeagentMmoEnabled ? "✓" : "○"} PokeAgent MMO`,
            hint: gameplay.pokeagentMmoEnabled ? "enabled" : "disabled",
            description: "FireRed or Emerald in the hosted multiplayer world.",
          },
        ],
        statusActions: [{ value: "done", label: "Done", hint: "restart Clankie to apply changes" }],
        initialValue,
      });
      const mode = selected;
      if (mode !== "solo" && mode !== "mmo") break;
      const enabled = mode === "solo" ? !gameplay.pokemonEmulatorEnabled : !gameplay.pokeagentMmoEnabled;
      await setGameplayEnabled(settings, mode, enabled);
      flow.renderLine(
        `${mode === "solo" ? "Pokémon emulator" : "PokeAgent MMO"} ${enabled ? "enabled" : "disabled"}.`,
        "success",
      );
      initialValue = mode;
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
