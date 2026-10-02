import { type ChildProcess, type spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runRestartCommand } from "../src/command/restart.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function child(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, unref() {} }) as ChildProcess;
}

it.each(["rooms/trusted-room", "turns/discord_presence~guild%3Achannel", "voice/room"])(
  "defers a plain restart from %s until its new final answer, then restores the service and Discord",
  async (folder) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-restart-"));
    roots.push(root);
    const directory = join(root, "captain", folder);
    await mkdir(directory, { recursive: true });
    const sessionFile = join(directory, "session.jsonl");
    const final = JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } });
    await writeFile(sessionFile, `${final}\n`);
    const env = {
      XDG_STATE_HOME: root,
      CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
      PI_SESSION_FILE: sessionFile,
      PI_SESSION_ID: "discord-session",
      CLANKIE_LAUNCHER_PATH: "/release/bin/clankie",
      CLANKIE_SERVICES: "clankie,relay,discord-bridge",
    };
    let output = "";
    let helper: { args: string[]; options: SpawnOptions } | undefined;
    expect(
      await runRestartCommand([], {
        repoRoot: root,
        env,
        spawnImpl: ((_command: string, args: string[], options: SpawnOptions) => {
          helper = { args, options };
          return child(9100);
        }) as typeof spawn,
        stdout: {
          write: (chunk) => {
            output += chunk;
          },
        },
        stderr: { write() {} },
      }),
    ).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      status: "scheduled",
      target: "all",
      afterSession: sessionFile,
      logPath: join(root, "clankie/restart.log"),
    });
    expect(helper!.options).toMatchObject({ detached: true, cwd: root });
    expect(helper!.options.env?.PI_SESSION_FILE).toBeUndefined();
    expect(helper!.options.env?.PI_SESSION_ID).toBeUndefined();

    let polls = 0;
    const started: string[] = [];
    output = "";
    expect(
      await runRestartCommand(helper!.args.slice(1), {
        repoRoot: root,
        env: helper!.options.env!,
        sleepImpl: async (ms) => {
          expect(started).toEqual([]);
          if (ms === 1000) return;
          polls++;
          // A tool result and an unfinished line must not trigger shutdown.
          if (polls === 1)
            await appendFile(
              sessionFile,
              `${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse" } })}\n${final.slice(0, 15)}`,
            );
          if (polls === 2) await appendFile(sessionFile, `${final.slice(15)}\n`);
          if (polls > 2) throw new Error("Did not observe the final answer");
        },
        listProcessCommandsImpl: () => [],
        listPortOwnersImpl: () => [],
        processIsAliveImpl: () => true,
        fetchImpl: (async (input) => {
          const service = String(input).includes(":4321") ? "@clankie/relay" : "@clankie/clankie";
          if (!started.includes(service)) throw new Error("offline");
          return Response.json({ ok: true });
        }) as typeof fetch,
        spawnImpl: ((_command: string, args: string[]) => {
          started.push(args[1]!);
          return child(9200 + started.length);
        }) as typeof spawn,
        stdout: {
          write: (chunk) => {
            output += chunk;
          },
        },
        stderr: { write() {} },
      }),
    ).toBe(0);
    expect(polls).toBe(2);
    expect(started).toEqual(["@clankie/clankie", "@clankie/relay", "@clankie/discord-bridge"]);
    expect(JSON.parse(output).status).toBe("ready");
  },
);
