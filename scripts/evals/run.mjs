#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledSkills } from "../../packages/settings/src/bundled-skills.ts";
import { TurnSettledLog } from "../../apps/clankie/src/captain/turn-metrics.ts";
import { cases, smokeCases } from "./cases.mjs";
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
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

export function plan(args) {
  const options = {
    harness: "claude",
    configs: "current",
    cases: "smoke",
    maxRuns: 3,
    timeout: 120,
    rework: 0,
    tokenBudget: 60000,
    model: undefined,
    dryRun: false,
  };
  const flags = {
    "--harness": "harness",
    "--configs": "configs",
    "--cases": "cases",
    "--max-runs": "maxRuns",
    "--timeout": "timeout",
    "--rework": "rework",
    "--token-budget": "tokenBudget",
    "--model": "model",
    "--cli": "cli",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = flags[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--"))
      throw Error(`Unknown or incomplete argument: ${args[i]}`);
    options[key] = ["maxRuns", "timeout", "rework", "tokenBudget"].includes(key)
      ? Number(args[++i])
      : args[++i];
  }
  if (!["claude", "codex"].includes(options.harness)) throw Error("harness must be claude or codex");
  for (const key of ["maxRuns", "timeout", "tokenBudget"])
    if (!Number.isSafeInteger(options[key]) || options[key] < 1)
      throw Error(`${key} must be a positive integer`);
  if (!Number.isSafeInteger(options.rework) || options.rework < 0 || options.rework > 2)
    throw Error("rework must be 0, 1 or 2");
  const selectedConfigs = [...new Set(options.configs.split(","))];
  for (const name of selectedConfigs)
    if (!Object.hasOwn(configurations, name)) throw Error(`Unknown configuration ${name}`);
  const selectedCases =
    options.cases === "all"
      ? cases.map((c) => c.id)
      : options.cases === "smoke"
        ? smokeCases
        : options.cases.split(",");
  for (const id of selectedCases) if (!cases.some((c) => c.id === id)) throw Error(`Unknown case ${id}`);
  const matrix = [...new Set(selectedCases)].flatMap((id) =>
    selectedConfigs.map((config) => ({ caseId: id, config })),
  );
  if (matrix.length > options.maxRuns)
    throw Error(`Matrix needs ${matrix.length} calls; raise --max-runs explicitly (default 3)`);
  return { ...options, matrix };
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
    providerError = null;
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
  return { tokens, answer, model, providerError, toolCalls, toolFailures };
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

export function prepare(root, test, config) {
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  const instructions = readFileSync(join(repo, config.instructions), "utf8");
  // Same classifier as `clankie skills opinionated on|off` and hire_agent's
  // bundled/plain override; unlike workerSkills, copy files and never link state.
  const catalog = bundledSkills(repo, { opinionated: config.skills === "bundled", exclude: [] }).filter(
    (s) => s.included,
  );
  const skills = catalog.map((skill) => {
    const path = join(seed, ".agents", "skills", skill.name);
    cpSync(skill.path, path, { recursive: true, dereference: true });
    return { name: skill.name, class: skill.class, sha256: hash(readFileSync(join(path, "SKILL.md"))) };
  });
  const boundary =
    "This is an offline evaluation fixture. Only this worktree is your project. Do not access any live service, tracker, personal state or other process. Do not delegate. Only finish the requested fixture; no commits, service startup, or external writes. Run local checks if useful.\n";
  const skillCatalog = skills.map((s) => `- ${s.name}: .agents/skills/${s.name}/SKILL.md`).join("\n");
  const guidance = `${boundary}\n${instructions}\n\nAvailable skills (load when useful):\n${skillCatalog}\n`;
  writeFileSync(join(seed, "AGENTS.md"), guidance);
  // Claude receives this exact text explicitly, avoiding automatic discovery differences.
  writeFileSync(join(seed, ".eval-instructions.md"), guidance);
  for (const [name, content] of Object.entries(test.files)) writeFileSync(join(seed, name), content);
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

function invocation(harness, model, root, test, capabilities) {
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
    "--ephemeral",
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

export async function run(options) {
  if (process.platform !== "darwin") throw Error("Eval isolation requires macOS sandbox-exec");
  const binary = executable(options.cli ?? options.harness);
  const help = spawnSync(binary, ["--help"], { encoding: "utf8" }).stdout;
  const capabilities = { safeMode: help.includes("--safe-mode"), effort: help.includes("--effort") };
  const auth = subscriptionAuth(options.harness);
  const campaign = realpathSync(mkdtempSync("/private/tmp/clankie-eval-"));
  const sourceRevision = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
  const report = {
    schemaVersion: 1,
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    sourceRevision,
    suiteSha256: hash(readFileSync(join(repo, "scripts/evals/cases.mjs"))),
    options,
    version,
    cliSha256: hash(readFileSync(binary)),
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
  json(join(campaign, "report.json"), report);
  let calls = 0,
    totalTokens = 0;
  console.log(`Evidence: ${campaign}`);
  for (const cell of options.matrix) {
    let feedback = "";
    for (let attempt = 0; attempt <= options.rework; attempt++) {
      if (calls >= options.maxRuns || totalTokens >= options.tokenBudget) {
        report.stopped = "call or reported-token budget reached";
        break;
      }
      const test = cases.find((c) => c.id === cell.caseId);
      const root = join(campaign, `${cell.caseId}-${cell.config}-${attempt}`);
      mkdirSync(root, { mode: 0o700 });
      let row;
      try {
        installAuth(root, options.harness, auth);
        const condition = prepare(root, test, configurations[cell.config]);
        const prompt = `${test.prompt}\n\nEdit the deliverable files in this worktree. Keep the result small. ${feedback}`;
        writeFileSync(join(root, "prompt.txt"), prompt);
        const args = invocation(options.harness, options.model, root, test, capabilities);
        calls++;
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
        removeAuth(root);
        result.stdout = redact(result.stdout, auth);
        result.stderr = redact(result.stderr, auth);
        writeFileSync(join(root, "events.jsonl"), result.stdout);
        writeFileSync(join(root, "stderr.txt"), result.stderr);
        const parsed = parseEvents(options.harness, result.stdout);
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
          artifactDirectory: root,
        };
        totalTokens += parsed.tokens?.total ?? 0;
        feedback = `Previous attempt failed. Checker feedback:\n${(check.stdout + check.stderr).slice(0, 4000)}\nPrevious answer:\n${parsed.answer.slice(0, 2000)}`;
      } catch (error) {
        row = {
          ...cell,
          attempt,
          rework: attempt,
          harness: options.harness,
          passed: false,
          error: String(error),
          tokens: null,
          artifactDirectory: root,
        };
      } finally {
        removeAuth(root);
      }
      report.results.push(row);
      json(join(campaign, "report.json"), report);
      console.log(
        `${cell.caseId}/${cell.config} attempt ${attempt}: ${row.passed ? "PASS" : "FAIL"} (${row.tokens?.total ?? "unknown"} tokens)`,
      );
      if (row.passed) break;
    }
    if (report.stopped) break;
  }
  report.finishedAt = new Date().toISOString();
  report.totalTokens = totalTokens;
  report.calls = calls;
  report.completedCells = new Set(report.results.map((r) => `${r.caseId}/${r.config}`)).size;
  report.missingCells = options.matrix.filter(
    (c) => !report.results.some((r) => r.caseId === c.caseId && r.config === c.config),
  );
  report.unknownUsage = report.results.filter((r) => r.tokens === null).length;
  json(join(campaign, "report.json"), report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--help")) {
      console.log(
        "node scripts/evals/run.mjs [--harness claude|codex] [--configs current,plain,trimmed] [--cases smoke|all|ID,ID] [--max-runs 3] [--timeout 120] [--rework 0] [--token-budget 60000] [--model NAME] [--cli PATH] [--dry-run]\nDefaults: three current Claude smoke cases; no automatic rework. Budgets count CLI calls, not cases.",
      );
    } else {
      const options = plan(process.argv.slice(2));
      if (options.dryRun) console.log(JSON.stringify(options, null, 2));
      else {
        const report = await run(options);
        if (
          report.missingCells.length ||
          report.results.some(
            (r) =>
              !r.passed &&
              !report.results.some((s) => s.caseId === r.caseId && s.config === r.config && s.passed),
          )
        )
          process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
