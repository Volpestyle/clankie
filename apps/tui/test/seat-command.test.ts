import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import {
  parseSeatArgs,
  pluginInstalled,
  planSeat,
  runSeatCommand,
  SEAT_PLUGIN_ID,
} from "../src/command/seat.ts";

const tempDirs: string[] = [];
const repoRoot = join(import.meta.dirname, "..", "..", "..");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function outputBuffer(): { readonly stream: { write(chunk: string): void }; readonly text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += chunk;
      },
    },
    text: () => output,
  };
}

async function stateEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-test-"));
  tempDirs.push(root);
  return { XDG_STATE_HOME: root, ...extra };
}

/** A fake `claude` and `herdr`: which plugins are listed, and what herdr says about the pane. */
function fakeExec(input: {
  readonly plugins?: readonly { id: string; enabled: boolean }[];
  readonly paneAgent?: string;
  readonly renameFails?: string;
  readonly calls?: string[][];
}) {
  return async (command: string, args: readonly string[]) => {
    input.calls?.push([command, ...args]);
    if (command === "claude" && args[0] === "--version")
      return { stdout: "2.1.258 (Claude Code)\n", stderr: "" };
    if (command === "claude" && args[0] === "plugin")
      return { stdout: JSON.stringify(input.plugins ?? []), stderr: "" };
    if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
      return {
        stdout: JSON.stringify({ result: { agent: { agent: input.paneAgent ?? "shell" } } }),
        stderr: "",
      };
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "rename") {
      if (input.renameFails !== undefined && args[3] !== "--clear") {
        throw Object.assign(new Error("herdr failed"), {
          stderr: `{"error":{"message":${JSON.stringify(input.renameFails)}}}`,
        });
      }
      return { stdout: "{}", stderr: "" };
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
}

describe("clankie seat", () => {
  it("parses its flags and refuses anything else", () => {
    expect(parseSeatArgs([])).toEqual({ resume: false, dryRun: false });
    expect(parseSeatArgs(["--resume", "--dry-run", "--plugin-dir", "/p"])).toEqual({
      resume: true,
      dryRun: true,
      pluginDir: "/p",
    });
    expect(() => parseSeatArgs(["--plugin-dir"])).toThrow("Usage: clankie seat");
    expect(() => parseSeatArgs(["status"])).toThrow("Usage: clankie seat");
  });

  it("reads the plugin registry for the installed seat", () => {
    expect(pluginInstalled(JSON.stringify([{ id: SEAT_PLUGIN_ID, enabled: true }]))).toBe(true);
    expect(pluginInstalled(JSON.stringify([{ id: SEAT_PLUGIN_ID, enabled: false }]))).toBe(false);
    expect(pluginInstalled("not json")).toBe(false);
  });

  it("falls back to the bundled plugin dir without the channel, and uses the marketplace install with it", async () => {
    const env = await stateEnv();
    const bundled = await planSeat(
      { resume: false, dryRun: true },
      { repoRoot, env, execFileImpl: fakeExec({}) },
    );
    expect(bundled.plugin).toEqual({
      source: "plugin-dir",
      path: join(repoRoot, "integrations", "claude-plugin"),
    });
    expect(bundled.channel).toBe(false);
    expect(bundled.args).toContain("--plugin-dir");
    expect(bundled.args).not.toContain("--dangerously-load-development-channels");
    expect(bundled.args).toContain("--session-id");
    // Permission allowlist rides as --settings JSON: the one thing a plugin cannot carry.
    const settings = bundled.args[bundled.args.indexOf("--settings") + 1];
    expect(JSON.parse(settings ?? "{}")).toEqual({
      permissions: { allow: ["Bash(clankie)", "Bash(clankie *)"] },
    });

    const installed = await planSeat(
      { resume: false, dryRun: true },
      { repoRoot, env, execFileImpl: fakeExec({ plugins: [{ id: SEAT_PLUGIN_ID, enabled: true }] }) },
    );
    expect(installed.plugin).toEqual({ source: "installed" });
    expect(installed.channel).toBe(true);
    expect(installed.args).toContain(`plugin:${SEAT_PLUGIN_ID}`);
    expect(installed.args).not.toContain("--plugin-dir");
  });

  it("refuses without Claude Code on PATH", async () => {
    const env = await stateEnv();
    await expect(
      planSeat(
        { resume: false, dryRun: true },
        {
          repoRoot,
          env,
          execFileImpl: async () => {
            throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
          },
        },
      ),
    ).rejects.toThrow("Claude Code is not on PATH");
  });

  it("prints the plan on --dry-run through the dispatcher without launching anything", async () => {
    const env = await stateEnv();
    const stdout = outputBuffer();
    const exit = await runHeadlessCaptainCommand(["seat", "--dry-run"], {
      repoRoot,
      env,
      execFileImpl: fakeExec({}),
      stdout: stdout.stream,
      stderr: outputBuffer().stream,
    });
    expect(exit).toBe(0);
    const plan = JSON.parse(stdout.text()) as { ok: boolean; command: string; args: string[] };
    expect(plan.ok).toBe(true);
    expect(plan.command).toBe("claude");
    expect(plan.args[0]).toBe("--name");
  });

  it("launches, names the herdr pane clankie, records the session, and resumes it", async () => {
    const env = await stateEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" });
    const calls: string[][] = [];
    const spawned: { args: readonly string[]; cwd: string }[] = [];
    const stderr = outputBuffer();
    const exit = await runSeatCommand([], {
      repoRoot,
      env,
      execFileImpl: fakeExec({ paneAgent: "claude", calls }),
      spawnImpl: async (_command, args, cwd) => {
        spawned.push({ args, cwd });
        return 0;
      },
      sleepImpl: async () => undefined,
      stdout: outputBuffer().stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(0);
    expect(calls).toContainEqual(["herdr", "agent", "rename", "w1:p2", "clankie"]);
    expect(calls.at(-1)).toEqual(["herdr", "agent", "rename", "w1:p2", "--clear"]);
    expect(stderr.text()).toContain("this seat is his head");
    const record = JSON.parse(await readFile(join(env.XDG_STATE_HOME!, "clankie", "seat.json"), "utf8")) as {
      sessionId: string;
      cwd: string;
    };
    const sessionArg = spawned[0]!.args[spawned[0]!.args.indexOf("--session-id") + 1];
    expect(record.sessionId).toBe(sessionArg);
    expect(record.cwd).toBe(spawned[0]!.cwd);

    const resumed = await planSeat(
      { resume: true, dryRun: true },
      { repoRoot, env, execFileImpl: fakeExec({}) },
    );
    expect(resumed.resumed).toBe(true);
    expect(resumed.args).toContain("--resume");
    expect(resumed.args).toContain(record.sessionId);
    expect(resumed.args).not.toContain("--session-id");
  });

  it("stays an ordinary fleet agent when another pane already holds the name", async () => {
    const env = await stateEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p3" });
    const stderr = outputBuffer();
    const exit = await runSeatCommand([], {
      repoRoot,
      env,
      execFileImpl: fakeExec({ paneAgent: "claude", renameFails: "agent name clankie is already in use" }),
      spawnImpl: async () => 0,
      sleepImpl: async () => undefined,
      stdout: outputBuffer().stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(0);
    expect(stderr.text()).toContain("another pane already holds the clankie seat");
    expect(stderr.text()).toContain("agent name clankie is already in use");
  });

  it("refuses --resume with no seat recorded", async () => {
    const env = await stateEnv();
    await expect(
      planSeat({ resume: true, dryRun: true }, { repoRoot, env, execFileImpl: fakeExec({}) }),
    ).rejects.toThrow("No seat to resume");
  });
});
