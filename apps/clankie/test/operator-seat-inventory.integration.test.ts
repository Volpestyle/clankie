import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resourceNativeHelperPath } from "@clankie/fleet-resources";
import { expect, test } from "vitest";

test("the owned kernel census lists a launcher whose running Node executable was unlinked", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-census-unlinked-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, NODE_ENV: "test", CLANKIE_SCRATCH: "1" };
  for (const name of [
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
  ]) {
    env[name] = join(root, name);
    await mkdir(env[name]!, { mode: 0o700 });
  }
  const executable = join(root, "node");
  // Homebrew Node keeps libnode beside its original bin directory. Only the
  // owned executable is copied/unlinked; its installed libraries are read-only.
  if (process.platform === "darwin") env.DYLD_LIBRARY_PATH = resolve(dirname(process.execPath), "../lib");
  await copyFile(process.execPath, executable);
  const entry = join(root, "clankie.ts");
  await writeFile(entry, "process.stdout.write('ready\\n');setInterval(()=>{},1000);");
  const child = spawn(executable, [entry, "claude", "--conversation", "unlinked-proof"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let error = "";
      child.stderr!.on("data", (chunk) => {
        error += chunk;
      });
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        reject(Error(`Owned Node exited before readiness: ${code}/${signal}: ${error}`)),
      );
    });
    env.CLANKIE_TEST_OPERATOR_PID_FILE = join(root, "pids.json");
    await writeFile(env.CLANKIE_TEST_OPERATOR_PID_FILE, JSON.stringify([child.pid]));
    await unlink(executable);
    const { stdout } = await promisify(execFile)(
      process.platform === "darwin" ? "/usr/bin/python3" : "python3",
      ["-I", resourceNativeHelperPath(), "operator-seats"],
      { env, timeout: 12000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: 1,
      seats: [{ pid: child.pid, command: "claude", conversationId: "unlinked-proof" }],
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
