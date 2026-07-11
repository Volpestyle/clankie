package io.clankie.verifier;

import java.util.List;
import java.util.Set;
import org.bukkit.Material;

final class TestFixtures {
  private TestFixtures() {}

  static ScenarioCriteria criteria(int maximumEvents) {
    return new ScenarioCriteria(
        1,
        "collect-craft-place",
        1,
        "177331287aa35f03ed6e887e74e510bd675881e53f2a759c36f3a184877199ea",
        "private-paper-world",
        "world",
        774042,
        "Clankie",
        300,
        maximumEvents,
        8,
        Set.of(Material.OAK_LOG),
        new ScenarioCriteria.Spawn(0.5, 65, 0.5, 0, 0),
        new ScenarioCriteria.Cuboid(
            new ScenarioCriteria.BlockPos(-2, 65, 6), new ScenarioCriteria.BlockPos(2, 67, 10)),
        List.of(new ScenarioCriteria.BlockSpec(new ScenarioCriteria.BlockPos(-4, 65, 2), Material.OAK_LOG)));
  }

  static ScenarioEvaluator.FinalState successState(ScenarioRun run) {
    return new ScenarioEvaluator.FinalState(
        "Clankie",
        true,
        20,
        "SURVIVAL",
        run.collectedLogs(),
        run.craftedTable(),
        true,
        "CRAFTING_TABLE",
        java.util.Map.of(),
        run.violations(),
        run.events().overflowed());
  }
}
