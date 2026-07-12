package io.clankie.verifier;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.bukkit.Material;

final class ScenarioRun {
  private final String runId;
  private final Instant startedAt;
  private final String startingStateSha256;
  private final EventChain events;
  private final List<String> violations = new ArrayList<>();
  private int collectedLogs;
  private boolean craftedTable;
  private ScenarioCriteria.BlockPos placedTable;
  private Instant endedAt;

  ScenarioRun(String runId, Instant startedAt, String startingStateSha256, int maximumEvents) {
    if (!runId.matches("[A-Za-z0-9._-]{1,64}")) throw new IllegalArgumentException("Unsafe run id");
    this.runId = runId;
    this.startedAt = startedAt;
    this.startingStateSha256 = startingStateSha256;
    this.events = new EventChain(maximumEvents);
    event("scenario.started", startedAt, Map.of("startingStateSha256", startingStateSha256));
  }

  void collected(Material material, ScenarioCriteria.BlockPos position, Instant at) {
    collectedLogs++;
    event("log.collected", at, Map.of("material", material.name(), "position", position.stable(), "count", collectedLogs));
  }

  void craftedTable(Instant at) {
    craftedTable = true;
    event("crafting_table.crafted", at, Map.of());
  }

  void placedTable(ScenarioCriteria.BlockPos position, boolean insideTarget, Instant at) {
    placedTable = position;
    event("crafting_table.placed", at, Map.of("position", position.stable(), "insideTarget", insideTarget));
    if (!insideTarget) forbid("crafting_table_outside_target", at);
  }

  void forbid(String violation, Instant at) {
    if (!violations.contains(violation)) violations.add(violation);
    event("policy.violation", at, Map.of("violation", violation));
  }

  void finish(Instant at) {
    if (endedAt != null) return;
    endedAt = at;
    event("scenario.ended", at, Map.of());
  }

  void event(String type, Instant at, Map<String, ?> data) {
    events.append(type, at, new LinkedHashMap<>(data));
  }

  String runId() { return runId; }
  Instant startedAt() { return startedAt; }
  Instant endedAt() { return endedAt; }
  String startingStateSha256() { return startingStateSha256; }
  EventChain events() { return events; }
  int collectedLogs() { return collectedLogs; }
  boolean craftedTable() { return craftedTable; }
  ScenarioCriteria.BlockPos placedTable() { return placedTable; }
  List<String> violations() { return List.copyOf(violations); }
}
