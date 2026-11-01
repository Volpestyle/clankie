import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  CLAUDE_WORKER_INSTALLED_PLUGIN_ID,
  CLAUDE_WORKER_PLUGIN,
  CLAUDE_WORKER_PLUGIN_ID,
} from "@clankie/protocol";
import { SEAT_PLUGIN_ID } from "./seat.ts";
import { JoinedWorkerLaunchSchema } from "@clankie/protocol/machine-join";
import { MAXIMUM_TRUST_CODEX_CONFIG } from "@clankie/protocol/owner-settings";
import {
  claudeTrackerDenyRules,
  codexTrackerOverrides,
} from "../../../clankie/src/captain/tracker-isolation.ts";
import {
  fleetSeatCodexStartArgs,
  fleetSeatEffortArgs,
  fleetSeatModelArgs,
} from "../../../clankie/src/captain/fleet-seat.ts";
import { createHireLayout } from "../../../clankie/src/captain/hire-layout.ts";
import { herdrAgentName } from "../../../clankie/src/captain/hire-name.ts";
import { shippedWorkerFile } from "../../../clankie/src/worker-plugin-path.ts";
import type { JoinedMachineCredential, JoinedMachinePorts } from "../../bin/joined-machine-client.ts";
import { joinedSeatTransport } from "./joined-seat.ts";

const exec = promisify(execFile);
const Native = z.object({
  result: z.object({
    agent: z.object({
      pane_id: z.string().optional(),
      // The reported session names its harness; the agent's own label waits for launch.
      agent_session: z.object({
        agent: z.string(),
        kind: z.enum(["id", "path"]),
        value: z.string().min(1).max(4096),
      }),
    }),
  }),
});
type Native = z.infer<typeof Native>;
/** This install's worker bridge; its joined branch serves the worker over the join channel. */
const WORKER_BRIDGE = shippedWorkerFile("bin", "swarm-mcp.mjs");
/** What the bridge needs from the pane; Codex passes an MCP server only the variables it names. */
const CODEX_BRIDGE_ENV = [
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "CLANKIE_STATE",
  "CLANKIE_CREDENTIALS_FILE",
  "CLANKIE_JOINED_SEAT_TOKEN",
  "CLANKIE_JOINED_WORKER_SESSION",
  "CLANKIE_JOINED_WORKER_HARNESS",
  "CLANKIE_CONVERSATION_ID",
  "PATH",
  "HOME",
];

/** A workers-level adapter starts only native Claude or Codex in a new, visible Herdr pane. */
export function joinedWorkerPorts(
  credential: JoinedMachineCredential,
  options: {
    env: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    run?: (args: readonly string[], signal?: AbortSignal) => Promise<string>;
    /** Codex's inherited tracker connectors to switch off, as on a local hire. */
    codexTrackerOverrides?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<string[]>;
  },
): NonNullable<JoinedMachinePorts["workers"]> {
  const run =
    options.run ??
    (async (args, signal) =>
      (await exec("herdr", [...args], { env: options.env, signal, timeout: 60_000, maxBuffer: 1024 * 1024 }))
        .stdout);
  const layout = createHireLayout((args) => run(args));
  return async (request, directory, signal) => {
    const launch = JoinedWorkerLaunchSchema.parse(JSON.parse(request));
    const harness = launch.harness ?? "claude";
    const wire = joinedSeatTransport(credential, options.fetchImpl ?? fetch);
    const check = async () => {
      signal.throwIfAborted();
      const response = await wire.rpc(
        { method: "GET", path: "/workers/check", headers: { authorization: `Bearer ${launch.token}` } },
        signal,
      );
      if (!response.ok) throw Error("joined_worker_grant_revoked");
      const value = await response.json();
      if (
        value.sessionId !== launch.sessionId ||
        value.directory !== directory ||
        value.conversationId !== launch.conversationId
      )
        throw Error("joined_worker_launch_mismatch");
    };
    await check();
    await check();
    const paneId = await layout({
      cwd: directory,
      label: launch.title,
      env: {
        ...(options.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: options.env.CLAUDE_CONFIG_DIR } : {}),
        CLANKIE_JOINED_SEAT_TOKEN: launch.token,
        CLANKIE_JOINED_WORKER_SESSION: launch.sessionId,
        CLANKIE_JOINED_WORKER_HARNESS: harness,
        CLANKIE_CONVERSATION_ID: launch.conversationId,
        // Never project an inherited home/SSH bearer into a new joined worker.
        CLANKIE_OPERATOR_TOKEN: "",
        CLANKIE_CAPTAIN_TOKEN: "",
        CLANKIE_FLEET_TOKEN: "",
        CLANKIE_REMOTE_LEAD_TOKEN: "",
      },
    });
    const observe = async () => {
      // allow-swallowed-rejection -- a pane with no reported agent yet answers with an error
      const raw = await run(["agent", "get", paneId], signal).catch(() => undefined);
      return raw === undefined ? undefined : Native.safeParse(JSON.parse(raw)).data;
    };
    // Only a session that first appears in this new pane, after this launch, is admitted.
    if ((await observe()) !== undefined) throw Error("joined_worker_pane_occupied");
    await check();
    // As a local hire: the brief goes in a private file named by a one-line
    // startup prompt, since Herdr refuses arguments it cannot encode for the shell.
    const briefs = join(
      options.env.CLANKIE_STATE?.trim() || join(options.env.HOME ?? homedir(), ".clankie"),
      "claude-briefs",
    );
    const briefPath = join(briefs, `clankie-brief-${launch.sessionId}.json`);
    if (/[\p{Cc}"\s]/u.test(briefPath)) throw Error("joined_worker_brief_path_unsafe");
    await mkdir(briefs, { recursive: true, mode: 0o700 });
    await writeFile(
      briefPath,
      JSON.stringify({
        clankieBrief: `You are a worker Clankie hired on this machine. Report with message_clankie. Your lead chat is ${launch.conversationId}. Your seat is ${credential.lease.machineId}/${paneId}.\n\n${launch.brief}`,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const prompt =
      harness === "codex"
        ? `Read the JSON file ${briefPath} and execute the assignment in its clankieBrief field.`
        : `Execute the assignment in the clankieBrief JSON field of @${briefPath}`;
    const native =
      harness === "codex"
        ? [
            // Its own process, so Herdr learns the session from its first turn (VUH-1398).
            ...fleetSeatCodexStartArgs(),
            ...[
              ...(await (options.codexTrackerOverrides ?? codexTrackerOverrides)(directory, options.env)),
              ...(launch.maximumTrust ? MAXIMUM_TRUST_CODEX_CONFIG : []),
              "mcp_servers.clankie.enabled=false",
              "mcp_servers.worker.enabled=true",
              `mcp_servers.worker.command=${JSON.stringify(process.execPath)}`,
              `mcp_servers.worker.args=${JSON.stringify([WORKER_BRIDGE])}`,
              `mcp_servers.worker.env_vars=${JSON.stringify(CODEX_BRIDGE_ENV)}`,
              // Clankie's own bridge needs no native prompt; other servers keep theirs.
              'mcp_servers.worker.default_tools_approval_mode="approve"',
            ].flatMap((override) => ["-c", override]),
            ...(launch.model ? (fleetSeatModelArgs("codex", launch.model) ?? []) : []),
            ...(launch.effort ? (fleetSeatEffortArgs("codex", launch.effort) ?? []) : []),
            prompt,
          ]
        : [
            "--session-id",
            launch.sessionId,
            // The worker plugin for this session only, as on any hire (ADR 0317): an
            // owner-approved channel (managed allowedChannelPlugins), never a development
            // channel whose warning nobody is there to answer (VUH-2607).
            "--plugin-dir",
            shippedWorkerFile(),
            "--channels",
            `plugin:${CLAUDE_WORKER_PLUGIN_ID}`,
            "--settings",
            JSON.stringify({
              enabledPlugins: {
                [SEAT_PLUGIN_ID]: false,
                [CLAUDE_WORKER_PLUGIN_ID]: true,
                [CLAUDE_WORKER_INSTALLED_PLUGIN_ID]: false,
              },
              permissions: {
                defaultMode: "auto",
                allow: [`mcp__plugin_${CLAUDE_WORKER_PLUGIN.plugin}_worker`],
                deny: claudeTrackerDenyRules(directory, options.env),
              },
            }),
            ...(launch.maximumTrust ? ["--dangerously-skip-permissions"] : []),
            ...(launch.model ? ["--model", launch.model] : []),
            ...(launch.effort ? ["--effort", launch.effort] : []),
            prompt,
          ];
    // Herdr answers `agent start` once the agent is idle, which for a briefed worker
    // is after its first turn, or with a timeout while it still works. As on a local
    // hire, admission waits only for the native session it reports (VUH-2607).
    let started: { error?: unknown } | undefined;
    void run(
      ["agent", "start", herdrAgentName(launch.title), "--kind", harness, "--pane", paneId, "--", ...native],
      signal,
    ).then(
      () => (started = {}),
      (error: unknown) => (started = { error }),
    );
    let observed: Native | undefined;
    for (const deadline = Date.now() + 60_000; observed === undefined;) {
      signal.throwIfAborted();
      observed = await observe();
      if (observed !== undefined) break;
      if (started?.error !== undefined || Date.now() > deadline)
        throw started?.error ?? Error("joined_worker_native_session_missing");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const session = observed.result.agent.agent_session.value;
    if (
      observed.result.agent.agent_session.agent !== harness ||
      (harness === "claude" && session !== launch.sessionId)
    )
      throw Error("joined_worker_native_session_mismatch");
    const response = await joinedSeatTransport(credential, options.fetchImpl ?? fetch).rpc(
      {
        method: "POST",
        path: "/workers/admit",
        headers: { authorization: `Bearer ${launch.token}` },
        body: JSON.stringify({
          paneId,
          sessionId: launch.sessionId,
          ...(harness === "codex" ? { nativeSessionId: session } : {}),
        }),
      },
      signal,
    );
    if (!response.ok) throw Error("joined_worker_admission_refused");
    return JSON.stringify({ paneId, sessionId: launch.sessionId, nativeSessionId: session, admitted: true });
  };
}

/**
 * Observe the exact native occupant before each worker bridge request. Claude's
 * session was fixed at launch; Codex's is the one its home admitted, read fresh
 * each time, so a pane whose session changed is refused (VUH-2609).
 */
export async function verifyJoinedWorker(env: NodeJS.ProcessEnv, admitted?: () => Promise<unknown>) {
  if (!env.CLANKIE_JOINED_WORKER_SESSION) return;
  if (!env.HERDR_PANE_ID) throw Error("joined_worker_native_pane_required");
  const harness = env.CLANKIE_JOINED_WORKER_HARNESS === "codex" ? "codex" : "claude";
  const observed = Native.parse(
    JSON.parse(
      (
        await exec("herdr", ["agent", "get", env.HERDR_PANE_ID], {
          env,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
    ),
  );
  const expected = harness === "codex" ? await admitted?.() : env.CLANKIE_JOINED_WORKER_SESSION;
  if (
    observed.result.agent.agent_session.agent !== harness ||
    expected === undefined ||
    observed.result.agent.agent_session.value !== expected
  )
    throw Error("joined_worker_native_session_mismatch");
}
