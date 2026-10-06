#!/usr/bin/env node
/**
 * Terminal-Bench through Harbor, its official harness: the unmodified Claude
 * Code or Codex CLI runs inside each task's container on the owner's
 * subscription, with or without the Clankie layer (instructions and skills).
 * Results use run.mjs's report schema so report.mjs compares both suites.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledSkills } from "../../packages/settings/src/bundled-skills.ts";
import { executable, subscriptionAuth } from "./isolation.mjs";
import { claudeRateLimit, codexRateLimit, readRollouts, usageGate } from "./run.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configurations = JSON.parse(readFileSync(join(repo, "scripts/evals/configurations.json"), "utf8"));
const taskSets = JSON.parse(readFileSync(join(repo, "scripts/evals/benchmark-tasks.json"), "utf8"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

export function plan(args) {
  const options = {
    harness: "claude",
    configs: "bare,current",
    dataset: "terminal-bench/terminal-bench-2-1",
    tasks: "ab",
    reps: 5,
    maxTrials: 10,
    concurrency: 1,
    setupTimeoutMultiplier: 3,
    resume: undefined,
    model: undefined,
    agentVersion: undefined,
    stopAt: "five_hour=0.8,seven_day=0.5",
    harbor: "harbor",
    dryRun: false,
  };
  const flags = {
    "--harness": "harness",
    "--configs": "configs",
    "--dataset": "dataset",
    "--tasks": "tasks",
    "--reps": "reps",
    "--max-trials": "maxTrials",
    "--concurrency": "concurrency",
    "--setup-timeout-multiplier": "setupTimeoutMultiplier",
    "--resume": "resume",
    "--model": "model",
    "--agent-version": "agentVersion",
    "--stop-at": "stopAt",
    "--harbor": "harbor",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = flags[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--"))
      throw Error(`Unknown or incomplete argument: ${args[i]}`);
    options[key] = ["reps", "maxTrials", "concurrency", "setupTimeoutMultiplier"].includes(key)
      ? Number(args[++i])
      : args[++i];
  }
  if (!["claude", "codex"].includes(options.harness)) throw Error("harness must be claude or codex");
  for (const key of ["reps", "maxTrials", "concurrency"])
    if (!Number.isSafeInteger(options[key]) || options[key] < 1)
      throw Error(`${key} must be a positive integer`);
  // Subscriptions, not a cluster: more than a few containers at once is a burst.
  if (options.concurrency > 3) throw Error("concurrency above 3 is not a subscription-friendly run");
  if (!(options.setupTimeoutMultiplier >= 1)) throw Error("setup timeout multiplier must be at least 1");
  const stopAt = Object.fromEntries(
    options.stopAt.split(",").map((pair) => {
      const [window, value] = pair.split("=");
      if (!["five_hour", "seven_day"].includes(window) || !(Number(value) > 0 && Number(value) <= 1))
        throw Error(`--stop-at takes five_hour=F,seven_day=F, not ${pair}`);
      return [window, Number(value)];
    }),
  );
  const configs = [...new Set(options.configs.split(","))];
  for (const name of configs)
    if (!Object.hasOwn(configurations, name)) throw Error(`Unknown configuration ${name}`);
  const named = taskSets[options.dataset]?.[options.tasks];
  const tasks = Array.isArray(named) ? named : options.tasks.split(",");
  const matrix = Array.from({ length: options.reps }, (_, rep) =>
    tasks.flatMap((task, index) =>
      configs.map((_, slot) => ({ task, config: configs[(slot + rep + index) % configs.length], rep })),
    ),
  ).flat();
  if (matrix.length > options.maxTrials)
    throw Error(`Matrix needs ${matrix.length} trials; raise --max-trials explicitly (default 10)`);
  return { ...options, stopAt, tasks, matrix };
}

/** The same Clankie layer run.mjs gives its fixtures, as Harbor agent settings. */
export function layer(harness, config, skillRoot) {
  const instructions = config.instructions ? readFileSync(join(repo, config.instructions), "utf8") : "";
  const skills =
    config.skills === "none"
      ? []
      : bundledSkills(repo).map((skill) => {
          // Copies, never links: the container sees files, not the checkout.
          const path = join(skillRoot, skill.name);
          if (!existsSync(path)) cpSync(skill.path, path, { recursive: true, dereference: true });
          return { name: skill.name, path };
        });
  const kwargs = {};
  if (instructions && harness === "claude") kwargs.append_system_prompt = instructions;
  if (instructions && harness === "codex") kwargs.config = { developer_instructions: instructions };
  return {
    kwargs,
    skills,
    condition: {
      instructionsSha256: instructions ? hash(instructions) : null,
      skills: skills.map((s) => ({
        name: s.name,
        sha256: hash(readFileSync(join(s.path, "SKILL.md"))),
      })),
    },
  };
}

/** Harbor trial result → run.mjs report row. */
export function trialRow(result, agentLog, harness) {
  const agent = result.agent_result ?? {};
  const elapsed = (span) =>
    span?.started_at && span?.finished_at ? Date.parse(span.finished_at) - Date.parse(span.started_at) : null;
  const reward = result.verifier_result?.rewards?.reward ?? null;
  const reported = agent.n_input_tokens || agent.n_output_tokens;
  // Harbor's input count already includes cached input; cache is a subset.
  const tokens = reported
    ? {
        input: agent.n_input_tokens ?? 0,
        output: agent.n_output_tokens ?? 0,
        cacheRead: agent.n_cache_tokens ?? 0,
        cacheWrite: 0,
        total: (agent.n_input_tokens ?? 0) + (agent.n_output_tokens ?? 0),
      }
    : null;
  let rateLimit = null;
  if (harness === "claude")
    for (const line of agentLog.split("\n")) {
      if (!line.includes('"rate_limit_event"')) continue;
      try {
        rateLimit = claudeRateLimit(JSON.parse(line).rate_limit_info);
      } catch {
        /* partial line */
      }
    }
  else rateLimit = codexRateLimit(agentLog);
  const error = result.exception_info
    ? `${result.exception_info.exception_type}: ${String(result.exception_info.exception_message).slice(0, 300)}`
    : null;
  if (error && /rate.?limit|usage limit|429|quota/i.test(error)) rateLimit = { ...rateLimit, limited: true };
  // The container or CLI install failed before the model ran: not a task result.
  const infrastructure = Boolean(
    result.exception_info &&
    /AgentSetup|Environment|Docker|ImagePull|Build/i.test(result.exception_info.exception_type),
  );
  return {
    passed: reward !== null && reward >= 1,
    ...(infrastructure ? { infrastructure } : {}),
    reward,
    // Agent time is the model's work; setup under emulation is reported apart.
    wallMs: elapsed(result.agent_execution),
    setupMs: elapsed(result.agent_setup),
    trialMs: elapsed(result),
    tokens,
    model: result.agent_info?.model_info?.name ?? null,
    agentVersion: result.agent_info?.version ?? null,
    taskRef: result.task_id?.ref ?? null,
    taskChecksum: result.task_checksum ?? null,
    error,
    rateLimit,
  };
}

function harborRun(binary, args, env) {
  return new Promise((done) => {
    const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => (output = (output + data).slice(-20000)));
    child.stderr.on("data", (data) => (output = (output + data).slice(-20000)));
    child.on("close", (exitCode) => done({ exitCode, output }));
    child.on("error", (error) => done({ exitCode: null, output: String(error) }));
  });
}

function trialFiles(jobDir) {
  const trial = existsSync(jobDir)
    ? readdirSync(jobDir, { withFileTypes: true }).find((entry) => entry.isDirectory())
    : undefined;
  if (!trial) return null;
  const dir = join(jobDir, trial.name);
  if (!existsSync(join(dir, "result.json"))) return null;
  const agentDir = join(dir, "agent");
  const log = existsSync(join(agentDir, "claude-code.txt"))
    ? readFileSync(join(agentDir, "claude-code.txt"), "utf8")
    : readRollouts(agentDir);
  return { dir, result: JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), log };
}

async function run(options) {
  const harbor = options.harbor.includes("/") ? realpathSync(options.harbor) : executable(options.harbor);
  const harborVersion = spawnSync(harbor, ["--version"], { encoding: "utf8" }).stdout.trim();
  const agentVersion =
    options.agentVersion ??
    spawnSync(executable(options.harness), ["--version"], { encoding: "utf8" }).stdout.match(
      /\d+\.\d+\.\d+/,
    )?.[0];
  if (!agentVersion) throw Error("Pin --agent-version; the local CLI version is unreadable");
  const campaign = realpathSync(options.resume ?? mkdtempSync("/private/tmp/clankie-bench-"));
  const secrets = join(campaign, "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const previous = options.resume ? JSON.parse(readFileSync(join(campaign, "report.json"), "utf8")) : null;
  if (previous && JSON.stringify(previous.options.matrix) !== JSON.stringify(options.matrix))
    throw Error("--resume needs the same arguments as the campaign it continues");
  const report = previous ?? {
    schemaVersion: 1,
    id: randomUUID(),
    kind: "benchmark",
    startedAt: new Date().toISOString(),
    sourceRevision: spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim(),
    suiteSha256: hash(JSON.stringify({ dataset: options.dataset, tasks: options.tasks })),
    options,
    version: agentVersion,
    harborVersion,
    runnerSha256: hash(
      ["benchmark.mjs", "configurations.json", "benchmark-tasks.json"]
        .map((name) => readFileSync(join(repo, "scripts/evals", name), "utf8"))
        .join("\n"),
    ),
    isolation:
      "Harbor Docker container per trial; unmodified CLI installed at the pinned version; subscription credential in the trial environment only; campaign HOME private",
    results: [],
    stopped: null,
  };
  if (previous) {
    // A resumed campaign keeps its identity; the runner hash may change, so record it.
    report.stopped = null;
    delete report.finishedAt;
    report.resumes = [
      ...(report.resumes ?? []),
      { at: new Date().toISOString(), runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))) },
    ];
  }
  json(join(campaign, "report.json"), report);
  console.log(`Evidence: ${campaign}`);
  const layers = Object.fromEntries(
    [...new Set(options.matrix.map((cell) => cell.config))].map((name) => {
      const root = join(campaign, "skills", name);
      mkdirSync(root, { recursive: true });
      return [name, layer(options.harness, configurations[name], root)];
    }),
  );
  let waitUntil = 0;
  const done = (cell) =>
    report.results.some(
      (r) =>
        !r.infrastructure &&
        r.caseId.endsWith(`/${cell.task}`) &&
        r.config === cell.config &&
        r.rep === cell.rep,
    );
  const queue = options.matrix.filter((cell) => !done(cell)).map((cell) => ({ ...cell, retries: 0 }));
  const worker = async () => {
    while (queue.length && !report.stopped) {
      if (Date.now() < waitUntil) {
        await new Promise((done) => setTimeout(done, waitUntil - Date.now()));
        continue;
      }
      const cell = queue.shift();
      // Unique per attempt: a resumed or requeued cell never reuses a job directory.
      const name = `${cell.task}-${cell.config}-r${cell.rep}-${Date.now().toString(36)}`;
      const { kwargs, skills, condition } = layers[cell.config];
      const configPath = join(campaign, `${name}.json`);
      json(configPath, {
        agents: [
          {
            name: options.harness === "claude" ? "claude-code" : "codex",
            ...(options.model
              ? { model_name: `${options.harness === "claude" ? "anthropic" : "openai"}/${options.model}` }
              : {}),
            skills: skills.map((s) => s.path),
            kwargs: { version: agentVersion, ...kwargs },
          },
        ],
      });
      const env = {
        PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: join(campaign, "home"),
        // Docker Desktop resolves its socket through the owner's CLI config.
        DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"),
        LANG: "en_US.UTF-8",
      };
      // Read per trial: owner sessions refresh the short-lived access token.
      const auth = JSON.parse(subscriptionAuth(options.harness));
      if (options.harness === "claude") {
        env.CLAUDE_CODE_OAUTH_TOKEN = auth.claudeAiOauth.accessToken;
        env.CLAUDE_FORCE_OAUTH = "1";
      } else {
        env.CODEX_AUTH_JSON_PATH = join(secrets, `${name}.json`);
        env.CODEX_FORCE_AUTH_JSON = "1";
        writeFileSync(env.CODEX_AUTH_JSON_PATH, JSON.stringify(auth), { mode: 0o600 });
      }
      const task = cell.task.includes("/") ? cell.task : `${options.dataset.split("/")[0]}/${cell.task}`;
      const outcome = await harborRun(
        harbor,
        ["run", "-c", configPath, "-d", options.dataset, "-i", task, "-k", "1", "-n", "1"].concat([
          // Emulated amd64 images install the CLI slowly; setup is not the task.
          "--agent-setup-timeout-multiplier",
          String(options.setupTimeoutMultiplier),
          "-o",
          join(campaign, "jobs"),
          "--job-name",
          name,
          "-y",
          "-q",
        ]),
        env,
      );
      if (env.CODEX_AUTH_JSON_PATH) rmSync(env.CODEX_AUTH_JSON_PATH, { force: true });
      const files = trialFiles(join(campaign, "jobs", name));
      const parsed = files
        ? trialRow(files.result, files.log, options.harness)
        : {
            passed: false,
            infrastructure: true,
            tokens: null,
            error: `harbor exit ${outcome.exitCode}: ${outcome.output.slice(-600)}`,
          };
      const row = {
        caseId: task,
        config: cell.config,
        rep: cell.rep,
        attempt: 0,
        harness: options.harness,
        kind: "benchmark",
        source: options.dataset,
        condition,
        ...parsed,
        model: parsed.model ?? options.model ?? "CLI default (not reported)",
        artifactDirectory: files?.dir ?? join(campaign, "jobs", name),
      };
      report.results.push(row);
      json(join(campaign, "report.json"), report);
      // Infrastructure failures are retried and never scored as the agent's.
      if (row.infrastructure && cell.retries < 2) queue.push({ ...cell, retries: cell.retries + 1 });
      console.log(
        `${task}/${cell.config} rep ${cell.rep}: ${row.infrastructure ? "INFRA" : row.passed ? "PASS" : "FAIL"} (${row.tokens?.total ?? "unknown"} tokens${row.error ? `; ${row.error.slice(0, 120)}` : ""})`,
      );
      const gate = usageGate(row.rateLimit, options.stopAt);
      if (gate?.stop) report.stopped = gate.stop;
      if (gate?.wait) {
        console.log(gate.reason);
        waitUntil = Math.max(waitUntil, Date.now() + gate.wait);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: options.concurrency }, worker));
  } finally {
    rmSync(secrets, { recursive: true, force: true });
    rmSync(join(campaign, "home"), { recursive: true, force: true });
  }
  report.finishedAt = new Date().toISOString();
  report.calls = report.results.length;
  report.infrastructureErrors = report.results.filter((r) => r.infrastructure).length;
  report.totalTokens = report.results.reduce((sum, r) => sum + (r.tokens?.total ?? 0), 0);
  report.unknownUsage = report.results.filter((r) => r.tokens === null).length;
  report.missingCells = options.matrix.filter(
    (c) =>
      !report.results.some(
        (r) =>
          !r.infrastructure && r.caseId.endsWith(`/${c.task}`) && r.config === c.config && r.rep === c.rep,
      ),
  );
  json(join(campaign, "report.json"), report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--help")) {
      console.log(
        "node scripts/evals/benchmark.mjs [--harness claude|codex] [--configs bare,current] [--dataset terminal-bench/terminal-bench-2-1] [--tasks ab|NAME,...] [--reps 5] [--max-trials 10] [--concurrency 1] [--model NAME] [--agent-version X.Y.Z] [--stop-at five_hour=0.8,seven_day=0.5] [--setup-timeout-multiplier 3] [--resume CAMPAIGN_DIR] [--harbor PATH] [--dry-run]\nRuns Terminal-Bench tasks through Harbor on the owner's subscription. Requires Docker and Harbor.",
      );
    } else {
      const options = plan(process.argv.slice(2));
      if (options.dryRun) console.log(JSON.stringify(options, null, 2));
      else {
        const report = await run(options);
        if (report.stopped || report.missingCells.length) process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
