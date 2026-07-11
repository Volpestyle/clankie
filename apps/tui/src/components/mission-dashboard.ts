import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import chalk from "chalk";

export interface DashboardAgent {
  id: string;
  harness: string;
  state: "working" | "waiting" | "blocked" | "failed" | "completed";
  task: string;
  location: string;
}

export interface DashboardState {
  mission: string;
  doctrine: string;
  score?: number;
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
    lines.push(pad("─".repeat(Math.max(1, width)), width));
    lines.push(pad(chalk.bold(" AGENT ROSTER"), width));
    for (const agent of state.agents) {
      lines.push(
        pad(
          ` ${stateIcon(agent.state)} ${chalk.bold(agent.id)} ${chalk.dim(`[${agent.harness}]`)} · ${agent.task} · ${agent.location}`,
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
    for (const item of state.timeline.slice(-6)) lines.push(pad(` ${chalk.dim("›")} ${item}`, width));
    return lines;
  }
}
