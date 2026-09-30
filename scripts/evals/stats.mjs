/** Small-sample statistics for eval trials. Deterministic: a fixed seed reproduces every interval. */

const Z95 = 1.959964;

/** Wilson score interval for k passes in n trials; stays inside [0, 1] at 0/n and n/n. */
export function wilson(k, n, z = Z95) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** mulberry32: tiny seeded PRNG so reports are reproducible. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const percentile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
const pick = (values, next) => values[Math.floor(next() * values.length)];

/** Mean with a percentile-bootstrap 95% interval; null when there are no samples. */
export function meanInterval(values, { iterations = 2000, seed = 1467 } = {}) {
  if (values.length === 0) return null;
  const next = random(seed);
  const draws = Array.from({ length: iterations }, () => mean(values.map(() => pick(values, next))));
  draws.sort((a, b) => a - b);
  return { mean: mean(values), ci95: [percentile(draws, 0.025), percentile(draws, 0.975)] };
}

/**
 * Paired comparison of two arms on the cases both ran. Trials within a case are
 * correlated, so the bootstrap resamples cases first and trials within each
 * case second; a trial-level interval would overstate certainty.
 * `byCase` maps case ID to { a: number[], b: number[] }; the result is b − a.
 */
export function pairedDifference(byCase, { iterations = 4000, seed = 1467 } = {}) {
  const ids = [...byCase.keys()].filter((id) => byCase.get(id).a.length && byCase.get(id).b.length);
  if (ids.length === 0) return null;
  const effect = (id, draw) => {
    const { a, b } = byCase.get(id);
    return draw ? mean(b.map(() => pick(b, draw))) - mean(a.map(() => pick(a, draw))) : mean(b) - mean(a);
  };
  const next = random(seed);
  const draws = Array.from({ length: iterations }, () => mean(ids.map(() => effect(pick(ids, next), next))));
  draws.sort((x, y) => x - y);
  const ci95 = [percentile(draws, 0.025), percentile(draws, 0.975)];
  const trials = (arm) => ids.reduce((sum, id) => sum + byCase.get(id)[arm].length, 0);
  // Fewer than three trials an arm has no spread to resample: never a verdict.
  const insufficient = trials("a") < 3 || trials("b") < 3;
  return {
    cases: ids.length,
    difference: mean(ids.map((id) => effect(id))),
    ci95,
    // An interval that includes zero cannot distinguish the arms at this sample size.
    withinNoise: insufficient || (ci95[0] <= 0 && ci95[1] >= 0),
    ...(insufficient ? { insufficient } : {}),
  };
}
