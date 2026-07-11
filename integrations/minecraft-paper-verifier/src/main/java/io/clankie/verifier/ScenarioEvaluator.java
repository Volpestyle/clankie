package io.clankie.verifier;

import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ScenarioEvaluator {
  record FinalState(
      String playerName,
      boolean alive,
      double health,
      String gameMode,
      int collectedLogs,
      boolean craftedTable,
      boolean placedTableInTarget,
      String actualPlacedBlock,
      Map<String, Integer> inventory,
      List<String> violations,
      boolean eventOverflow) {}

  record Evaluation(boolean passed, Map<String, Boolean> checks) {}

  Evaluation evaluate(ScenarioCriteria criteria, ScenarioRun run, FinalState state) {
    var checks = new LinkedHashMap<String, Boolean>();
    checks.put("player_identity", state.playerName().equals(criteria.playerName()));
    checks.put("logs", state.collectedLogs() >= criteria.minimumLogs());
    checks.put("crafted", state.craftedTable());
    checks.put(
        "placed",
        state.placedTableInTarget() && state.actualPlacedBlock().equals("CRAFTING_TABLE"));
    checks.put("alive", state.alive() && state.health() > 0 && state.gameMode().equals("SURVIVAL"));
    checks.put("policy", state.violations().isEmpty() && !state.eventOverflow());
    long duration = Duration.between(run.startedAt(), run.endedAt()).toSeconds();
    checks.put("duration", duration >= 0 && duration <= criteria.maxDurationSeconds());
    return new Evaluation(
        checks.values().stream().allMatch(Boolean::booleanValue),
        Collections.unmodifiableMap(new LinkedHashMap<>(checks)));
  }
}
