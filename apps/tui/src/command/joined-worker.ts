import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { CLAUDE_WORKER_PLUGIN, CLAUDE_WORKER_PLUGIN_ID } from "@clankie/protocol";
import { SEAT_PLUGIN_ID } from "./seat.ts";
import { JoinedWorkerLaunchSchema } from "@clankie/protocol/machine-join";
import { claudeTrackerDenyRules } from "../../../clankie/src/captain/tracker-isolation.ts";
import { createHireLayout } from "../../../clankie/src/captain/hire-layout.ts";
import { herdrAgentName } from "../../../clankie/src/captain/hire-name.ts";
import type { JoinedMachineCredential, JoinedMachinePorts } from "../../bin/joined-machine-client.ts";
import { joinedSeatTransport } from "./joined-seat.ts";

const exec = promisify(execFile);
const Native = z.object({
  result: z.object({
    agent: z.object({
      pane_id: z.string().optional(),
      agent_session: z.object({ kind: z.literal("id"), value: z.string() }),
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
    // Herdr answers `agent start` once Claude is idle, which for a briefed worker is
    // after its first turn, or with a timeout while it still works. As on a local
    // hire, admission waits only for the native session Claude reports (VUH-2607).
    let started: { error?: unknown } | undefined;
    void run(
      [
        "agent",
        "start",
        herdrAgentName(launch.title),
        "--kind",
        "claude",
        "--pane",
        paneId,
        "--",
        "--session-id",
        launch.sessionId,
        // The installed worker plugin, as on any hire: an owner-approved channel
        // (managed allowedChannelPlugins), never a development channel whose
        // warning nobody is there to answer (VUH-2607).
        "--channels",
        `plugin:${CLAUDE_WORKER_PLUGIN_ID}`,
        "--settings",
        JSON.stringify({
          enabledPlugins: { [SEAT_PLUGIN_ID]: false, [CLAUDE_WORKER_PLUGIN_ID]: true },
          permissions: {
            defaultMode: "auto",
            allow: [`mcp__plugin_${CLAUDE_WORKER_PLUGIN.plugin}_worker`],
            deny: claudeTrackerDenyRules(directory, options.env),
          },
        }),
        ...(launch.maximumTrust ? ["--dangerously-skip-permissions"] : []),
        ...(launch.model ? ["--model", launch.model] : []),
        ...(launch.effort ? ["--effort", launch.effort] : []),
        `Execute the assignment in the clankieBrief JSON field of @${briefPath}`,
      ],
      signal,
    ).then(
      () => (started = {}),
      (error: unknown) => (started = { error }),
    );
    let observed: z.infer<typeof Native> | undefined;
    for (const deadline = Date.now() + 60_000; observed === undefined;) {
      signal.throwIfAborted();
      // allow-swallowed-rejection -- a pane with no reported agent yet answers with an error; the deadline decides
      const raw = await run(["agent", "get", paneId], signal).catch(() => undefined);
      observed = raw === undefined ? undefined : Native.safeParse(JSON.parse(raw)).data;
      if (observed !== undefined) break;
      if (started?.error !== undefined || Date.now() > deadline)
        throw started?.error ?? Error("joined_worker_native_session_missing");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (observed.result.agent.agent_session.value !== launch.sessionId)
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
  if (observed.result.agent.agent_session.value !== env.CLANKIE_JOINED_WORKER_SESSION)
    throw Error("joined_worker_native_session_mismatch");
}
