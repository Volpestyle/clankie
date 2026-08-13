import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { styleText } from "node:util";

// node:util ships every style this dashboard uses and strips colour off a
// non-TTY exactly like chalk did, so the dependency bought us nothing.
const chalk = {
  bold: (text: string) => styleText("bold", text),
  cyan: (text: string) => styleText("cyan", text),
  dim: (text: string) => styleText("dim", text),
  green: (text: string) => styleText("green", text),
  red: (text: string) => styleText("red", text),
  yellow: (text: string) => styleText("yellow", text),
};

export interface DashboardAgent {
  id: string;
  harness: string;
  state: "working" | "waiting" | "blocked" | "failed" | "completed";
  task: string;
}

export interface DashboardMission {
  id: string;
  goal: string;
  state: string;
  selected: boolean;
}

export interface DashboardTask {
  id: string;
  title: string;
  state: string;
  dependsOn: string[];
}

/** A Discord presence session. Its own stream, deliberately not a mission. */
export interface DashboardPresence {
  sessionId: string;
  phase: string;
  /** When the session last changed phase; a live phase with an old stamp is suspect. */
  updatedAt?: string;
}

/** A sibling agent observed in a Herdr pane — not a mission worker. */
export interface DashboardHerdrAgent {
  paneId: string;
  agent: string;
  status: "working" | "idle" | "blocked" | "unknown";
  title: string;
}

export interface DashboardState {
  connection: string;
  cursor: number;
  mission: string;
  doctrine: string;
  score?: number;
  missions: DashboardMission[];
  presence: DashboardPresence[];
  tasks: DashboardTask[];
  agents: DashboardAgent[];
  /** Present only when the console runs inside Herdr (VUH-946). */
  herdr?: { agents: DashboardHerdrAgent[]; error?: string };
  attention: string[];
  timeline: string[];
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function stateIcon(state: DashboardAgent["state"]): string {
  switch (state) {
    case "working":
      return chalk.cyan("●");
    case "waiting":
      return chalk.yellow("◐");
    case "blocked":
      return chalk.yellow("!");
    case "failed":
      return chalk.red("×");
    case "completed":
      return chalk.green("✓");
  }
}

function herdrStatusIcon(status: DashboardHerdrAgent["status"]): string {
  if (status === "working") return chalk.cyan("●");
  if (status === "blocked") return chalk.yellow("!");
  if (status === "idle") return chalk.dim("○");
  return chalk.dim("·");
}

const LIVE_PRESENCE_PHASES = new Set(["present", "voice_active", "go_live_active"]);

function phaseIcon(phase: string): string {
  if (LIVE_PRESENCE_PHASES.has(phase)) return chalk.green("●");
  if (phase === "degraded" || phase === "connecting") return chalk.yellow("◐");
  if (phase === "failed") return chalk.red("×");
  return chalk.dim("○");
}

function phaseLabel(phase: string): string {
  const label = `[${phase}]`;
  return LIVE_PRESENCE_PHASES.has(phase) ? label : chalk.dim(label);
}

/**
 * Phase transitions are edge-triggered, so the stamp is the only liveness hint
 * a reader gets: a "present" row whose last transition is days old is a dead
 * process the projection never heard say goodbye.
 */
function phaseSince(updatedAt: string | undefined, now: Date): string {
  if (updatedAt === undefined) return "";
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = at.toDateString() === now.toDateString();
  const stamp = sameDay
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return chalk.dim(` · since ${stamp}`);
}

export class MissionDashboard implements Component {
  private readonly getState: () => DashboardState;

  public constructor(getState: () => DashboardState) {
    this.getState = getState;
  }

  public invalidate(): void {}

  public render(width: number): string[] {
    width = Math.max(1, width);
    const state = this.getState();
    const lines: string[] = [];
    lines.push(pad(chalk.bold(` CLANKIE  ${state.mission}`), width));
    lines.push(
      pad(
        chalk.dim(
          ` Doctrine: ${state.doctrine}${state.score === undefined ? "" : ` · eval ${(state.score * 100).toFixed(1)}%`}`,
        ),
        width,
      ),
    );
    lines.push(pad(chalk.dim(` Observer: ${state.connection} · cursor #${state.cursor.toString()}`), width));
    lines.push(pad("─".repeat(Math.max(1, width)), width));
    lines.push(pad(chalk.bold(" MISSIONS"), width));
    if (state.missions.length === 0) lines.push(pad(chalk.dim(" No missions observed."), width));
    for (const mission of state.missions.slice(0, 6)) {
      const marker = mission.selected ? chalk.cyan("›") : " ";
      lines.push(
        pad(
          ` ${marker} ${chalk.bold(mission.id)} ${chalk.dim(`[${mission.state}]`)} · ${mission.goal}`,
          width,
        ),
      );
    }
    if (state.presence.length > 0) {
      lines.push("");
      lines.push(pad(chalk.bold(" DISCORD PRESENCE"), width));
      const now = new Date();
      for (const session of state.presence.slice(0, 3)) {
        lines.push(
          pad(
            ` ${phaseIcon(session.phase)} ${session.sessionId} ${phaseLabel(session.phase)}${phaseSince(session.updatedAt, now)}`,
            width,
          ),
        );
      }
    }
    lines.push("");
    lines.push(pad(chalk.bold(" TASK TREE"), width));
    if (state.tasks.length === 0) lines.push(pad(chalk.dim(" No tasks observed."), width));
    for (const task of state.tasks) {
      const branch = task.dependsOn.length === 0 ? "├─" : "└─";
      const dependencies = task.dependsOn.length === 0 ? "" : chalk.dim(` ← ${task.dependsOn.join(", ")}`);
      lines.push(
        pad(
          ` ${branch} ${chalk.bold(task.id)} ${chalk.dim(`[${task.state}]`)} · ${task.title}${dependencies}`,
          width,
        ),
      );
    }
    lines.push("");
    lines.push(pad(chalk.bold(" AGENT ROSTER"), width));
    // Distinguish "no mission workers" from "no visibility": inside Herdr the
    // pane roster is a second observed source, so an empty section is a claim.
    if (state.agents.length === 0) {
      lines.push(
        pad(
          chalk.dim(state.herdr === undefined ? " No workers observed." : " No mission workers reported."),
          width,
        ),
      );
    }
    for (const agent of state.agents) {
      lines.push(
        pad(
          ` ${stateIcon(agent.state)} ${chalk.bold(agent.id)} ${chalk.dim(`[${agent.harness}]`)} · ${agent.task}`,
          width,
        ),
      );
    }
    if (state.herdr !== undefined) {
      for (const pane of state.herdr.agents) {
        lines.push(
          pad(
            ` ${herdrStatusIcon(pane.status)} ${chalk.bold(pane.paneId)} ${chalk.dim(`[${pane.agent} · herdr]`)} · ${pane.title}`,
            width,
          ),
        );
      }
      if (state.herdr.error !== undefined) {
        lines.push(pad(chalk.dim(` herdr roster unavailable: ${state.herdr.error}`), width));
      }
    }
    lines.push("");
    lines.push(pad(chalk.bold(" ATTENTION"), width));
    if (state.attention.length === 0) lines.push(pad(chalk.dim(" No operator action required."), width));
    for (const item of state.attention) lines.push(pad(` ${chalk.yellow("!")} ${item}`, width));
    lines.push("");
    lines.push(pad(chalk.bold(" EVENT TAIL"), width));
    if (state.timeline.length === 0) lines.push(pad(chalk.dim(" No events observed."), width));
    for (const item of state.timeline.slice(-8)) lines.push(pad(` ${chalk.dim("›")} ${item}`, width));
    return lines;
  }
}
