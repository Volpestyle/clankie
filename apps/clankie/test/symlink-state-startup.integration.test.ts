import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([false, true])(
  "starts the production service with an owner symlinked state home (XDG override: %s)",
  async (xdg) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "symlink-state-")));
    const home = join(root, "home");
    const target = join(root, "dotfiles-state");
    await mkdir(join(home, ".local"), { recursive: true, mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    const stateHome = join(home, ".local", "state");
    await symlink(target, stateHome);
    const settings = join(root, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        schemaVersion: 1,
        herdr: { runtime: "disabled" },
        captain: { workingDirectory: root },
      }),
    );
    const repo = resolve(import.meta.dirname, "../../..");
    const child = spawn(
      process.execPath,
      [
        "--import",
        join(repo, "apps/tui/node_modules/tsx/dist/loader.mjs"),
        join(repo, "apps/clankie/src/index.ts"),
      ],
      {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          NODE_ENV: "test",
          CI: "1",
          ...(xdg ? { XDG_STATE_HOME: stateHome } : {}),
          CLANKIE_STATE: join(stateHome, "clankie"),
          CLANKIE_SETTINGS_FILE: settings,
          CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
          CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(root, "fleet-resources"),
          CLANKIE_OPERATOR_TOKEN: "symlink-state-operator",
          CLANKIE_CAPTAIN_TOKEN: "symlink-state-captain",
          CLANKIE_BROWSER_ENABLED: "false",
          CLANKIE_RELAY_PORT: "0",
          CLANKIE_DEVICE_PORT: "0",
          PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    child.stdout.on("data", (data) => {
      log += String(data);
    });
    child.stderr.on("data", (data) => {
      log += String(data);
    });
    try {
      const deadline = Date.now() + 20_000;
      while (!log.includes("clankie listening") && child.exitCode === null && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 50));
      expect(log, log).toContain("clankie listening");
      expect(child.exitCode).toBeNull();
      if (process.env.VUH2033_EVIDENCE_FILE) {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(
          process.env.VUH2033_EVIDENCE_FILE,
          JSON.stringify({ xdg, stateHome, target, log }) + "\n",
        );
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timer);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
