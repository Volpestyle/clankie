package io.clankie.verifier;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.bukkit.Material;
import org.junit.jupiter.api.Test;

final class ScenarioEvaluatorTest {
  private final ScenarioEvaluator evaluator = new ScenarioEvaluator();
  private final ScenarioCriteria criteria = TestFixtures.criteria(256);

  @Test
  void acceptsOnlyAuthoritativeSuccessfulState() {
    var run = successfulRun("success");
    var result = evaluator.evaluate(criteria, run, TestFixtures.successState(run));
    assertTrue(result.passed());
    assertTrue(result.checks().values().stream().allMatch(Boolean::booleanValue));
  }

  @Test
  void rejectsFakeSuccessWhenWorldBlockIsWrong() {
    var run = successfulRun("fake-success");
    var state = new ScenarioEvaluator.FinalState(
        "Clankie", true, 20, "SURVIVAL", 8, true, true, "AIR", Map.of(), List.of(), false);
    var result = evaluator.evaluate(criteria, run, state);
    assertFalse(result.passed());
    assertFalse(result.checks().get("placed"));
  }

  @Test
  void failsClosedForForbiddenActionsAndOverflow() {
    var run = successfulRun("tamper");
    var state = new ScenarioEvaluator.FinalState(
        "Clankie",
        true,
        20,
        "SURVIVAL",
        8,
        true,
        true,
        "CRAFTING_TABLE",
        Map.of("OAK_LOG", 1),
        List.of("forbidden_command", "teleport", "creative_inventory", "fixture_mutation"),
        true);
    var result = evaluator.evaluate(criteria, run, state);
    assertFalse(result.passed());
    assertFalse(result.checks().get("policy"));
  }

  private ScenarioRun successfulRun(String runId) {
    Instant start = Instant.parse("2026-07-11T12:00:00Z");
    var run = new ScenarioRun(runId, start, "b".repeat(64), 256);
    for (int index = 0; index < 8; index++) {
      run.collected(Material.OAK_LOG, new ScenarioCriteria.BlockPos(index, 65, 2), start.plusSeconds(index + 1));
    }
    run.craftedTable(start.plusSeconds(10));
    run.placedTable(new ScenarioCriteria.BlockPos(0, 65, 8), true, start.plusSeconds(11));
    run.finish(start.plusSeconds(12));
    return run;
  }
}
