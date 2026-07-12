package io.clankie.verifier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.bukkit.Material;
import org.junit.jupiter.api.Test;

final class EvidenceWriterTest {
  @Test
  void preservesSuccessAndDeliberateFailureArtifacts() throws Exception {
    Path root = Path.of(System.getProperty("scenario.evidence.dir"));
    Files.createDirectories(root);
    var criteria = TestFixtures.criteria(256);
    var evaluator = new ScenarioEvaluator();
    var writer = new EvidenceWriter();

    var success = run("success-fixture", false);
    var successState = TestFixtures.successState(success);
    Path successReport = writer.write(root, criteria, success, successState, evaluator.evaluate(criteria, success, successState));
    assertEquals(
        successReport,
        writer.write(root, criteria, success, successState, evaluator.evaluate(criteria, success, successState)));
    assertTrue(Files.readString(successReport).contains("\"result\":\"passed\""));

    var failure = run("deliberate-failure-fixture", true);
    var failureState = new ScenarioEvaluator.FinalState(
        "Clankie", true, 20, "SURVIVAL", 8, true, false, "AIR", Map.of(), failure.violations(), false);
    Path failureReport = writer.write(root, criteria, failure, failureState, evaluator.evaluate(criteria, failure, failureState));
    assertTrue(Files.readString(failureReport).contains("\"result\":\"failed\""));

    for (Path report : List.of(successReport, failureReport)) {
      Path sidecar = report.resolveSibling("report.json.sha256");
      assertEquals(Hashing.sha256(report), Files.readString(sidecar).split("\\s+")[0]);
    }
  }

  private ScenarioRun run(String runId, boolean forbidden) {
    Instant start = Instant.parse("2026-07-11T12:00:00Z");
    var run = new ScenarioRun(runId, start, "b".repeat(64), 256);
    for (int index = 0; index < 8; index++) {
      run.collected(Material.OAK_LOG, new ScenarioCriteria.BlockPos(index, 65, 2), start.plusSeconds(index + 1));
    }
    run.craftedTable(start.plusSeconds(10));
    run.placedTable(new ScenarioCriteria.BlockPos(0, 65, 8), !forbidden, start.plusSeconds(11));
    if (forbidden) run.forbid("fixture_mutation", start.plusSeconds(12));
    run.finish(start.plusSeconds(13));
    return run;
  }
}
