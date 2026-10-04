import {
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { LiveAgent } from "../observation/herdr-roster.ts";

/** A bounded dock window; selection is a qualified seat identity, never a row or bare pane. */
export class LiveAgentStrip implements Component {
  focused = false;
  private selectedId: string | undefined;

  private readonly agents: () => readonly LiveAgent[];
  constructor(agents: () => readonly LiveAgent[]) {
    this.agents = agents;
  }

  selected(): LiveAgent | undefined {
    const agents = this.agents();
    return agents.find((agent) => agent.seat.seatId === this.selectedId) ?? agents[0];
  }

  move(delta: number): void {
    const agents = this.agents();
    const index = agents.findIndex((agent) => agent.seat.seatId === this.selected()?.seat.seatId);
    this.selectedId = agents[(index + delta + agents.length) % agents.length]?.seat.seatId;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const agents = this.agents();
    if (agents.length === 0) return [];
    const selected = this.selected();
    const index = agents.indexOf(selected!);
    const start = Math.max(0, index - 2);
    const rows = agents.slice(start, start + 3);
    const clean = (text: string) => stripTerminalSequences(text).replace(/[\r\n\t]/gu, " ");
    const remediation = selected?.seat.harnessBridge?.remediation;
    return [
      `Agents · ${agents.length} · ${this.focused ? "↑↓ select · enter look inside · esc back" : "ctrl+g look inside"}${agents.length > 3 ? ` · ${start + 1}–${start + rows.length}/${agents.length}` : ""}`,
      ...rows.map(({ name, seat }) => {
        const machine = seat.machine ?? seat.fleet;
        const bridge = seat.harnessBridge;
        const warning =
          bridge && bridge.status !== "live-process" && bridge.status !== "unobserved"
            ? ` · bridge ${bridge.status}: ${bridge.remediation ?? bridge.detail}`
            : "";
        const step = seat.stance?.note || seat.title || seat.summary || "step unavailable";
        return `${this.focused && seat.seatId === selected?.seat.seatId ? "›" : "·"} ${clean(name)} · ${clean(seat.harness)} · ${clean(seat.status)}${machine && machine !== "local" ? ` · ${clean(machine)}` : ""}${clean(warning)} · ${clean(step)}`;
      }),
      ...(this.focused && remediation
        ? wrapTextWithAnsi(`Fix: ${clean(remediation)}`, Math.max(1, width))
        : []),
    ].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }
}
