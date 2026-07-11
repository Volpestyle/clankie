package io.clankie.verifier;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;

final class EvidenceWriter {
  Path write(
      Path runsRoot,
      ScenarioCriteria criteria,
      ScenarioRun run,
      ScenarioEvaluator.FinalState state,
      ScenarioEvaluator.Evaluation evaluation)
      throws IOException {
    if (run.endedAt() == null) throw new IllegalStateException("Cannot write an unfinished run");
    Path runDirectory = runsRoot.resolve(run.runId()).normalize();
    if (!runDirectory.startsWith(runsRoot.normalize())) throw new IOException("Run path escaped evidence root");
    Files.createDirectories(runDirectory);

    Path eventsPath = runDirectory.resolve("events.jsonl");
    String eventText = String.join("\n", run.events().lines()) + "\n";
    writeImmutable(eventsPath, eventText);
    String eventsSha256 = Hashing.sha256(eventsPath);
    writeImmutable(runDirectory.resolve("events.jsonl.sha256"), eventsSha256 + "  events.jsonl\n");

    var finalState = new LinkedHashMap<String, Object>();
    finalState.put("playerName", state.playerName());
    finalState.put("alive", state.alive());
    finalState.put("health", state.health());
    finalState.put("gameMode", state.gameMode());
    finalState.put("collectedLogs", state.collectedLogs());
    finalState.put("craftedTable", state.craftedTable());
    finalState.put("placedTableInTarget", state.placedTableInTarget());
    finalState.put("actualPlacedBlock", state.actualPlacedBlock());
    finalState.put("inventory", state.inventory());
    finalState.put("violations", state.violations());

    var eventArtifact = new LinkedHashMap<String, Object>();
    eventArtifact.put("kind", "event_log");
    eventArtifact.put("path", "events.jsonl");
    eventArtifact.put("sha256", eventsSha256);

    var report = new LinkedHashMap<String, Object>();
    report.put("schemaVersion", 1);
    report.put("scenarioId", criteria.scenarioId());
    report.put("scenarioVersion", criteria.scenarioVersion());
    report.put("fixtureSha256", criteria.fixtureSha256());
    report.put("runId", run.runId());
    report.put("result", evaluation.passed() ? "passed" : "failed");
    report.put("startedAt", run.startedAt().toString());
    report.put("endedAt", run.endedAt().toString());
    report.put("durationMs", Duration.between(run.startedAt(), run.endedAt()).toMillis());
    report.put("startingStateSha256", run.startingStateSha256());
    report.put("eventChainHeadSha256", run.events().headSha256());
    report.put("checks", evaluation.checks());
    report.put("finalState", finalState);
    report.put("artifacts", new ArrayList<>(java.util.List.of(eventArtifact)));

    Path reportPath = runDirectory.resolve("report.json");
    writeImmutable(reportPath, Json.encode(report) + "\n");
    String reportSha256 = Hashing.sha256(reportPath);
    writeImmutable(runDirectory.resolve("report.json.sha256"), reportSha256 + "  report.json\n");
    return reportPath;
  }

  private static void writeImmutable(Path path, String contents) throws IOException {
    if (Files.exists(path)) {
      if (Files.readString(path, StandardCharsets.UTF_8).equals(contents)) return;
      throw new IOException("Refusing to overwrite different verifier evidence: " + path);
    }
    Files.writeString(
        path,
        contents,
        StandardCharsets.UTF_8,
        StandardOpenOption.CREATE_NEW,
        StandardOpenOption.WRITE);
  }
}
