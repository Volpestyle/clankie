#!/usr/bin/env node
/**
 * The seat arm (VUH-1473): the real Claude Code seat plugin, launched from
 * `clankie seat --dry-run`'s own plan, against a throwaway Clankie service
 * (seat-service.mjs), compared with `bare` and `current` on the same machine.
 *
 * Headless `claude -p` cannot receive channel pushes (the bridge only pumps
 * under an interactive development-channel launch, whose warning a person must
 * accept). So this driver plays the bridge's long-poll: it takes the service's
 * real wake or escalation event and hands it over exactly as Claude Code renders
 * a channel event. The seat's answer still goes through the bridge's real
 * `reply` tool to the service. Only Claude Code's own channel rendering is not
 * exercised; the bridge's pump has its own tests.
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executable, executeSandbox, installAuth, removeAuth, subscriptionAuth } from "./isolation.mjs";
import { codexRateLimit, invocation, parseEvents, prepare, readRollouts, usageGate } from "./run.mjs";
import {
  channelText,
  coverageCases,
  EPISODES,
  FLEET,
  ROOMS,
  SEAT_BOUNDARY,
  seatCases,
  wakeContent,
} from "./seat-cases.mjs";
import { startService, writeFleet } from "./seat-service.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configurations = JSON.parse(readFileSync(join(repo, "scripts/evals/configurations.json"), "utf8"));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const ARMS = ["bare", "current", "seat"];
const TOOLS = "Read,Edit,Write,Bash,Glob,Grep,ToolSearch";
const SYSTEM_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/** The fixture repository every arm works in: a Markdown tracker and nothing else. */
const FIXTURE = {
  files: {
    "README.md": "# relay\n\nThe relay forwards the app to this Mac.\n",
    ".clankie/tracking.json": `${JSON.stringify(
      { schemaVersion: 1, backend: "markdown", decidedBy: "owner", decidedAt: "2026-09-01T00:00:00.000Z" },
      null,
      2,
    )}\n`,
  },
};

export function plan(args) {
  const options = {
    harness: "claude",
    configs: ARMS.join(","),
    cases: "all",
    reps: 5,
    maxRuns: 15,
    timeout: 300,
    maxTurns: 20,
    model: undefined,
    pause: 0,
    stopAt: "five_hour=0.8,seven_day=0.5",
    dryRun: false,
  };
  const flags = {
    "--harness": "harness",
    "--configs": "configs",
    "--cases": "cases",
    "--reps": "reps",
    "--max-runs": "maxRuns",
    "--timeout": "timeout",
    "--max-turns": "maxTurns",
    "--model": "model",
    "--pause": "pause",
    "--stop-at": "stopAt",
  };
  const numbers = ["reps", "maxRuns", "timeout", "maxTurns", "pause"];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = flags[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--"))
      throw Error(`Unknown or incomplete argument: ${args[i]}`);
    options[key] = numbers.includes(key) ? Number(args[++i]) : args[++i];
  }
  for (const key of numbers)
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === "pause" ? 0 : 1))
      throw Error(`${key} must be a positive integer`);
  const stopAt = Object.fromEntries(
    options.stopAt.split(",").map((pair) => {
      const [window, value] = pair.split("=");
      if (!["five_hour", "seven_day"].includes(window) || !(Number(value) > 0 && Number(value) <= 1))
        throw Error(`--stop-at takes five_hour=F,seven_day=F, not ${pair}`);
      return [window, Number(value)];
    }),
  );
  const configs = [...new Set(options.configs.split(","))];
  for (const name of configs) if (!ARMS.includes(name)) throw Error(`Unknown arm ${name}`);
  if (!["claude", "codex"].includes(options.harness)) throw Error("harness must be claude or codex");
  // The seat arm is the Claude Code plugin; there is no Codex version of it here.
  if (options.harness === "codex" && configs.includes("seat"))
    throw Error("The seat arm runs only on Claude; run bare,current with --harness codex");
  const selected = options.cases
    .split(",")
    .flatMap((name) =>
      name === "all" ? seatCases.map((c) => c.id) : name === "coverage" ? coverageCases : [name],
    );
  for (const id of selected) if (!seatCases.some((c) => c.id === id)) throw Error(`Unknown case ${id}`);
  const unique = [...new Set(selected)];
  const matrix = Array.from({ length: options.reps }, (_, rep) =>
    unique.flatMap((id, index) =>
      configs.map((_, slot) => ({ caseId: id, config: configs[(slot + rep + index) % configs.length], rep })),
    ),
  ).flat();
  if (matrix.length > options.maxRuns)
    throw Error(`Matrix needs ${matrix.length} calls; raise --max-runs explicitly (default 15)`);
  return { ...options, stopAt, matrix };
}

/** What the model's session and the fakes show happened, for a grader. */
export function observe({ worktree, stdout, discord, herdr, harness = "claude" }) {
  let answer = null;
  try {
    answer = JSON.parse(readFileSync(join(worktree, "answer.json"), "utf8"));
  } catch {
    /* no answer file */
  }
  const workItems = {};
  const dir = join(worktree, ".clankie", "work");
  if (existsSync(dir))
    for (const name of readdirSync(dir))
      if (name.endsWith(".md")) workItems[name] = readFileSync(join(dir, name), "utf8");
  // A reply counts only when the bridge reported the service accepted it.
  const calls = new Map();
  const replies = [];
  const tools = [];
  for (const line of stdout.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use") {
        calls.set(block.id, block);
        tools.push(block.name);
      }
      if (block.type === "tool_result" && calls.get(block.tool_use_id)?.name?.endsWith("__reply")) {
        const content = Array.isArray(block.content)
          ? block.content.map((part) => part.text ?? "").join("")
          : String(block.content ?? "");
        replies.push({
          text: String(calls.get(block.tool_use_id).input?.text ?? ""),
          ok: !block.is_error && content.trim() === "sent",
        });
      }
    }
  }
  return { answer, result: parseEvents(harness, stdout).answer, workItems, replies, tools, discord, herdr };
}

/** Park a bridge-style long-poll so the service treats the seat as present. */
function pollSeat(service, signal) {
  const events = [];
  const loop = (async () => {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${service.url}/v1/seat/events?wait=25000`, {
          headers: { authorization: `Bearer ${service.token}` },
          signal,
        });
        if (response.ok) events.push(...(await response.json()).events);
      } catch {
        if (!signal.aborted) await new Promise((done) => setTimeout(done, 500));
      }
    }
  })();
  return { events, loop };
}

async function mcpCall(service, name, args) {
  const headers = {
    authorization: `Bearer ${service.token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const init = await fetch(`${service.url}/v1/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "eval-driver", version: "1" },
      },
    }),
  });
  const session = init.headers.get("mcp-session-id");
  const response = await fetch(`${service.url}/v1/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  });
  return await response.json();
}

/** Seed memory through the service's own episode door, as a Discord or console turn would. */
async function seedEpisodes(service) {
  for (const episode of EPISODES) {
    const response = await fetch(`${service.url}/v1/memory/captain-episodes`, {
      method: "POST",
      headers: { authorization: `Bearer ${service.captainToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        visibility: "operator_private",
        provenance: {
          characterId: "clankie",
          sessionId: "eval-seed",
          selfAuthored: true,
          rawTranscript: false,
        },
        ...episode,
      }),
    });
    if (!response.ok) throw Error(`Episode seed failed: ${response.status} ${await response.text()}`);
  }
}

function seedRooms(paths) {
  const lanes = join(paths.state, "captain", "lanes");
  mkdirSync(lanes, { recursive: true });
  for (const room of ROOMS)
    writeFileSync(
      join(lanes, `${room.lane}~${encodeURIComponent(room.targetId)}.jsonl`),
      room.entries
        .map(([minutesAgo, kind, text]) =>
          JSON.stringify({
            at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
            kind,
            text,
            targetId: room.targetId,
          }),
        )
        .join("\n") + "\n",
    );
}

/**
 * A clean worktree of HEAD with its own offline install. The service, the
 * `clankie` CLI the plugin calls, the plugin, skills and instructions all come
 * from it, so a sibling's uncommitted edit can neither break nor change a run.
 */
function pinCheckout(campaign) {
  const checkout = join(campaign, "checkout");
  const git = spawnSync("/usr/bin/git", ["worktree", "add", "--detach", "-q", checkout, "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  });
  if (git.status !== 0) throw Error(`git worktree add failed: ${git.stderr}`);
  const install = spawnSync(
    "pnpm",
    ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--reporter", "silent"],
    { cwd: checkout, encoding: "utf8", env: { ...process.env, CI: "1" } },
  );
  if (install.status !== 0) throw Error(`pnpm install in the pinned checkout failed: ${install.stderr}`);
  return {
    path: checkout,
    revision: spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
    }).stdout.trim(),
    remove: () =>
      spawnSync("/usr/bin/git", ["worktree", "remove", "--force", checkout], { cwd: repo, encoding: "utf8" }),
  };
}

/**
 * Pin what `clankie seat` would launch at campaign start: its plan, and a
 * dereferenced copy of the plugin projection (output style, hooks, skills), so
 * a concurrent instruction or skill edit cannot change the seat mid-run.
 */
function pinSeat(campaign, claude, checkout) {
  const pin = join(campaign, "seat-pin");
  mkdirSync(join(pin, "bin"), { recursive: true });
  symlinkSync(join(checkout, "apps/tui/bin/clankie.ts"), join(pin, "bin", "clankie"));
  symlinkSync(claude, join(pin, "bin", "claude"));
  writeFileSync(join(pin, "settings.json"), JSON.stringify({ schemaVersion: 1 }));
  const dry = spawnSync(join(pin, "bin", "clankie"), ["seat", "--dry-run"], {
    cwd: pin,
    env: {
      PATH: `${join(pin, "bin")}:${SYSTEM_PATH}`,
      HOME: join(pin, "home"),
      CLANKIE_SETTINGS_FILE: join(pin, "settings.json"),
      CLANKIE_STATE_HOME: join(pin, "state"),
    },
    encoding: "utf8",
  });
  if (dry.status !== 0) throw Error(`clankie seat --dry-run failed: ${dry.stderr}`);
  const plan = JSON.parse(dry.stdout);
  const plugin = join(pin, "plugin");
  cpSync(plan.plugin.path, plugin, { recursive: true, dereference: true });
  const args = [...plan.args];
  args[args.indexOf("--plugin-dir") + 1] = plugin;
  const sessionIndex = args.indexOf("--session-id");
  args.splice(sessionIndex, 2);
  // Every file's name and text, in a stable order; directories read as nothing.
  const files = (dir) =>
    readdirSync(dir, { recursive: true })
      .map(String)
      .sort()
      .flatMap((name) => {
        try {
          return [`${name}\n${readFileSync(join(dir, name), "utf8")}`];
        } catch {
          return [];
        }
      });
  return {
    args,
    bin: join(pin, "bin"),
    plugin,
    skills: plan.skills.map((s) => s.name),
    pluginSha256: hash(files(plugin).join("\n")),
    outputStyleChars: readFileSync(join(plugin, "output-styles", "clankie.md"), "utf8").length,
  };
}

/** The seat's standing context, measured from the service it talked to. */
async function startupContext(service, pin) {
  const headers = { authorization: `Bearer ${service.token}` };
  const prompt = await (
    await fetch(`${service.url}/v1/captain/prompt?lane=operator&sections=persona,reach,fleet,address,model`, {
      headers,
    })
  ).text();
  const card = await (await fetch(`${service.url}/v1/captain/memory-card?lane=operator`, { headers })).text();
  const init = await fetch(`${service.url}/v1/mcp`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "eval-driver", version: "1" },
      },
    }),
  });
  const tools = await (
    await fetch(`${service.url}/v1/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": init.headers.get("mcp-session-id"),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    })
  ).json();
  const catalog = JSON.stringify(tools.result?.tools ?? []);
  const skillIndex = pin.skills
    .map((name) => {
      const text = readFileSync(join(pin.plugin, "skills", name, "SKILL.md"), "utf8");
      return text.slice(0, text.indexOf("\n---", 3) + 4);
    })
    .join("\n");
  // Characters are exact; tokens are the usual ~4 characters per token estimate.
  const part = (chars) => ({ chars, approxTokens: Math.round(chars / 4) });
  return {
    outputStyle: part(pin.outputStyleChars),
    sessionPrompt: part(prompt.length),
    memoryCard: part(card.length),
    toolCatalog: { ...part(catalog.length), tools: (tools.result?.tools ?? []).length },
    skillIndex: { ...part(skillIndex.length), skills: pin.skills.length },
  };
}

async function attempt(options, cell, campaign, context) {
  const test = seatCases.find((c) => c.id === cell.caseId);
  const root = join(campaign, `${cell.caseId}-${cell.config}-r${cell.rep}`);
  mkdirSync(root, { mode: 0o700 });
  // Under tmp: writable by the sandboxed herdr fake, and not removed with the credential home.
  const fleet = writeFleet(join(root, "tmp", "fleet"), FLEET);
  let service;
  const abort = new AbortController();
  try {
    installAuth(root, options.harness, context.auth);
    const arm =
      cell.config === "seat"
        ? { skills: "none", instructions: null }
        : { ...configurations[cell.config], instructionsText: context.instructions[cell.config] };
    const condition = prepare(root, FIXTURE, arm, {
      boundary: `${SEAT_BOUNDARY}\n`,
      repoRoot: context.checkout.path,
    });
    const guidance = readFileSync(join(root, "worktree", ".eval-instructions.md"), "utf8");
    const env = { PATH: `${fleet.bin}:${SYSTEM_PATH}` };
    let args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--append-system-prompt",
      guidance,
      "--setting-sources",
      "",
      "--tools",
      TOOLS,
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      "--max-turns",
      String(options.maxTurns),
      ...(context.capabilities.effort ? ["--effort", "low"] : []),
      ...(options.model ? ["--model", options.model] : []),
    ];
    // The owner's real herdr drives the live fleet: out of scope for every arm.
    const herdr = spawnSync("/usr/bin/which", ["herdr"], { encoding: "utf8" }).stdout.trim();
    const sandbox = { denyRead: herdr ? [realpathSync(herdr)] : [] };
    let prompt = test.prompt;
    if (options.harness === "codex") {
      // run.mjs's own Codex invocation: the guidance arrives as the worktree's AGENTS.md.
      args = invocation("codex", options.model, root, { image: false }, {});
      // A login shell's path_helper would put the owner's real herdr ahead of the fake.
      args.splice(args.length - 1, 0, "-c", "allow_login_shell=false");
    }
    if (cell.config === "seat") {
      service = await startService(root, { checkout: context.checkout.path, fleet, seed: seedRooms });
      await seedEpisodes(service);
      context.startup ??= await startupContext(service, context.pin);
      const sessionId = randomUUID();
      const settings = join(root, "home", "seat-settings.json");
      writeFileSync(settings, JSON.stringify({ schemaVersion: 1 }));
      Object.assign(env, {
        PATH: `${context.pin.bin}:${fleet.bin}:${SYSTEM_PATH}`,
        CLANKIE_CONTROL_PLANE_URL: service.url,
        CLANKIE_OPERATOR_TOKEN: service.token,
        CLANKIE_SETTINGS_FILE: settings,
        CLANKIE_STATE_HOME: join(root, "home", "state"),
        CLANKIE_SEAT_HARNESS: "claude",
        CLANKIE_SEAT_SESSION_ID: sessionId,
      });
      args = [
        ...context.pin.args,
        "--session-id",
        sessionId,
        ...args.filter((a) => a !== "--no-session-persistence"),
      ];
      Object.assign(sandbox, {
        readTrees: [context.checkout.path, context.pin.plugin],
        // The service's own files stay out of reach: the seat uses its doors.
        denyRead: [...sandbox.denyRead, join(context.checkout.path, "evals"), join(root, "service")],
        loopbackPorts: [service.port],
      });
      if (test.trigger) {
        const seat = pollSeat(service, abort.signal);
        await new Promise((done) => setTimeout(done, 300));
        if (test.trigger.kind === "escalation") {
          spawn(
            join(context.pin.bin, "clankie"),
            ["send", "--conversation", "global-default", test.trigger.text],
            {
              env: {
                PATH: `${context.pin.bin}:${SYSTEM_PATH}`,
                HOME: join(root, "home"),
                CLANKIE_CONTROL_PLANE_URL: service.url,
                CLANKIE_CAPTAIN_TOKEN: service.captainToken,
                CLANKIE_SETTINGS_FILE: settings,
              },
              stdio: "ignore",
            },
          );
        } else {
          const scheduled = await mcpCall(service, "schedule_wake", {
            // Past the first MCP initialize, which can take seconds on a cold service.
            at: new Date(Date.now() + 10_000).toISOString(),
            reason: test.trigger.reason,
          });
          if (scheduled.error || scheduled.result?.isError)
            throw Error(`schedule_wake failed: ${JSON.stringify(scheduled).slice(0, 400)}`);
        }
        const deadline = Date.now() + 45_000;
        while (!seat.events.some((e) => e.kind === test.trigger.kind) && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 200));
        const event = seat.events.find((e) => e.kind === test.trigger.kind);
        if (!event) throw Error(`The service delivered no ${test.trigger.kind} event`);
        prompt = channelText(event);
      }
    } else if (test.trigger) {
      // Same words, same tag; there is simply no service behind them.
      prompt = channelText({
        kind: test.trigger.kind,
        conversationId: "global-default",
        source: test.trigger.kind === "escalation" ? "clankie-cli" : "service",
        id: `seat-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        content: test.trigger.kind === "escalation" ? test.trigger.text : wakeContent(test.trigger.reason),
      });
    }
    writeFileSync(join(root, "prompt.txt"), prompt);
    const result = await executeSandbox({
      root,
      binary: context.binary,
      args,
      input: prompt,
      timeoutMs: options.timeout * 1000,
      env,
      ...sandbox,
    });
    const rollouts =
      options.harness === "codex" ? readRollouts(join(root, "home", ".codex", "sessions")) : "";
    removeAuth(root);
    writeFileSync(join(root, "events.jsonl"), result.stdout);
    writeFileSync(join(root, "stderr.txt"), result.stderr);
    const parsed = parseEvents(options.harness, result.stdout);
    if (options.harness === "codex") {
      parsed.rateLimit = codexRateLimit(rollouts) ?? parsed.rateLimit;
      parsed.model ??=
        rollouts.match(/"type":"turn_context","payload":\{[^\n]*?"model":"([^"]+)"/)?.[1] ?? null;
    }
    const obs = observe({
      worktree: join(root, "worktree"),
      stdout: result.stdout,
      discord: service?.discordCalls() ?? [],
      herdr: fleet.calls(),
      harness: options.harness,
    });
    json(join(root, "observation.json"), { ...obs, result: obs.result.slice(0, 4000) });
    const passed = Boolean(test.grade(obs)) && !result.timedOut && !parsed.providerError;
    return {
      ...cell,
      attempt: 0,
      harness: options.harness,
      kind: test.coverage ? "coverage" : "seat",
      ...(test.coverage ? { coverage: test.coverage } : {}),
      model: parsed.model ?? options.model ?? "CLI default (not reported)",
      condition: {
        ...condition,
        ...(cell.config === "seat" ? { pluginSha256: context.pin.pluginSha256 } : {}),
      },
      passed,
      wallMs: result.wallMs,
      tokens: parsed.tokens,
      toolCalls: parsed.toolCalls,
      toolFailures: parsed.toolFailures,
      clankieTools: obs.tools.filter((name) => name.includes("clankie")).length,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      providerError: parsed.providerError,
      rateLimit: parsed.rateLimit,
      artifactDirectory: root,
    };
  } catch (error) {
    return {
      ...cell,
      attempt: 0,
      harness: options.harness,
      kind: test.coverage ? "coverage" : "seat",
      passed: false,
      error: String(error),
      tokens: null,
      artifactDirectory: root,
    };
  } finally {
    abort.abort();
    removeAuth(root);
    await service?.stop();
  }
}

async function run(options) {
  const claude = executable("claude");
  const binary = executable(options.harness);
  const help = spawnSync(binary, ["--help"], { encoding: "utf8" }).stdout;
  const campaign = realpathSync(mkdtempSync("/private/tmp/clankie-seat-"));
  const checkout = pinCheckout(campaign);
  const context = {
    claude,
    binary,
    checkout,
    capabilities: { effort: help.includes("--effort") },
    auth: subscriptionAuth(options.harness),
    pin: pinSeat(campaign, claude, checkout.path),
    // Pinned at start from the checkout: instruction work may change the file mid-run.
    instructions: Object.fromEntries(
      Object.entries(configurations)
        .filter(([, config]) => config.instructions && existsSync(join(checkout.path, config.instructions)))
        .map(([name, config]) => [name, readFileSync(join(checkout.path, config.instructions), "utf8")]),
    ),
  };
  const report = {
    schemaVersion: 1,
    id: randomUUID(),
    kind: "seat",
    startedAt: new Date().toISOString(),
    // Service, CLI, plugin, skills and instructions all run from this commit.
    sourceRevision: checkout.revision,
    suiteSha256: hash(readFileSync(join(repo, "scripts/evals/seat-cases.mjs"))),
    options,
    version: spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim(),
    cliSha256: hash(readFileSync(binary)),
    runnerSha256: hash(
      ["seat.mjs", "seat-service.mjs", "isolation.mjs"]
        .map((name) => readFileSync(join(repo, "scripts/evals", name), "utf8"))
        .join("\n"),
    ),
    seat: {
      pluginSha256: context.pin.pluginSha256,
      skills: context.pin.skills.length,
      launch: context.pin.args.filter((a) => !a.startsWith("{")),
    },
    instructionsSha256: Object.fromEntries(
      Object.entries(context.instructions).map(([k, v]) => [k, hash(v)]),
    ),
    isolation:
      "Seat: real plugin from `clankie seat --dry-run` in the macOS sandbox with loopback only to a throwaway service, which runs sandboxed with temp state and credentials and reaches only fake Discord and herdr bodies. Every arm: the same fake herdr fleet on PATH.",
    results: [],
    stopped: null,
  };
  json(join(campaign, "report.json"), report);
  console.log(`Evidence: ${campaign}`);
  let calls = 0;
  try {
    for (const cell of options.matrix) {
      if (calls > 0 && options.pause) await new Promise((done) => setTimeout(done, options.pause * 1000));
      calls++;
      const row = await attempt(options, cell, campaign, context);
      report.results.push(row);
      report.startupContext = context.startup;
      json(join(campaign, "report.json"), report);
      console.log(
        `${cell.caseId}/${cell.config} rep ${cell.rep}: ${row.passed ? "PASS" : "FAIL"} (${row.tokens?.total ?? "unknown"} tokens${row.error ? `; ${row.error.slice(0, 160)}` : ""})`,
      );
      const gate = usageGate(row.rateLimit, options.stopAt);
      if (gate?.stop) {
        report.stopped = gate.stop;
        break;
      }
      if (gate?.wait) {
        console.log(gate.reason);
        await new Promise((done) => setTimeout(done, gate.wait));
      }
    }
  } finally {
    checkout.remove();
  }
  report.finishedAt = new Date().toISOString();
  report.calls = calls;
  report.totalTokens = report.results.reduce((sum, r) => sum + (r.tokens?.total ?? 0), 0);
  report.unknownUsage = report.results.filter((r) => r.tokens === null).length;
  report.missingCells = options.matrix.filter(
    (c) => !report.results.some((r) => r.caseId === c.caseId && r.config === c.config && r.rep === c.rep),
  );
  json(join(campaign, "report.json"), report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--help")) {
      console.log(
        "node scripts/evals/seat.mjs [--harness claude|codex] [--configs bare,current,seat] [--cases all|coverage|ID,...] [--reps 5] [--max-runs 15] [--timeout 300] [--max-turns 20] [--model NAME] [--pause SECONDS] [--stop-at five_hour=0.8,seven_day=0.5] [--dry-run]\nThe seat arm runs the real Claude Code seat plugin against a throwaway, sandboxed Clankie service.",
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
