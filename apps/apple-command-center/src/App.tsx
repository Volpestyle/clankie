import React from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ExecutionGraph } from "./graph/ExecutionGraph.tsx";
import { GardenCanvas } from "./garden/GardenCanvas.tsx";
import { useCommandCenterStore, type CommandCenterMode } from "./state/store.ts";
import { TerminalSurface } from "./terminal/TerminalSurface.tsx";

function ModeButton({ mode, label }: { mode: CommandCenterMode; label: string }) {
  const active = useCommandCenterStore((state) => state.mode === mode);
  const setMode = useCommandCenterStore((state) => state.setMode);
  return (
    <Pressable onPress={() => setMode(mode)} style={[styles.modeButton, active && styles.modeButtonActive]}>
      <Text style={[styles.modeLabel, active && styles.modeLabelActive]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const mode = useCommandCenterStore((state) => state.mode);
  const world = useCommandCenterStore((state) => state.world);
  const events = useCommandCenterStore((state) => state.events);
  const terminalId = useCommandCenterStore((state) => state.terminalId ?? "unselected");
  const selectWorker = useCommandCenterStore((state) => state.selectWorker);

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaView style={styles.root}>
        <View style={styles.toolbar}>
          <Text style={styles.brand}>Sapling</Text>
          <View style={styles.modeGroup}>
            <ModeButton mode="garden" label="Garden" />
            <ModeButton mode="graph" label="Graph" />
            <ModeButton mode="terminal" label="Terminal" />
          </View>
        </View>
        <View style={styles.content}>
          {mode === "garden" ? <GardenCanvas world={world} onSelect={selectWorker} /> : null}
          {mode === "graph" ? <ExecutionGraph events={events} /> : null}
          {mode === "terminal" ? (
            <TerminalSurface terminalId={terminalId} mode="observe" style={styles.content} />
          ) : null}
        </View>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  gestureRoot: { flex: 1 },
  root: { flex: 1, backgroundColor: "#F4F7F1" },
  toolbar: {
    height: 56,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#CCD5C7",
  },
  brand: { fontSize: 20, fontWeight: "800", color: "#243024" },
  modeGroup: { flexDirection: "row", gap: 8 },
  modeButton: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 9 },
  modeButtonActive: { backgroundColor: "#253D2C" },
  modeLabel: { color: "#526052", fontWeight: "600" },
  modeLabelActive: { color: "white" },
  content: { flex: 1 },
});
