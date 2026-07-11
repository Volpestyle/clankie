import React from "react";
import { StyleSheet, Text, View, type ViewProps } from "react-native";

export function TerminalSurface({
  terminalId,
  mode,
  style,
}: ViewProps & { terminalId: string; mode: "observe" | "control" }) {
  return (
    <View style={[styles.surface, style]}>
      <Text style={styles.text}>Native terminal component not linked.</Text>
      <Text style={styles.meta}>
        {terminalId} · {mode}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1, backgroundColor: "#101318", padding: 16 },
  text: { color: "#E8EDF2", fontFamily: "Menlo" },
  meta: { color: "#8C98A5", fontFamily: "Menlo", marginTop: 8 },
});
