import { projectGarden, type GardenWorld } from "@sapling/garden-model";
import type { DomainEvent } from "@sapling/protocol";
import { create } from "zustand";

export type CommandCenterMode = "garden" | "graph" | "terminal";

interface CommandCenterState {
  mode: CommandCenterMode;
  events: DomainEvent[];
  world: GardenWorld;
  selectedWorkerRunId: string | undefined;
  terminalId: string | undefined;
  setMode: (mode: CommandCenterMode) => void;
  ingest: (events: DomainEvent[]) => void;
  selectWorker: (workerRunId?: string) => void;
  openTerminal: (terminalId: string, workerRunId?: string) => void;
}

export const useCommandCenterStore = create<CommandCenterState>((set) => ({
  mode: "garden",
  events: [],
  world: { missionId: "none", agents: [], attentionQueue: [] },
  selectedWorkerRunId: undefined,
  terminalId: undefined,
  setMode: (mode) => set({ mode }),
  ingest: (incoming) =>
    set((state) => {
      const events = [...state.events, ...incoming];
      return { events, world: projectGarden(events) };
    }),
  selectWorker: (selectedWorkerRunId) => set({ selectedWorkerRunId }),
  openTerminal: (terminalId, selectedWorkerRunId) =>
    set({ mode: "terminal", terminalId, selectedWorkerRunId }),
}));
