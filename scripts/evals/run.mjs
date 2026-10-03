#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundledSkills } from "../../packages/settings/src/bundled-skills.ts";
import { TurnSettledLog } from "../../apps/clankie/src/captain/turn-metrics.ts";
import { cases as publicCases, code, incidentCases, smokeCases, social } from "./cases.mjs";
import {
  cleanEnv,
  executable,
  executeSandbox,
  installAuth,
  removeAuth,
  subscriptionAuth,
} from "./isolation.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configurations = JSON.parse(readFileSync(join(repo, "scripts/evals/configurations.json"), "utf8"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (path, value) => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

// The held-out slice lives in the private clankie-evals-holdout repository,
// mounted at the ignored evals/holdout path. Instruction and skill work never
// sees its cases; reports carry only its hash and IDs.
const heldoutPath = join(repo, "evals", "holdout", "clankie", "cases.mjs");
const heldoutCases = existsSync(heldoutPath)
  ? (await import(pathToFileURL(realpathSync(heldoutPath)).href))
      .default({ code, social })
      .map((c) => ({ ...c, heldout: true }))
  : [];
export const cases = [...publicCases, ...heldoutCases];
export const heldoutSha256 = existsSync(heldoutPath) ? hash(readFileSync(heldoutPath)) : null;

/** "five_hour=0.8,seven_day=0.5" → { five_hour: 0.8, seven_day: 0.5 } */
function thresholds(text) {
  return Object.fromEntries(
    text.split(",").map((pair) => {
      const [window, value] = pair.split("=");
      const limit = Number(value);
      if (!["five_hour", "seven_day"].includes(window) || !(limit > 0 && limit <= 1))
        throw Error(`--stop-at takes five_hour=F,seven_day=F with 0 < F <= 1, not ${pair}`);
      return [window, limit];
    }),
  );
}

/**
 * Subscription guard. A five-hour window past its threshold waits for that
 * window's reset; the weekly window or an actual rate limit stops the run, so
 * the owner's other agents keep the rest of the week.
 */
export function usageGate(rateLimit, stopAt, now = Date.now()) {
  if (!rateLimit) return null;
  const percent = (value) => `${Math.round(value * 100)}%`;
  const weekly = rateLimit.seven_day;
  if (typeof weekly === "number" && weekly >= stopAt.seven_day)
    return { stop: `usage guard: seven_day at ${percent(weekly)} (stop at ${percent(stopAt.seven_day)})` };
  const hourly = rateLimit.five_hour;
  const reset = rateLimit.resets?.five_hour;
  if ((typeof hourly === "number" && hourly >= stopAt.five_hour) || rateLimit.limited) {
    const reason = rateLimit.limited ? "rate limited" : `five_hour at ${percent(hourly)}`;
    // Wait only for a known, near reset; an unknown one stops rather than guesses.
    if (reset && reset * 1000 > now && reset * 1000 - now <= 5 * 3600_000)
      return {
        wait: reset * 1000 - now + 60_000,
        reason: `usage guard: ${reason}; waiting for the five-hour reset`,
      };
    return { stop: `usage guard: ${reason}` };
  }
  return null;
}

export function plan(args) {
  const options = {
    harness: "claude",
    configs: "current",
    cases: "smoke",
    reps: 5,
    maxRuns: 15,
    timeout: 120,
    rework: 0,
    tokenBudget: 2000000,
    pause: 0,
    stopAt: "five_hour=0.8,seven_day=0.5",
    model: undefined,
    dryRun: false,
    concurrency: 1,
  };
  const flags = {
    "--harness": "harness",
    "--configs": "configs",
    "--cases": "cases",
    "--reps": "reps",
    "--max-runs": "maxRuns",
    "--timeout": "timeout",
    "--rework": "rework",
    "--token-budget": "tokenBudget",
    "--pause": "pause",
    "--stop-at": "stopAt",
    "--model": "model",
    "--cli": "cli",
    "--concurrency": "concurrency",
    "--resume": "resume",
    "--accounts": "accounts",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = flags[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--"))
      throw Error(`Unknown or incomplete argument: ${args[i]}`);
    options[key] = ["reps", "maxRuns", "timeout", "rework", "tokenBudget", "pause", "concurrency"].includes(
      key,
    )
      ? Number(args[++i])
      : args[++i];
  }
  if (!["claude", "codex"].includes(options.harness)) throw Error("harness must be claude or codex");
  for (const key of ["reps", "maxRuns", "timeout", "tokenBudget", "concurrency"])
    if (!Number.isSafeInteger(options[key]) || options[key] < 1)
      throw Error(`${key} must be a positive integer`);
  if (!Number.isSafeInteger(options.pause) || options.pause < 0) throw Error("pause must be whole seconds");
  if (options.accounts) {
    const labels = options.accounts.split(",");
    if (
      options.harness !== "codex" ||
      labels.length !== options.concurrency ||
      new Set(labels).size !== labels.length ||
      labels.some((label) => !/^[a-z][a-z0-9_-]{0,63}$/.test(label))
    )
      throw Error("--accounts requires one distinct registered Codex label per concurrency slot");
  }
  const stopAt = thresholds(options.stopAt);
  if (!Number.isSafeInteger(options.rework) || options.rework < 0 || options.rework > 2)
    throw Error("rework must be 0, 1 or 2");
  const selectedConfigs = [...new Set(options.configs.split(","))];
  for (const name of selectedConfigs)
    if (!Object.hasOwn(configurations, name)) throw Error(`Unknown configuration ${name}`);
  const suites = {
    all: publicCases.map((c) => c.id),
    smoke: smokeCases,
    incidents: incidentCases,
    social: publicCases.filter((c) => c.kind === "social").map((c) => c.id),
    code: publicCases.filter((c) => c.kind !== "social").map((c) => c.id),
    heldout: heldoutCases.map((c) => c.id),
  };
  const selectedCases = options.cases.split(",").flatMap((name) => suites[name] ?? [name]);
  if (selectedCases.length === 0) throw Error(`No cases selected by ${options.cases}`);
  for (const id of selectedCases) if (!cases.some((c) => c.id === id)) throw Error(`Unknown case ${id}`);
  // Repetition-major order with arms rotated per cell, so provider drift and
  // rate-limit pressure fall on every arm alike instead of on the last one.
  const unique = [...new Set(selectedCases)];
  const matrix = Array.from({ length: options.reps }, (_, rep) =>
    unique.flatMap((id, index) =>
      selectedConfigs.map((_, slot) => ({
        caseId: id,
        config: selectedConfigs[(slot + rep + index) % selectedConfigs.length],
        rep,
      })),
    ),
  ).flat();
  if (matrix.length > options.maxRuns)
    throw Error(`Matrix needs ${matrix.length} calls; raise --max-runs explicitly (default 15)`);
  return { ...options, stopAt, matrix };
}

export function parseEvents(harness, stdout) {
  const events = stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  let tokens = null,
    answer = "",
    model = null,
    providerError = null,
    rateLimit = null;
  const usage = [];
  let toolCalls = 0,
    toolFailures = 0;
  for (const event of events) {
    if (harness === "codex") {
      if (
        event.type === "item.completed" &&
        ["command_execution", "file_change"].includes(event.item?.type)
      ) {
        toolCalls++;
        if (
          event.item.status === "failed" ||
          (typeof event.item.exit_code === "number" && event.item.exit_code !== 0)
        )
          toolFailures++;
      }
      if (event.type === "turn.completed") {
        providerError = null;
        if (event.usage) usage.push(event.usage);
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message") answer = event.item.text;
      if (event.type === "turn.failed" || event.type === "error")
        providerError = event.error?.message ?? event.message ?? event.type;
    } else {
      if (event.type === "rate_limit_event") rateLimit = claudeRateLimit(event.rate_limit_info);
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") toolCalls++;
        if (block.type === "tool_result" && block.is_error) toolFailures++;
      }
      if (event.type === "system" && event.model) model = event.model;
      if (event.type === "result") {
        if (event.modelUsage && Object.keys(event.modelUsage).length) {
          // Includes auxiliary model calls omitted from some CLI result.usage totals.
          usage.push(
            ...Object.values(event.modelUsage).map((u) => ({
              input_tokens: u.inputTokens,
              output_tokens: u.outputTokens,
              cache_read_input_tokens: u.cacheReadInputTokens,
              cache_creation_input_tokens: u.cacheCreationInputTokens,
            })),
          );
        } else if (event.usage) usage.push(event.usage);
        answer = event.result ?? "";
        if (event.is_error || (event.subtype && event.subtype !== "success"))
          providerError = event.subtype ?? "provider error";
      }
    }
  }
  if (usage.length) {
    tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    for (const u of usage) {
      tokens.input += u.input_tokens ?? 0;
      tokens.output += u.output_tokens ?? 0;
      tokens.cacheRead += u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0;
      tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    }
    // Codex input_tokens already includes cached input. Claude reports separate buckets.
    tokens.total =
      tokens.input + tokens.output + (harness === "claude" ? tokens.cacheRead + tokens.cacheWrite : 0);
  }
  if (providerError && /rate.?limit|usage limit|429|quota/i.test(providerError))
    rateLimit = { ...rateLimit, limited: true };
  return { tokens, answer, model, providerError, toolCalls, toolFailures, rateLimit };
}

/** Claude Code stream-json reports subscription window utilization as 0..1. */
export function claudeRateLimit(info) {
  const windows = info?.unifiedWindows ?? {};
  return {
    five_hour: windows.five_hour?.utilization ?? null,
    seven_day: windows.seven_day?.utilization ?? null,
    resets: {
      five_hour: windows.five_hour?.resetsAt ?? null,
      seven_day: windows.seven_day?.resetsAt ?? null,
    },
    limited: info?.status !== undefined && info.status !== "allowed",
  };
}

/** Codex writes its plan windows into the session rollout, not the exec JSON stream. */
export function codexRateLimit(text) {
  let latest = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      latest = JSON.parse(line).payload?.rate_limits ?? latest;
    } catch {
      /* partial line */
    }
  }
  if (!latest) return null;
  const result = {
    five_hour: null,
    seven_day: null,
    resets: { five_hour: null, seven_day: null },
    limited: Boolean(latest.rate_limit_reached_type),
  };
  for (const window of [latest.primary, latest.secondary]) {
    if (!window) continue;
    const name = window.window_minutes <= 300 ? "five_hour" : "seven_day";
    result[name] = window.used_percent / 100;
    result.resets[name] = window.resets_at ?? null;
  }
  return result;
}

export function readRollouts(dir) {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true })
    .filter((name) => String(name).endsWith(".jsonl"))
    .map((name) => readFileSync(join(dir, String(name)), "utf8"))
    .join("\n");
}

function git(root, args) {
  const result = spawnSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    env: { ...cleanEnv(root), GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw Error(`Isolated git failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function prepare(root, test, config, { boundary: framing, repoRoot = repo } = {}) {
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  // `bare` is the harness alone: no Clankie instructions and no skills.
  // A campaign may pin the text it started with, so a concurrent edit cannot mix arms.
  const instructions =
    config.instructionsText ??
    (config.instructions ? readFileSync(join(repo, config.instructions), "utf8") : "");
  // Same classifier as `clankie skills opinionated on|off` and hire_agent's
  // bundled/plain override; unlike workerSkills, copy files and never link state.
  const catalog =
    config.skills === "none"
      ? []
      : bundledSkills(repoRoot, { opinionated: config.skills === "bundled", exclude: [] }).filter(
          (s) => s.included,
        );
  const skills = catalog.map((skill) => {
    const path = join(seed, ".agents", "skills", skill.name);
    cpSync(skill.path, path, { recursive: true, dereference: true });
    return { name: skill.name, class: skill.class, sha256: hash(readFileSync(join(path, "SKILL.md"))) };
  });
  const boundary =
    framing ??
    "This is an offline evaluation fixture. Only this worktree is your project. Do not access any live service, tracker, personal state or other process. Do not delegate. Only finish the requested fixture; no commits, service startup, or external writes. Run local checks if useful.\n";
  const skillCatalog = skills.map((s) => `- ${s.name}: .agents/skills/${s.name}/SKILL.md`).join("\n");
  const guidance = [
    boundary,
    instructions,
    skills.length ? `\nAvailable skills (load when useful):\n${skillCatalog}\n` : "",
  ].join("\n");
  writeFileSync(join(seed, "AGENTS.md"), guidance);
  // Claude receives this exact text explicitly, avoiding automatic discovery differences.
  writeFileSync(join(seed, ".eval-instructions.md"), guidance);
  for (const [name, content] of Object.entries(test.files)) {
    mkdirSync(dirname(join(seed, name)), { recursive: true });
    writeFileSync(join(seed, name), content);
  }
  if (test.image) cpSync(join(repo, "scripts/evals/image.png"), join(seed, "image.png"));
  git(seed, ["init", "-q"]);
  git(seed, ["add", "."]);
  git(seed, [
    "-c",
    "user.name=Clankie Eval",
    "-c",
    "user.email=eval@invalid",
    "commit",
    "-qm",
    "Versioned evaluation fixture",
  ]);
  git(seed, ["worktree", "add", "--detach", join(root, "worktree"), "HEAD"]);
  return {
    instructionsSha256: hash(instructions),
    skills,
    fixtureRevision: git(seed, ["rev-parse", "HEAD"]),
  };
}

export function invocation(harness, model, root, test, capabilities) {
  if (harness === "claude")
    return [
      "-p",
      ...(capabilities.safeMode ? ["--safe-mode"] : []),
      "--append-system-prompt",
      readFileSync(join(root, "worktree", ".eval-instructions.md"), "utf8"),
      "--verbose",
      "--output-format",
      "stream-json",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--settings",
      '{"disableAllHooks":true}',
      "--no-session-persistence",
      "--tools",
      "Read,Edit,Write,Bash,Glob,Grep",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "8",
      ...(capabilities.effort ? ["--effort", "low"] : []),
      ...(model ? ["--model", model] : []),
    ];
  return [
    "exec",
    "--json",
    // No --ephemeral: the private home keeps the rollout, whose rate_limits
    // drive the usage guard. The home is deleted after every attempt.
    "--ignore-user-config",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox", // The outer OS sandbox owns isolation.
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    "features.multi_agent=false",
    "-c",
    'shell_environment_policy.inherit="all"',
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    'web_search="disabled"',
    ...(model ? ["--model", model] : []),
    ...(test.image ? ["--image", join(root, "worktree", "image.png")] : []),
    "-",
  ];
}

export async function judge(root, test) {
  const check = `import assert from 'node:assert/strict';\nimport {readFile} from 'node:fs/promises';\n${test.check}\nconsole.log('PASS');\n`;
  // Written only after the model exits. Model edits cannot weaken the oracle.
  // Unlink first: an untrusted model may have left a symlink at this name.
  rmSync(join(root, "worktree", ".eval-check.mjs"), { force: true, recursive: true });
  writeFileSync(join(root, "worktree", ".eval-check.mjs"), check, { flag: "wx" });
  return await executeSandbox({
    root,
    binary: process.execPath,
    args: [".eval-check.mjs"],
    timeoutMs: 10000,
    network: false,
  });
}

function redact(text, auth) {
  // Provider events should contain no credentials, but do not rely on that.
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string" && value.length > 24) strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(JSON.parse(auth));
  for (const secret of strings) text = text.replaceAll(secret, "[REDACTED]");
  return text;
}

// Hash dereferenced support files too: SKILL.md alone does not identify a skill.
function contentTree(path) {
  const stat = statSync(path);
  if (stat.isDirectory())
    return readdirSync(path)
      .sort()
      .map((name) => [name, contentTree(join(path, name))]);
  if (!stat.isFile()) throw Error(`Unsupported campaign input: ${path}`);
  return { sha256: hash(readFileSync(path)), executable: Boolean(stat.mode & 0o111) };
}

export function campaignInputs(options, { repoRoot = repo, selectedCases = cases } = {}) {
  const definitions = JSON.parse(readFileSync(join(repoRoot, "scripts/evals/configurations.json"), "utf8"));
  return {
    configurations: [...new Set(options.matrix.map((cell) => cell.config))].sort().map((name) => {
      const definition = definitions[name];
      const skills =
        definition.skills === "none"
          ? []
          : bundledSkills(repoRoot, { opinionated: definition.skills === "bundled", exclude: [] }).filter(
              (skill) => skill.included,
            );
      return {
        name,
        definition,
        instructionsSha256: hash(
          definition.instructions ? readFileSync(join(repoRoot, definition.instructions)) : "",
        ),
        skills: skills.map((skill) => ({
          name: skill.name,
          class: skill.class,
          content: contentTree(skill.path),
        })),
      };
    }),
    imageSha256: options.matrix.some((cell) => selectedCases.find((test) => test.id === cell.caseId)?.image)
      ? hash(readFileSync(join(repoRoot, "scripts/evals/image.png")))
      : null,
  };
}

export function validateCampaignIdentity(previous, inputs, cliSha256, version) {
  // Legacy row conditions hash only SKILL.md, not its supporting files. They
  // cannot establish exact input identity; retain their evidence without resuming.
  if (!previous.inputs)
    throw Error(
      "--resume cannot establish input identity for this legacy report; keep its evidence and start a separately authorized campaign",
    );
  if (JSON.stringify(previous.inputs) !== JSON.stringify(inputs))
    throw Error("--resume campaign inputs changed (configuration, instructions, skills or image)");
  if (previous.cliSha256 !== cliSha256 || previous.version !== version)
    throw Error("--resume requires the same harness binary and version");
}

// The account-selecting entry point must reject incompatible evidence before
// selecting/probing an account. run() repeats this check at its own boundary.
export function preflightResumeInputs(options) {
  if (!options.resume) return;
  const previous = JSON.parse(readFileSync(join(options.resume, "report.json"), "utf8"));
  if (!previous.inputs) validateCampaignIdentity(previous, null, null, null);
  validateResume(
    previous,
    { ...options, account: previous.options.account },
    hash(readFileSync(join(repo, "scripts/evals/cases.mjs"))),
  );
  const binary = executable(options.cli ?? options.harness);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
  validateCampaignIdentity(previous, campaignInputs(options), hash(readFileSync(binary)), version);
}

export function validateResume(previous, options, suiteSha256) {
  for (const key of [
    "harness",
    "matrix",
    "model",
    "timeout",
    "cli",
    "rework",
    "maxRuns",
    "tokenBudget",
    "stopAt",
    "accounts",
    "account",
  ]) {
    if (JSON.stringify(previous.options[key]) !== JSON.stringify(options[key]))
      throw Error(`--resume needs the same ${key} as the campaign it continues`);
  }
  if (previous.suiteSha256 !== suiteSha256 || previous.heldoutSha256 !== heldoutSha256)
    throw Error("--resume needs the same suite and heldout cases");
}

const sameCell = (a, b) => a.caseId === b.caseId && a.config === b.config && a.rep === b.rep;
export const completedCell = (report, cell, rework) =>
  report.results.some((r) => sameCell(r, cell) && (r.passed || r.attempt >= rework));

/** Reservations and guard updates happen synchronously between awaits across every slot. */
export async function schedule(options, report, attemptCell, save = () => {}, slots = [{}]) {
  report.calls ??= report.results.length;
  report.totalTokens = report.results.reduce((total, row) => total + (row.tokens?.total ?? 0), 0);
  const queue = options.matrix.filter((cell) => !completedCell(report, cell, options.rework));
  const workers = Array.from({ length: options.concurrency }, async (_, index) => {
    const slot = slots[index % slots.length];
    while (queue.length && !report.stopped) {
      const cell = queue.shift();
      const prior = report.results.filter((r) => sameCell(r, cell));
      let feedback = prior.at(-1)?.feedback ?? "";
      for (
        let attempt = prior.length ? Math.max(...prior.map((r) => r.attempt)) + 1 : 0;
        attempt <= options.rework;
        attempt++
      ) {
        if (options.pause && report.calls)
          await new Promise((done) => setTimeout(done, options.pause * 1000));
        if (report.stopped) break;
        if (report.calls >= options.maxRuns || report.totalTokens >= options.tokenBudget) {
          report.stopped = "call or reported-token budget reached";
          save();
          break;
        }
        // Persist before launch: even interrupted calls consume the campaign call budget.
        report.calls++;
        save();
        const row = await attemptCell(cell, attempt, feedback, slot);
        report.results.push(row);
        report.totalTokens += row.tokens?.total ?? 0;
        feedback = row.feedback ?? "";
        const gate = usageGate(row.rateLimit, options.stopAt);
        // Stop the entire campaign; never rotate to another account or auto-launch after reset.
        if (gate) report.stopped = gate.stop ?? `${gate.reason}; resume explicitly after reset`;
        save();
        if (row.passed || report.stopped) break;
      }
    }
  });
  await Promise.all(workers);
}

export async function run(options) {
  if (process.platform !== "darwin") throw Error("Eval isolation requires macOS sandbox-exec");
  const binary = executable(options.cli ?? options.harness);
  const help = spawnSync(binary, ["--help"], { encoding: "utf8" }).stdout;
  const capabilities = { safeMode: help.includes("--safe-mode"), effort: help.includes("--effort") };
  const campaign = realpathSync(options.resume ?? mkdtempSync("/private/tmp/clankie-eval-"));
  const previous = options.resume ? JSON.parse(readFileSync(join(campaign, "report.json"), "utf8")) : null;
  const suiteSha256 = hash(readFileSync(join(repo, "scripts/evals/cases.mjs")));
  if (previous) validateResume(previous, options, suiteSha256);
  const inputs = campaignInputs(options);
  const cliSha256 = hash(readFileSync(binary));
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
  if (previous) validateCampaignIdentity(previous, inputs, cliSha256, version);
  let slots;
  if (options.accounts) {
    const { codexAccounts, selectLiveCodexAccount } =
      await import("../../packages/settings/src/codex-accounts.ts");
    const registry = codexAccounts();
    slots = [];
    for (const label of options.accounts.split(",")) {
      const account = await selectLiveCodexAccount(registry, label);
      const age = account.observedAt === null ? Infinity : Date.now() - Date.parse(account.observedAt);
      const rate = age >= -60_000 && age <= 24 * 3600_000 ? structuredClone(account.rateLimits) : null;
      if (rate) {
        for (const window of ["five_hour", "seven_day"]) {
          if (rate.resets[window] !== null && rate.resets[window] * 1000 <= Date.now()) rate[window] = 0;
        }
        if (account.headroom > 0) rate.limited = false;
      }
      const gate = usageGate(rate, options.stopAt);
      if (gate) throw Error(gate.stop ?? `${gate.reason}; resume explicitly after reset`);
      slots.push({ label, auth: subscriptionAuth("codex", account.home) });
    }
  } else slots = [{ label: options.account?.label, auth: subscriptionAuth(options.harness) }];
  const sourceRevision = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  const report = previous ?? {
    schemaVersion: 1,
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    sourceRevision,
    suiteSha256: hash(readFileSync(join(repo, "scripts/evals/cases.mjs"))),
    heldoutSha256,
    options,
    version,
    cliSha256,
    inputs,
    runnerSha256: hash(
      ["run.mjs", "isolation.mjs", "configurations.json"]
        .map((name) => readFileSync(join(repo, "scripts/evals", name), "utf8"))
        .join("\n"),
    ),
    capabilities,
    isolation:
      "macOS sandbox-exec; independent fixture git repository and worktree per attempt; fresh HOME; subscription OAuth copies only",
    results: [],
    stopped: null,
  };
  if (previous) {
    report.stopped = null;
    delete report.finishedAt;
    report.resumes = [
      ...(report.resumes ?? []),
      {
        at: new Date().toISOString(),
        sourceRevision,
        version,
        runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
        concurrency: options.concurrency,
        pause: options.pause,
      },
    ];
  }
  const save = () => json(join(campaign, "report.json"), report);
  save();
  console.log(`Evidence: ${campaign}`);
  await schedule(
    options,
    report,
    async (cell, attempt, feedback, slot) => {
      const auth = slot.auth;
      const test = cases.find((c) => c.id === cell.caseId);
      const root = join(campaign, `${cell.caseId}-${cell.config}-r${cell.rep}-${attempt}-${randomUUID()}`);
      mkdirSync(root, { mode: 0o700 });
      let row;
      try {
        validateCampaignIdentity(report, campaignInputs(options), hash(readFileSync(binary)), version);
        const definition = inputs.configurations.find((config) => config.name === cell.config).definition;
        const condition = prepare(root, test, definition);
        // Refuse edits that occurred while copying the selected inputs as well.
        validateCampaignIdentity(report, campaignInputs(options), hash(readFileSync(binary)), version);
        installAuth(root, options.harness, auth);
        const prompt = `${test.prompt}\n\nEdit the deliverable files in this worktree. Keep the result small. ${feedback}`;
        writeFileSync(join(root, "prompt.txt"), prompt);
        const args = invocation(options.harness, options.model, root, test, capabilities);
        const result = await executeSandbox({
          root,
          binary,
          args,
          input: prompt,
          timeoutMs: options.timeout * 1000,
        });
        // Remove credentials before executing generated code in the checker.
        const settledPath = join(root, "home", ".clankie", "captain", "turn-settled.jsonl");
        const settled =
          existsSync(settledPath) && realpathSync(settledPath).startsWith(`${root}/`)
            ? await new TurnSettledLog(settledPath).read({ limit: 100 })
            : [];
        const rollouts =
          options.harness === "codex" ? readRollouts(join(root, "home", ".codex", "sessions")) : "";
        removeAuth(root);
        result.stdout = redact(result.stdout, auth);
        result.stderr = redact(result.stderr, auth);
        writeFileSync(join(root, "events.jsonl"), result.stdout);
        writeFileSync(join(root, "stderr.txt"), result.stderr);
        const parsed = parseEvents(options.harness, result.stdout);
        if (options.harness === "codex") {
          parsed.rateLimit = codexRateLimit(rollouts) ?? parsed.rateLimit;
          parsed.model ??=
            rollouts.match(/"type":"turn_context","payload":\{[^\n]*?"model":"([^"]+)"/)?.[1] ?? null;
        }
        const check = await judge(root, test);
        const passed =
          result.exitCode === 0 &&
          !result.timedOut &&
          !result.overflow &&
          !parsed.providerError &&
          check.exitCode === 0 &&
          check.stdout.trim().endsWith("PASS");
        writeFileSync(join(root, "check.txt"), redact(check.stdout + check.stderr, auth));
        row = {
          ...cell,
          attempt,
          rework: attempt,
          harness: options.harness,
          model: parsed.model ?? options.model ?? "CLI default (not reported)",
          source: test.source,
          kind: test.kind,
          ...(test.incident ? { incident: test.incident } : {}),
          ...(test.heldout ? { heldout: true } : {}),
          condition,
          passed,
          wallMs: result.wallMs,
          tokens: parsed.tokens,
          toolCalls: parsed.toolCalls,
          toolFailures: parsed.toolFailures,
          metricsSource: settled.length
            ? "isolated turn-settled.jsonl + CLI"
            : "CLI events (no service turn)",
          settled,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          providerError: parsed.providerError,
          checkExitCode: check.exitCode,
          rateLimit: parsed.rateLimit,
          artifactDirectory: root,
        };
        feedback = `Previous attempt failed. Checker feedback:\n${(check.stdout + check.stderr).slice(0, 4000)}\nPrevious answer:\n${parsed.answer.slice(0, 2000)}`;
      } catch (error) {
        if (/campaign inputs changed|same harness binary/.test(String(error))) report.stopped = String(error);
        row = {
          ...cell,
          attempt,
          rework: attempt,
          harness: options.harness,
          kind: test.kind,
          ...(test.heldout ? { heldout: true } : {}),
          passed: false,
          error: String(error),
          tokens: null,
          artifactDirectory: root,
        };
      } finally {
        removeAuth(root);
      }
      row.feedback = redact(feedback, auth);
      if (slot.label) row.account = slot.label;
      console.log(
        `${cell.caseId}/${cell.config} rep ${cell.rep} attempt ${attempt}: ${row.passed ? "PASS" : "FAIL"} (${row.tokens?.total ?? "unknown"} tokens)`,
      );
      return row;
    },
    save,
    slots,
  );
  report.finishedAt = new Date().toISOString();
  report.completedCells = options.matrix.filter((cell) => completedCell(report, cell, options.rework)).length;
  report.missingCells = options.matrix.filter((c) => !completedCell(report, c, options.rework));
  report.unknownUsage = report.results.filter((r) => r.tokens === null).length;
  json(join(campaign, "report.json"), report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--help")) {
      console.log(
        "node scripts/evals/run.mjs [--harness claude|codex] [--configs bare,current,plain,trimmed] [--cases smoke|all|incidents|social|code|heldout|ID,...] [--reps 5] [--max-runs 15] [--timeout 120] [--rework 0] [--token-budget 2000000] [--pause SECONDS] [--stop-at five_hour=0.8,seven_day=0.5] [--model NAME] [--cli PATH] [--concurrency N] [--resume CAMPAIGN_DIR] [--accounts LABEL,...] [--dry-run]\nDefaults: three smoke cases, current arm, five reps; no automatic rework. Budgets count CLI calls, not cases. The run stops when the subscription's reported usage reaches --stop-at.",
      );
    } else {
      const options = plan(process.argv.slice(2));
      if (options.dryRun) console.log(JSON.stringify(options, null, 2));
      else {
        const report = await run(options);
        if (
          report.missingCells.length ||
          report.results.some((r) => !r.passed && !report.results.some((s) => sameCell(s, r) && s.passed))
        )
          process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
