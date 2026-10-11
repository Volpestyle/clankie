import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CLAUDE_WORKER_PLUGIN_ID } from "@clankie/protocol";
import { SEAT_PLUGIN_ID } from "./seat.ts";
import { JoinedWorkerLaunchSchema } from "@clankie/protocol/machine-join";
import { claudeTrackerDenyRules } from "../../../clankie/src/captain/tracker-isolation.ts";
import { createHireLayout } from "../../../clankie/src/captain/hire-layout.ts";
import type { JoinedMachineCredential, JoinedMachinePorts } from "../../bin/joined-machine-client.ts";
import { joinedSeatTransport } from "./joined-seat.ts";
import { clankieStateHome } from "../state-home.ts";

const exec = promisify(execFile);
const Native = z.object({
  result: z.object({
    agent: z.object({
      pane_id: z.string().optional(),
      session: z.object({ kind: z.literal("id"), value: z.string() }),
    }),
  }),
});

/** A workers-level adapter starts only native Claude in a new, visible Herdr pane. */
export function joinedWorkerPorts(
  credential: JoinedMachineCredential,
  options: {
    env: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    run?: (args: readonly string[], signal?: AbortSignal) => Promise<string>;
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
    const plugin = join(clankieStateHome(options.env), "clankie", "joined-worker-plugin");
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "clankie", version: "1.0.0", description: "Joined native worker channel" }),
      { mode: 0o600 },
    );
    await writeFile(
      join(plugin, ".mcp.json"),
      JSON.stringify({ mcpServers: { lead: { command: "clankie", args: ["mcp", "--lane", "operator"] } } }),
      { mode: 0o600 },
    );
    await check();
    const paneId = await layout({
      cwd: directory,
      label: launch.title,
      env: {
        ...(options.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: options.env.CLAUDE_CONFIG_DIR } : {}),
        CLANKIE_JOINED_SEAT_TOKEN: launch.token,
        CLANKIE_JOINED_WORKER_SESSION: launch.sessionId,
        CLANKIE_CONVERSATION_ID: launch.conversationId,
        // Never project an inherited home/SSH bearer into a new joined worker.
        CLANKIE_OPERATOR_TOKEN: "",
        CLANKIE_CAPTAIN_TOKEN: "",
        CLANKIE_FLEET_TOKEN: "",
        CLANKIE_REMOTE_LEAD_TOKEN: "",
      },
    });
    await check();
    await run(
      [
        "agent",
        "start",
        launch.title,
        "--kind",
        "claude",
        "--pane",
        paneId,
        "--",
        "--session-id",
        launch.sessionId,
        "--plugin-dir",
        plugin,
        "--dangerously-load-development-channels",
        "plugin:clankie@inline",
        "--settings",
        JSON.stringify({
          enabledPlugins: {
            [SEAT_PLUGIN_ID]: false,
            [CLAUDE_WORKER_PLUGIN_ID]: false,
            "clankie@inline": true,
          },
          permissions: {
            defaultMode: "auto",
            allow: ["mcp__plugin_clankie_lead"],
            deny: claudeTrackerDenyRules(directory, options.env),
          },
        }),
        ...(launch.maximumTrust ? ["--dangerously-skip-permissions"] : []),
        ...(launch.model ? ["--model", launch.model] : []),
        ...(launch.effort ? ["--effort", launch.effort] : []),
        `You are a worker hired by Clankie's joined lead. Report with message_clankie. Your lead chat is ${launch.conversationId}. Your seat is ${credential.lease.machineId}/${paneId}.\n\n${launch.brief}`,
      ],
      signal,
    );
    const observed = Native.parse(JSON.parse(await run(["agent", "get", paneId], signal)));
    if (observed.result.agent.session.value !== launch.sessionId)
      throw Error("joined_worker_native_session_mismatch");
    const response = await joinedSeatTransport(credential, options.fetchImpl ?? fetch).rpc(
      {
        method: "POST",
        path: "/workers/admit",
        headers: { authorization: `Bearer ${launch.token}` },
        body: JSON.stringify({ paneId, sessionId: launch.sessionId }),
      },
      signal,
    );
    if (!response.ok) throw Error("joined_worker_admission_refused");
    return JSON.stringify({ paneId, sessionId: launch.sessionId, admitted: true });
  };
}

/** Observe the exact native occupant before each worker bridge request. */
export async function verifyJoinedWorker(env: NodeJS.ProcessEnv) {
  if (!env.CLANKIE_JOINED_WORKER_SESSION) return;
  if (!env.HERDR_PANE_ID) throw Error("joined_worker_native_pane_required");
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
  if (observed.result.agent.session.value !== env.CLANKIE_JOINED_WORKER_SESSION)
    throw Error("joined_worker_native_session_mismatch");
}
