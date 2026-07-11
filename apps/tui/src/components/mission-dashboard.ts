import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import chalk from "chalk";

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

export interface DashboardState {
  connection: string;
  cursor: number;
  mission: string;
  doctrine: string;
  score?: number;
  missions: DashboardMission[];
  tasks: DashboardTask[];
  agents: DashboardAgent[];
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
    if (state.agents.length === 0) lines.push(pad(chalk.dim(" No workers observed."), width));
    for (const agent of state.agents) {
      lines.push(
        pad(
          ` ${stateIcon(agent.state)} ${chalk.bold(agent.id)} ${chalk.dim(`[${agent.harness}]`)} · ${agent.task}`,
          width,
        ),
      );
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
