import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { DomainEvent } from "@sapling/protocol";

export function ExecutionGraph({ events }: { events: DomainEvent[] }) {
  const taskIds = [...new Set(events.flatMap((event) => (event.taskId ? [event.taskId] : [])))];
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Execution graph</Text>
      <Text style={styles.description}>
        This skeleton renders a deterministic list. Replace each row with Skia nodes and selectable
        dependency, delegation, artifact, conflict, and communication edge layers.
      </Text>
      {taskIds.map((taskId) => {
        const taskEvents = events.filter((event) => event.taskId === taskId);
        return (
          <View key={taskId} style={styles.node}>
            <Text style={styles.nodeTitle}>{taskId}</Text>
            <Text style={styles.nodeMeta}>{taskEvents.at(-1)?.type ?? "queued"}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12 },
  heading: { fontSize: 24, fontWeight: "700" },
  description: { color: "#5E6670", lineHeight: 20 },
  node: { padding: 14, borderRadius: 12, borderWidth: 1, borderColor: "#CCD3DB", backgroundColor: "white" },
  nodeTitle: { fontWeight: "700" },
  nodeMeta: { marginTop: 4, color: "#5E6670" },
});
