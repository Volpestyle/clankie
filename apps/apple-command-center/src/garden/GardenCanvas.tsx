import React, { useMemo } from "react";
import { Canvas, Circle, Group, Line, Rect, vec } from "@shopify/react-native-skia";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { GardenAgent, GardenLocation, GardenWorld } from "@sapling/garden-model";

const stationOrder: GardenLocation[] = [
  "observatory",
  "seed_library",
  "design_pond",
  "build_grove",
  "test_greenhouse",
  "review_pavilion",
  "merge_gate",
  "release_harbor",
  "recovery_shed",
  "commons",
];

const harnessColor: Record<string, string> = {
  codex: "#4F7CFF",
  claude: "#D97745",
  pi: "#9B6CFF",
  local: "#3C9D74",
  shell: "#6B7280",
  simulated: "#27A9A1",
  unknown: "#8C8C8C",
};

function position(agent: GardenAgent, index: number, width: number, height: number) {
  const stationIndex = stationOrder.indexOf(agent.location);
  const columns = 5;
  const cellWidth = width / columns;
  const cellHeight = height / 2;
  const stationX = (stationIndex % columns) * cellWidth + cellWidth / 2;
  const stationY = Math.floor(stationIndex / columns) * cellHeight + cellHeight / 2;
  const offset = ((index % 5) - 2) * 16;
  return { x: stationX + offset, y: stationY + ((index % 2) * 18 - 9) };
}

export function GardenCanvas({
  world,
  onSelect,
}: {
  world: GardenWorld;
  onSelect: (workerRunId: string) => void;
}) {
  const { width } = useWindowDimensions();
  const canvasHeight = Math.max(440, width * 0.65);
  const placements = useMemo(
    () => world.agents.map((agent, index) => ({ agent, ...position(agent, index, width, canvasHeight) })),
    [world.agents, width, canvasHeight],
  );

  return (
    <View style={styles.container}>
      <Canvas style={{ width, height: canvasHeight }}>
        <Rect x={0} y={0} width={width} height={canvasHeight} color="#E8F0DF" />
        <Line p1={vec(width / 5, 0)} p2={vec(width / 5, canvasHeight)} color="#C9D7BF" strokeWidth={1} />
        <Line
          p1={vec((width / 5) * 2, 0)}
          p2={vec((width / 5) * 2, canvasHeight)}
          color="#C9D7BF"
          strokeWidth={1}
        />
        <Line
          p1={vec((width / 5) * 3, 0)}
          p2={vec((width / 5) * 3, canvasHeight)}
          color="#C9D7BF"
          strokeWidth={1}
        />
        <Line
          p1={vec((width / 5) * 4, 0)}
          p2={vec((width / 5) * 4, canvasHeight)}
          color="#C9D7BF"
          strokeWidth={1}
        />
        <Line
          p1={vec(0, canvasHeight / 2)}
          p2={vec(width, canvasHeight / 2)}
          color="#C9D7BF"
          strokeWidth={1}
        />
        {placements.map(({ agent, x, y }) => (
          <Group key={agent.workerRunId}>
            <Circle cx={x} cy={y + 12} r={18} color="#5A3E2B" />
            <Circle cx={x} cy={y - 10} r={24} color={harnessColor[agent.harness] ?? "#8C8C8C"} />
            <Rect x={x - 12} y={y - 18} width={24} height={14} color="#18212A" />
            {agent.attention !== "none" ? <Circle cx={x + 22} cy={y - 30} r={7} color="#D94A4A" /> : null}
          </Group>
        ))}
      </Canvas>
      <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { height: canvasHeight }]}>
        {placements.map(({ agent, x, y }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${agent.workerId}, ${agent.state}, ${agent.summary}`}
            key={agent.workerRunId}
            onPress={() => onSelect(agent.workerRunId)}
            style={{ position: "absolute", left: x - 36, top: y - 46, width: 72, height: 92 }}
          />
        ))}
      </View>
      <View style={styles.legend}>
        <Text style={styles.legendTitle}>Mission {world.missionId}</Text>
        <Text style={styles.legendText}>
          Biomes stay stable; stations encode workflow phase; sapling/computers encode worker runs.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#E8F0DF" },
  legend: {
    padding: 12,
    backgroundColor: "#F7FAF3",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#C9D7BF",
  },
  legendTitle: { fontWeight: "700", color: "#1E2A1E" },
  legendText: { marginTop: 4, color: "#4A5A4A" },
});
