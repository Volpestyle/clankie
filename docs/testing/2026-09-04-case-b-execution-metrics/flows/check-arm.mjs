/**
 * The frozen external correctness check for case B.
 *
 *   node check-arm.mjs --worktree DIR --state DIR [--base URL --token-env NAME]
 *
 * Exercises the two shipped read surfaces the requirement names, against seeded
 * fixture rows in an isolated state directory. It reads none of the arm's tests
 * and asserts nothing about how the feature is built — only that the CLI and,
 * when a service is offered, the HTTP route behave as the frozen requirement
 * says. Keyless: it makes no model call and needs no provider credential.
 *
 * Exits 0 only when every check passes. Prints one JSON report.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const arg = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const worktree = arg("--worktree");
const stateDir = arg("--state");
const base = arg("--base");
const tokenEnv = arg("--token-env");
if (worktree === undefined || stateDir === undefined) {
  console.error("usage: check-arm.mjs --worktree DIR --state DIR [--base URL --token-env NAME]");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fixtures. Legacy rows are exactly today's shape; new rows are only what the
// requirement's own JSON contract shows, so the fixtures cannot smuggle in an
// implementation choice.
// ---------------------------------------------------------------------------

const iso = (minutesAgo) => new Date(Date.UTC(2026, 8, 4, 12, 0, 0) - minutesAgo * 60_000).toISOString();
const legacy = (runId, minutesAgo) => ({
  schemaVersion: 1,
  type: "captain.turn.settled",
  conversationId: "conv-legacy",
  lane: "operator",
  runId,
  acceptedAt: iso(minutesAgo + 1),
  completedAt: iso(minutesAgo),
  outcome: "completed",
  toolCount: { bash: 2 },
  mutatingCount: 1,
  contextTokensStart: 0,
  contextTokensEnd: 1000,
});
const modern = (runId, minutesAgo, extra) => ({
  ...legacy(runId, minutesAgo),
  conversationId: "conv-modern",
  execution: { model: "gpt-5.6-terra", provider: "openai-codex", effort: "medium" },
  usage: { totalTokens: 4242, reports: 3 },
  ...extra,
});

const rows = [
  legacy("run-legacy-a", 90),
  legacy("run-legacy-b", 80),
  modern("run-modern-a", 70),
  modern("run-modern-b", 60, {
    execution: { model: "gpt-6-astra", provider: "openai-codex", effort: "medium" },
  }),
  // A failed turn still carries execution identity.
  modern("run-failed", 50, {
    outcome: "failed",
    completedAt: undefined,
    failedAt: iso(50),
    usage: { totalTokens: 11, reports: 1 },
  }),
  // Nothing reported: usage must be unavailable, never zero.
  modern("run-no-usage", 40, { usage: null }),
];
for (let index = 0; index < 30; index += 1) rows.push(modern(`run-bulk-${index}`, 30 - index * 0.5));

mkdirSync(join(stateDir, "captain"), { recursive: true });
const logPath = join(stateDir, "captain", "turn-settled.jsonl");
writeFileSync(
  logPath,
  `${rows
    .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))))
    .join("\n")}\n`,
);

// ---------------------------------------------------------------------------

const results = [];
const record = (id, ok, detail) => results.push({ id, ok, detail });

/**
 * `tsx` is a devDependency of the apps, not of the workspace root, so a fresh
 * worktree has no `node_modules/.bin/tsx`. Resolving it wrongly made every CLI
 * check fail with ENOENT — which reads as "the feature is missing" and let a
 * red baseline gate pass for the wrong reason. Finding it is its own check now,
 * so a broken toolchain can never masquerade as evidence again.
 */
function resolveTsx() {
  for (const candidate of [
    "apps/tui/node_modules/.bin/tsx",
    "apps/clankie/node_modules/.bin/tsx",
    "node_modules/.bin/tsx",
  ]) {
    const full = join(worktree, candidate);
    if (existsSync(full)) return full;
  }
  return undefined;
}
const tsxBin = resolveTsx();
record(
  "harness.tsx.resolved",
  tsxBin !== undefined,
  tsxBin === undefined
    ? "no tsx under the worktree; run pnpm install there — CLI checks below are meaningless"
    : tsxBin.slice(worktree.length + 1),
);

const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(stateDir, "config"),
  XDG_STATE_HOME: stateDir,
  XDG_CACHE_HOME: join(stateDir, "cache"),
  CLANKIE_STATE: stateDir,
};

async function cli(extra) {
  if (tsxBin === undefined) return { ok: false, detail: "tsx unresolved" };
  try {
    const { stdout } = await run(tsxBin, [join(worktree, "apps/tui/bin/clankie.ts"), "metrics", ...extra], {
      env,
      cwd: worktree,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, body: JSON.parse(stdout) };
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join(" ");
    return { ok: false, detail: detail.slice(0, 300).replace(/\s+/gu, " ") || "no output" };
  }
}

const items = (body) => (Array.isArray(body) ? body : (body?.items ?? undefined));
const recentFirst = (list) =>
  list.every((row, index) => index === 0 || (row.acceptedAt ?? "") <= (list[index - 1].acceptedAt ?? ""));

// --- CLI surface -----------------------------------------------------------

const base20 = await cli([]);
if (!base20.ok) {
  record("cli.default", false, `clankie metrics failed: ${base20.detail}`);
} else {
  const list = items(base20.body);
  record(
    "cli.default.shape",
    Array.isArray(list),
    `expected {items:[…]}, got ${JSON.stringify(base20.body).slice(0, 120)}`,
  );
  if (Array.isArray(list)) {
    record("cli.default.limit", list.length === 20, `default returned ${list.length}, expected 20`);
    record("cli.default.order", recentFirst(list), "items were not most-recent-first");
    const text = JSON.stringify(base20.body);
    record(
      "cli.no.secrets",
      !/clankie_op_|clankie_cap_|sk-|authorization/iu.test(text),
      "output looks like it carries credential material",
    );
  }
}

const limited = await cli(["--limit", "2"]);
record(
  "cli.limit.honoured",
  limited.ok && items(limited.body)?.length === 2,
  limited.ok ? `--limit 2 returned ${items(limited.body)?.length}` : (limited.detail ?? ""),
);

const over = await cli(["--limit", "101"]);
const overList = over.ok ? items(over.body) : undefined;
// Gated on the default path working, so a command that does not exist yet
// cannot satisfy this by failing. "Refused" only counts once `metrics` runs.
record(
  "cli.limit.bounded",
  base20.ok && (!over.ok || (Array.isArray(overList) && overList.length <= 100)),
  base20.ok
    ? "--limit 101 was neither refused nor bounded to 100"
    : "cannot judge bounds: `clankie metrics` did not run at all",
);

const filtered = await cli(["--run", "run-no-usage"]);
const filteredList = filtered.ok ? items(filtered.body) : undefined;
record(
  "cli.run.filter",
  Array.isArray(filteredList) && filteredList.length === 1 && filteredList[0]?.runId === "run-no-usage",
  filtered.ok
    ? `--run returned ${JSON.stringify(filteredList?.map((r) => r.runId))}`
    : (filtered.detail ?? ""),
);

// --- the contract the requirement froze ------------------------------------

const one = async (runId) => items((await cli(["--run", runId])).body ?? {})?.[0];

const legacyRow = await one("run-legacy-a");
record(
  "legacy.execution.explicitly.unknown",
  legacyRow !== undefined && "execution" in legacyRow && legacyRow.execution === null,
  `legacy execution was ${JSON.stringify(legacyRow?.execution)}, expected an explicit null`,
);
record(
  "legacy.usage.explicitly.unknown",
  legacyRow !== undefined && "usage" in legacyRow && legacyRow.usage === null,
  `legacy usage was ${JSON.stringify(legacyRow?.usage)}, expected an explicit null`,
);

const modernRow = await one("run-modern-b");
record(
  "modern.execution.reported",
  modernRow?.execution?.model === "gpt-6-astra" &&
    modernRow?.execution?.provider === "openai-codex" &&
    modernRow?.execution?.effort === "medium",
  `execution was ${JSON.stringify(modernRow?.execution)}`,
);
record(
  "modern.usage.reported",
  modernRow?.usage?.totalTokens === 4242 && modernRow?.usage?.reports === 3,
  `usage was ${JSON.stringify(modernRow?.usage)}`,
);
record(
  "usage.separate.from.context",
  modernRow?.contextTokensEnd === 1000 && modernRow?.usage?.totalTokens !== modernRow?.contextTokensEnd,
  "context occupancy and reported usage were not kept separate",
);
record(
  "no.cost.inference",
  modernRow !== undefined && !/cost|usd|dollar/iu.test(JSON.stringify(modernRow)),
  "an item carried an inferred cost field",
);

const failedRow = await one("run-failed");
record(
  "failed.turn.keeps.execution",
  failedRow?.outcome === "failed" && failedRow?.execution?.model === "gpt-6-astra",
  `failed row execution was ${JSON.stringify(failedRow?.execution)}`,
);

const noUsageRow = await one("run-no-usage");
record(
  "no.report.is.unavailable.not.zero",
  noUsageRow !== undefined && noUsageRow.usage === null,
  `a turn with no reports showed usage ${JSON.stringify(noUsageRow?.usage)}; expected null, never 0`,
);

// --- HTTP surface, when a service was offered ------------------------------

if (base !== undefined && tokenEnv !== undefined) {
  const token = process.env[tokenEnv];
  const get = async (query, bearer) => {
    const response = await fetch(new URL(`/v1/captain/turn-metrics${query}`, base), {
      headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: response.ok ? await response.json() : undefined };
  };
  try {
    const anonymous = await get("", undefined);
    record(
      "http.requires.operator.auth",
      anonymous.status === 401,
      `unauthenticated GET returned ${anonymous.status}`,
    );
    const authed = await get("", token);
    const list = items(authed.body);
    record(
      "http.items.shape",
      authed.status === 200 && Array.isArray(list),
      `authed GET returned ${authed.status}`,
    );
    record(
      "http.default.limit",
      Array.isArray(list) && list.length === 20,
      `default returned ${list?.length}`,
    );
    record("http.order", Array.isArray(list) && recentFirst(list), "items were not most-recent-first");
    const bounded = await get("?limit=101", token);
    record(
      "http.limit.bounded",
      bounded.status !== 200 || (items(bounded.body)?.length ?? 0) <= 100,
      "limit=101 was neither refused nor bounded to 100",
    );
    const byRun = await get("?runId=run-no-usage", token);
    record(
      "http.run.filter",
      items(byRun.body)?.length === 1 && items(byRun.body)?.[0]?.runId === "run-no-usage",
      `runId filter returned ${JSON.stringify(items(byRun.body)?.map((r) => r.runId))}`,
    );
  } catch (error) {
    record("http.reachable", false, String(error).slice(0, 200));
  }
} else {
  record("http.skipped", true, "no --base offered; CLI surface only");
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `${JSON.stringify({ checks: results.length, failed: failed.length, results }, null, 2)}\n`,
);
if (failed.length > 0) process.exitCode = 1;
