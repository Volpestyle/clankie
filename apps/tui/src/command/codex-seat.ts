import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { bundledSkills, defaultSettingsPath, SettingsStore } from "@clankie/settings";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { clankieStateHome } from "../state-home.ts";
import { commandHost, outputJson } from "./io.ts";
import type { SeatCommandOptions, SeatPlan } from "./seat.ts";
import { resolveSeatContext } from "./seat-context.ts";
import { connectLaneUpstream, pumpSeatEvents } from "./mcp.ts";
import { startCodexAppServerSeat } from "../../../clankie/src/captain/codex-app-server.ts";
import { codexTrackerOverrides } from "../../../clankie/src/captain/tracker-isolation.ts";

const PLUGIN = "clankie@clankie-seat";
const exec = promisify(execFileCallback);
type Flags = { resume: boolean; dryRun: boolean; conversationId?: string; pluginDir?: string };
type Binding = { sessionId?: string; conversationId?: string; cwd: string; ready?: boolean };

function recordPath(env: NodeJS.ProcessEnv): string {
  return join(clankieStateHome(env), "clankie", "codex-seat.json");
}

export async function planCodexSeat(flags: Flags, options: SeatCommandOptions): Promise<SeatPlan> {
  const env = options.env ?? process.env;
  const run = options.execFileImpl ?? ((command, args) => exec(command, [...args], { env, timeout: 15000 }));
  try {
    await run("codex", ["--version"]);
  } catch {
    throw new Error("Codex is not on PATH; install Codex CLI first.");
  }
  const source = resolve(flags.pluginDir ?? join(options.repoRoot, "integrations/codex-plugin"));
  if (!existsSync(join(source, ".codex-plugin/plugin.json")))
    throw new Error(`The Codex seat plugin is not bundled at ${source}; update this install.`);
  let previous: Binding | undefined;
  if (flags.resume) {
    try {
      previous = JSON.parse(readFileSync(recordPath(env), "utf8"));
    } catch {
      /* No recorded native thread yet. */
    }
    if (!previous?.sessionId) throw new Error("No Codex seat to resume; launch and trust its hooks first.");
    if (
      flags.conversationId !== undefined &&
      flags.conversationId !== (previous.conversationId ?? "global-default")
    )
      throw new Error("A resumed seat keeps its conversation; start a new seat to select another one.");
  }
  const context = await resolveSeatContext(
    {
      conversationId:
        previous === undefined ? flags.conversationId : (previous.conversationId ?? "global-default"),
      cwd: previous?.cwd ?? process.cwd(),
      command: "codex",
      dryRun: true,
    },
    options,
  );
  const { conversationId, cwd } = context;
  const selection = (await new SettingsStore(defaultSettingsPath(env)).load()).skills;
  const skills = bundledSkills(options.repoRoot, selection);
  const excluded = skills
    .filter((skill) => !skill.included)
    .flatMap((skill) => [skill.name, `clankie:${skill.name}`]);
  // His Linear writes go through the connected account, not an inherited connector.
  const trackerOverrides = await (options.trackerOverrides ?? codexTrackerOverrides)(cwd, env);
  return {
    command: "codex",
    args: [
      ...trackerOverrides.flatMap((override) => ["-c", override]),
      "-c",
      `marketplaces.clankie-seat={source_type="local",source=${JSON.stringify(source)}}`,
      "-c",
      `plugins.${JSON.stringify(PLUGIN)}.enabled=true`,
      ...(excluded.length
        ? [
            "-c",
            `skills.config=[${excluded.map((name) => `{name=${JSON.stringify(name)},enabled=false}`).join(",")}]`,
          ]
        : []),
    ],
    plugin: { source: "plugin-dir", path: source },
    skills,
    channel: true,
    sessionId: previous?.sessionId ?? "pending-native-thread",
    resumed: previous !== undefined,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(context.newConversation === undefined ? {} : { newConversation: context.newConversation }),
    cwd,
  };
}

export async function runCodexSeat(
  flags: Flags,
  options: SeatCommandOptions & {
    startImpl?: typeof startCodexAppServerSeat;
    connectImpl?: typeof connectLaneUpstream;
  },
): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let plan = await planCodexSeat(flags, options);
  const ownerStep = {
    kind: "hook_trust_required",
    command: "/hooks",
    detail:
      "Review and trust the Clankie hooks in Codex, then exit and launch this seat again. New or changed hooks are skipped until trusted.",
  };
  if (flags.dryRun) {
    outputJson(stdout, { ok: true, ...plan, ownerSteps: [ownerStep] });
    return 0;
  }
  const run = options.execFileImpl ?? ((command, args) => exec(command, [...args], { env, timeout: 15000 }));
  const listed = JSON.parse(
    (await run("codex", [...plan.args, "plugin", "list", "--json", "--marketplace", "clankie-seat"])).stdout,
  ) as { installed?: { pluginId: string }[] };
  if (!listed.installed?.some((plugin) => plugin.pluginId === PLUGIN)) {
    throw new Error(
      `Codex seat plugin is not installed. Run codex plugin marketplace add ${JSON.stringify(plan.plugin.path)}, then codex plugin add ${PLUGIN}. Disable it globally in /plugins; this launcher enables it only for the seat. Review its hooks in /hooks.`,
    );
  }
  if (plan.newConversation !== undefined) {
    plan = {
      ...plan,
      ...(await resolveSeatContext({ cwd: plan.cwd, command: "codex", dryRun: false }, options)),
    };
  }
  stderr.write(`clankie seat: ${ownerStep.kind}: ${ownerStep.detail}\n`);
  const directory = join(clankieStateHome(env), "clankie", "codex-seat-launches", randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bindingPath = join(directory, "binding.json");
  const binding: Binding = {
    cwd: plan.cwd,
    ...(plan.resumed ? { sessionId: plan.sessionId } : {}),
    ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
  };
  writeFileSync(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  const seatEnv = { ...env };
  for (const key of Object.keys(seatEnv)) if (/^(?:SWARM_|CLANKIE_SWARM_)/u.test(key)) delete seatEnv[key];
  delete seatEnv.CLANKIE_SEAT_SESSION_ID;
  delete seatEnv.CLANKIE_CONVERSATION_ID;
  seatEnv.CLANKIE_CODEX_SEAT_BINDING = bindingPath;
  seatEnv.CLANKIE_SEAT_HARNESS = "codex";
  seatEnv.CLANKIE_CONTROL_PLANE_URL = commandHost({ ...options, env });
  if (plan.conversationId) seatEnv.CLANKIE_CONVERSATION_ID = plan.conversationId;
  let child: ChildProcess | undefined;
  let running: Promise<number> | undefined;
  const launch =
    options.spawnImpl ??
    ((command, args, cwd, childEnv) =>
      new Promise<number>((resolve, reject) => {
        child = spawn(command, [...args], { cwd, env: childEnv, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      }));
  const stop = new AbortController();
  let seat: Awaited<ReturnType<typeof startCodexAppServerSeat>>;
  try {
    seat = await (options.startImpl ?? startCodexAppServerSeat)({
      cwd: plan.cwd,
      env: Object.fromEntries(
        Object.entries(seatEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      config: plan.args.filter((_value, index) => index % 2 === 1),
      threadStartTimeoutMs: 600_000,
      signal: stop.signal,
      ...(plan.resumed ? { resumeThreadId: plan.sessionId } : {}),
      startView: async (args) => {
        running = launch("codex", args, plan.cwd, seatEnv);
        void running.then(
          () => stop.abort(),
          (error) => stop.abort(error),
        );
      },
    });
  } catch (error) {
    child?.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
    if (stop.signal.aborted && running) return running;
    throw error;
  }
  // Record the server's thread even if its hooks still need owner trust.
  writeFileSync(recordPath(env), JSON.stringify({ ...binding, sessionId: seat.threadId }), { mode: 0o600 });
  let upstream: Awaited<ReturnType<typeof connectLaneUpstream>> | undefined;
  const delivery = (async () => {
    while (!stop.signal.aborted) {
      const current = JSON.parse(readFileSync(bindingPath, "utf8")) as Binding;
      if (current.ready && current.sessionId === seat.threadId) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (stop.signal.aborted) return;
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
    });
    if (!credential) throw new Error("No operator credential for the Codex seat outbox");
    upstream = await (options.connectImpl ?? connectLaneUpstream)({
      host: commandHost({ ...options, env }),
      bearer: credential.token,
      ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    await pumpSeatEvents(
      {
        notification: async (event) => {
          await seat.send(`<clankie-seat-event>\n${JSON.stringify(event.params)}\n</clankie-seat-event>`);
        },
      },
      upstream,
      stop.signal,
      { onError: (error) => stderr.write(`clankie seat outbox: ${String(error)}\n`) },
    );
  })().catch((error) => {
    stderr.write(`clankie seat delivery stopped: ${String(error)}; no terminal fallback.\n`);
  });
  try {
    return await running!;
  } finally {
    stop.abort();
    try {
      await delivery;
      await upstream?.close();
    } finally {
      await seat.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
