#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { meanInterval, pairedDifference, wilson } from "./stats.mjs";

const sliceOf = (row) =>
  row.heldout ? "heldout" : row.kind === "benchmark" ? "benchmark" : row.incident ? "incident" : row.kind;

/**
 * One trial per (report, case, arm, rep): a trial passes when any of its
 * attempts passed, and its cost includes failed attempts. Trials compare only
 * within one scope: same harness, CLI version, model and suite.
 */
function trials(reports) {
  const byKey = new Map();
  for (const report of reports)
    for (const row of report.results) {
      // Setup failures before the model ran are counted apart, never as trials.
      if (row.infrastructure) continue;
      const key = JSON.stringify([report.id, row.caseId, row.config, row.rep ?? 0]);
      const scope = JSON.stringify({
        harness: row.harness,
        cliVersion: report.version,
        model: row.model,
        suite: report.kind === "benchmark" ? report.options.dataset : "clankie",
      });
      const trial = byKey.get(key) ?? {
        scope,
        caseId: row.caseId,
        config: row.config,
        slice: sliceOf(row),
        heldout: Boolean(row.heldout),
        instructionsSha256: row.condition?.instructionsSha256 ?? null,
        passed: false,
        tokens: 0,
        unknownUsage: false,
        wallMs: 0,
        errors: 0,
      };
      trial.passed ||= Boolean(row.passed);
      if (row.tokens) trial.tokens += row.tokens.total;
      else trial.unknownUsage = true;
      trial.wallMs += row.wallMs ?? 0;
      if (row.error || row.timedOut) trial.errors++;
      byKey.set(key, trial);
    }
  return [...byKey.values()];
}

function rate(list) {
  const passes = list.filter((t) => t.passed).length;
  return {
    trials: list.length,
    passes,
    passRate: list.length ? passes / list.length : null,
    ci95: wilson(passes, list.length),
  };
}

function compare(list, baseline, config, value) {
  const byCase = new Map();
  for (const t of list) {
    if (t.config !== baseline && t.config !== config) continue;
    const measure = value(t);
    if (measure === null) continue;
    const entry = byCase.get(t.caseId) ?? { a: [], b: [] };
    (t.config === baseline ? entry.a : entry.b).push(measure);
    byCase.set(t.caseId, entry);
  }
  return pairedDifference(byCase);
}

export function summarize(reports, { baseline } = {}) {
  const all = trials(reports);
  return [...new Set(all.map((t) => t.scope))].map((scope) => {
    const list = all.filter((t) => t.scope === scope);
    const configs = [...new Set(list.map((t) => t.config))].sort();
    const reference =
      baseline && configs.includes(baseline) ? baseline : configs.includes("bare") ? "bare" : configs[0];
    const slices = [...new Set(list.map((t) => t.slice))].sort();
    const arms = configs.map((config) => {
      const mine = list.filter((t) => t.config === config);
      const known = mine.filter((t) => !t.unknownUsage);
      const perCase = {};
      for (const t of mine.filter((t) => !t.heldout))
        perCase[t.caseId] =
          `${mine.filter((x) => x.caseId === t.caseId && x.passed).length}/${mine.filter((x) => x.caseId === t.caseId).length}`;
      return {
        config,
        instructionsSha256: mine[0]?.instructionsSha256 ?? null,
        ...rate(mine),
        tokensPerTrial: meanInterval(known.map((t) => t.tokens)),
        wallMsPerTrial: meanInterval(mine.map((t) => t.wallMs)),
        unknownUsage: mine.length - known.length,
        errors: mine.reduce((sum, t) => sum + t.errors, 0),
        slices: Object.fromEntries(
          slices.map((slice) => [slice, rate(mine.filter((t) => t.slice === slice))]),
        ),
        // Held-out cases are aggregated only; their IDs never become a tuning target.
        perCase,
      };
    });
    const comparisons = configs
      .filter((config) => config !== reference)
      .map((config) => ({
        config,
        against: reference,
        passRate: compare(list, reference, config, (t) => (t.passed ? 1 : 0)),
        slices: Object.fromEntries(
          slices.map((slice) => [
            slice,
            compare(
              list.filter((t) => t.slice === slice),
              reference,
              config,
              (t) => (t.passed ? 1 : 0),
            ),
          ]),
        ),
        tokensPerTrial: compare(list, reference, config, (t) => (t.unknownUsage ? null : t.tokens)),
        wallMsPerTrial: compare(list, reference, config, (t) => t.wallMs),
      }));
    return { ...JSON.parse(scope), arms, comparisons };
  });
}

const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(0)}%`);
const ci = (pair, f = pct) => (pair ? `${f(pair[0])} to ${f(pair[1])}` : "n/a");
const kilo = (x) => `${(x / 1000).toFixed(0)}k`;
const seconds = (x) => `${(x / 1000).toFixed(0)} s`;
const signed = (f) => (x) => `${x >= 0 ? "+" : "−"}${f(Math.abs(x))}`;

/** Markdown tables for the testing archive. */
export function markdown(summary) {
  const out = [];
  for (const scope of summary) {
    out.push(`### ${scope.suite} · ${scope.harness} ${scope.cliVersion} · ${scope.model}`, "");
    out.push("| Arm | Pass rate | 95% CI | Tokens/trial (95% CI) | Wall/trial (95% CI) | Trials | Errors |");
    out.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const arm of scope.arms)
      out.push(
        `| ${arm.config} | ${arm.passes}/${arm.trials} (${pct(arm.passRate)}) | ${ci(arm.ci95)} | ${arm.tokensPerTrial ? `${kilo(arm.tokensPerTrial.mean)} (${ci(arm.tokensPerTrial.ci95, kilo)})` : "unknown"} | ${arm.wallMsPerTrial ? `${seconds(arm.wallMsPerTrial.mean)} (${ci(arm.wallMsPerTrial.ci95, seconds)})` : "n/a"} | ${arm.trials} | ${arm.errors} |`,
      );
    out.push("");
    for (const c of scope.comparisons) {
      out.push(`${c.config} − ${c.against}, paired by case (case-clustered bootstrap):`, "");
      out.push("| Measure | Difference | 95% CI | Verdict |", "| --- | --- | --- | --- |");
      const line = (name, d, f) =>
        d &&
        out.push(
          `| ${name} | ${signed(f)(d.difference)} | ${ci(d.ci95, signed(f))} | ${d.insufficient ? "too few trials" : d.withinNoise ? "within noise" : "outside noise"} (${d.cases} cases) |`,
        );
      line("Pass rate", c.passRate, pct);
      for (const [slice, d] of Object.entries(c.slices)) line(`Pass rate: ${slice}`, d, pct);
      line("Tokens/trial", c.tokensPerTrial, kilo);
      line("Wall/trial", c.wallMsPerTrial, seconds);
      out.push("");
    }
  }
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith("--"));
  if (paths.length === 0) {
    console.error("Usage: node scripts/evals/report.mjs [--markdown] REPORT.json [REPORT.json ...]");
    process.exitCode = 1;
  } else {
    const summary = summarize(paths.map((path) => JSON.parse(readFileSync(path, "utf8"))));
    console.log(
      args.includes("--markdown")
        ? markdown(summary)
        : JSON.stringify(
            {
              scopes: summary,
              caveat:
                "Pass-rate intervals are Wilson intervals over trials; comparisons resample cases, then trials within a case, and call a difference within noise when its interval includes zero. Tokens are provider-reported, not subscription quota. Unknown usage is excluded from token means, never counted as zero.",
            },
            null,
            2,
          ),
    );
  }
}
