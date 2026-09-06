#!/usr/bin/env node
/**
 * Sweep every play journal on this machine through the repository's own
 * evaluator and write one bounded summary per run.
 *
 * Node standard library only, plus `pnpm --filter @clankie/play
 * gameplay:evaluate-journal`. Nothing here reads a journal itself, so what the
 * archive proves is what the shipped evaluator says.
 *
 * The output is deliberately counts and verdicts. No monologue, note, reply,
 * narration wording, screenshot, or session bearer leaves the operator machine
 * — the same boundary the journal itself keeps (ADR 0160).
 *
 * Usage: node flows/sweep-play-archive.mjs [journalDir] > evidence/01-archive-sweep.json
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const journalDir = process.argv[2] ?? path.join(homedir(), ".local", "state", "clankie", "gba-play");

const runs = [];
for (const entry of readdirSync(journalDir)
  .filter((name) => name.endsWith(".jsonl"))
  .sort()) {
  const journalPath = path.join(journalDir, entry);
  try {
    const stdout = execFileSync(
      "pnpm",
      ["--filter", "@clankie/play", "gameplay:evaluate-journal", "--", journalPath],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout.slice(stdout.indexOf("{")));
    runs.push({
      journal: entry,
      readable: true,
      journalSchemaVersion: report.run.journalSchemaVersion,
      scenarioId: report.run.scenarioId,
      startedAt: report.run.startedAt,
      terminal: report.run.terminal,
      turns: report.aggregate.turns,
      retiredActionTurns: report.aggregate.retiredActionTurns,
      evidenceTurns: report.turns.filter((turn) => turn.evidence !== null).length,
      outcomes: report.aggregate.outcomes,
      timing: report.aggregate.timing,
      movementEffectiveness: report.aggregate.movementEffectiveness,
      intentToAction: report.aggregate.intentToAction,
      goalToAction: report.aggregate.goalToAction,
      sceneActionAppropriateness: report.aggregate.sceneActionAppropriateness,
      rejectionRecovery: report.aggregate.rejectionRecovery,
      narration: report.aggregate.narration,
      stalls: report.aggregate.stalls,
    });
  } catch (error) {
    runs.push({
      journal: entry,
      readable: false,
      error: String(error.stderr ?? error.message).slice(0, 400),
    });
  }
}

const readable = runs.filter((run) => run.readable);
process.stdout.write(
  `${JSON.stringify(
    {
      sweptAt: new Date().toISOString(),
      journalDir,
      journals: runs.length,
      readable: readable.length,
      unreadable: runs.length - readable.length,
      terminalSources: tally(readable.map((run) => run.terminal.source)),
      turns: readable.reduce((total, run) => total + run.turns, 0),
      turnsWithCausalEvidence: readable.reduce((total, run) => total + run.evidenceTurns, 0),
      retiredActionTurns: readable.reduce((total, run) => total + run.retiredActionTurns, 0),
      runs,
    },
    null,
    2,
  )}\n`,
);

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
