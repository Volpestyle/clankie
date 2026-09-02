import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { AUTOSTART_LABEL, runAutostartCommand } from "../src/command/autostart.ts";
import { HEADLESS_NOUNS } from "../src/command/registry.ts";
import { type ExecFileImpl } from "../src/install-doctor.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

/** A launchd that remembers one job: `print` fails until `bootstrap`, `bootout` forgets it. */
function fakeLaunchctl(initiallyLoaded = false): {
  readonly execFileImpl: ExecFileImpl;
  readonly calls: string[][];
  loaded: boolean;
} {
  const state = {
    calls: [] as string[][],
    loaded: initiallyLoaded,
    execFileImpl: (async (command, args) => {
      state.calls.push([command, ...args]);
      if (command !== "launchctl") throw Object.assign(new Error("not found"), { code: "ENOENT" });
      if (args[0] === "print") {
        if (!state.loaded) throw new Error("Could not find service in domain");
        return { stdout: `${AUTOSTART_LABEL} = { state = waiting }`, stderr: "" };
      }
      if (args[0] === "bootout") state.loaded = false;
      if (args[0] === "bootstrap") state.loaded = true;
      return { stdout: "", stderr: "" };
    }) satisfies ExecFileImpl,
  };
  return state;
}

async function home(): Promise<{
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly plist: string;
  readonly launcher: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "clankie-autostart-test-"));
  tempDirs.push(root);
  const launcher = join(root, "bin", "clankie");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(launcher, "#!/bin/sh\n", { mode: 0o755 });
  return {
    root,
    env: { HOME: root, XDG_STATE_HOME: join(root, "state"), PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
    plist: join(root, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
    launcher,
  };
}

describe("autostart command", () => {
  it("enable writes a run-once login agent atomically and bootstraps it into the user domain", async () => {
    const { root, env, plist, launcher } = await home();
    const launchctl = fakeLaunchctl();

    const enabled = await runAutostartCommand(["enable"], {
      env,
      execFileImpl: launchctl.execFileImpl,
      launcherCommand: [launcher],
      uid: 501,
    });

    expect(enabled).toEqual({
      ok: true,
      status: "enabled",
      label: AUTOSTART_LABEL,
      plist,
      loaded: true,
      command: [launcher, "restart", "clankie"],
      log: join(root, "state", "clankie", "autostart.log"),
    });
    expect(launchctl.calls).toEqual([
      ["launchctl", "print", `gui/501/${AUTOSTART_LABEL}`],
      ["launchctl", "bootstrap", "gui/501", plist],
    ]);
    const text = await readFile(plist, "utf8");
    expect(text).toContain(`<key>Label</key><string>${AUTOSTART_LABEL}</string>`);
    expect(text).toContain(
      `<array>\n    <string>${launcher}</string>\n    <string>restart</string>\n    <string>clankie</string>\n  </array>`,
    );
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    expect(text).toContain("<key>KeepAlive</key><false/>");
    expect(text).toContain(`<key>WorkingDirectory</key><string>${root}</string>`);
    expect(text).toContain(
      `<key>StandardOutPath</key><string>${join(root, "state", "clankie", "autostart.log")}</string>`,
    );
    expect(text).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(text).toContain(`<key>XDG_STATE_HOME</key><string>${join(root, "state")}</string>`);
    expect(text).not.toContain("XDG_CONFIG_HOME");
    expect(text.endsWith("</plist>\n")).toBe(true);
    await expect(rm(`${plist}.${String(process.pid)}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enable is idempotent: a loaded agent is booted out before the rewritten file is bootstrapped", async () => {
    const { env, plist, launcher } = await home();
    const launchctl = fakeLaunchctl(true);
    await writeFile(plist, "stale", { mode: 0o644 }).catch(async () => {
      await mkdir(join(env.HOME ?? "", "Library", "LaunchAgents"), { recursive: true });
      await writeFile(plist, "stale", { mode: 0o644 });
    });

    const enabled = await runAutostartCommand(["enable"], {
      env,
      execFileImpl: launchctl.execFileImpl,
      launcherCommand: [launcher],
      uid: 501,
    });

    expect(enabled.status).toBe("enabled");
    expect(launchctl.calls.map((call) => call[1])).toEqual(["print", "bootout", "bootstrap"]);
    expect(await readFile(plist, "utf8")).not.toBe("stale");
  });

  it("disable boots the agent out and removes its file, and is a no-op when nothing is installed", async () => {
    const { env, plist, launcher } = await home();
    const launchctl = fakeLaunchctl();
    await runAutostartCommand(["enable"], {
      env,
      execFileImpl: launchctl.execFileImpl,
      launcherCommand: [launcher],
      uid: 501,
    });
    launchctl.calls.length = 0;

    const disabled = await runAutostartCommand(["disable"], {
      env,
      execFileImpl: launchctl.execFileImpl,
      launcherCommand: [launcher],
      uid: 501,
    });
    expect(disabled).toMatchObject({ status: "disabled", loaded: false });
    expect(launchctl.calls.map((call) => call[1])).toEqual(["print", "bootout"]);
    await expect(readFile(plist, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    launchctl.calls.length = 0;
    const again = await runAutostartCommand(["disable"], {
      env,
      execFileImpl: launchctl.execFileImpl,
      launcherCommand: [launcher],
      uid: 501,
    });
    expect(again.status).toBe("disabled");
    expect(launchctl.calls.map((call) => call[1])).toEqual(["print"]);
  });

  it("status distinguishes disabled, enabled, and a file launchd no longer knows", async () => {
    const { env, plist, launcher } = await home();
    const launchctl = fakeLaunchctl();
    const options = { env, execFileImpl: launchctl.execFileImpl, launcherCommand: [launcher], uid: 501 };

    expect((await runAutostartCommand([], options)).status).toBe("disabled");
    await runAutostartCommand(["enable"], options);
    expect((await runAutostartCommand(["status"], options)).status).toBe("enabled");
    launchctl.loaded = false;
    expect(await runAutostartCommand(["status"], options)).toMatchObject({
      status: "stale",
      loaded: false,
      plist,
    });
  });

  it("records a release install's current link so upgrades do not strand the agent", async () => {
    const { env, launcher } = await home();
    const install = await mkdtemp(join(tmpdir(), "clankie-autostart-install-"));
    tempDirs.push(install);
    const releaseRoot = join(install, "releases", "v0.2.0");
    await mkdir(join(releaseRoot, "bin"), { recursive: true });
    await writeFile(join(releaseRoot, "bin", "clankie"), "#!/bin/sh\n", { mode: 0o755 });
    await chmod(join(releaseRoot, "bin", "clankie"), 0o755);
    const releaseEnv = {
      ...env,
      CLANKIE_LAUNCHER_PATH: join(releaseRoot, "bin", "clankie"),
      CLANKIE_INSTALL_ROOT: releaseRoot,
    };
    const launchctl = fakeLaunchctl();

    const pinned = await runAutostartCommand(["status"], {
      env: releaseEnv,
      execFileImpl: launchctl.execFileImpl,
      uid: 501,
    });
    expect(pinned.command).toEqual([join(releaseRoot, "bin", "clankie"), "restart", "clankie"]);

    await symlink(join("releases", "v0.2.0"), join(install, "current"));
    const followed = await runAutostartCommand(["enable"], {
      env: releaseEnv,
      execFileImpl: launchctl.execFileImpl,
      uid: 501,
    });
    expect(followed.command).toEqual([join(install, "current", "bin", "clankie"), "restart", "clankie"]);
    expect(launcher).not.toBe(followed.command[0]);
  });

  it("refuses an unknown verb, extra arguments, and a launcher that cannot run", async () => {
    const { env, root } = await home();
    const launchctl = fakeLaunchctl();
    const options = { env, execFileImpl: launchctl.execFileImpl, uid: 501 };
    await expect(runAutostartCommand(["toggle"], options)).rejects.toThrow(/Usage: clankie autostart/u);
    await expect(runAutostartCommand(["enable", "now"], options)).rejects.toThrow(
      /Usage: clankie autostart/u,
    );
    await expect(
      runAutostartCommand(["enable"], { ...options, launcherCommand: [join(root, "missing")] }),
    ).rejects.toThrow(/not executable/u);
    expect(launchctl.calls).toEqual([]);
  });

  it("is a headless noun that prints one JSON document", async () => {
    const { env, root } = await home();
    const launchctl = fakeLaunchctl();
    let output = "";
    expect(HEADLESS_NOUNS).toContain("autostart");

    const exitCode = await runHeadlessCaptainCommand(["autostart", "status"], {
      repoRoot: root,
      env,
      execFileImpl: launchctl.execFileImpl,
      stdout: { write: (chunk: string) => (output += chunk) },
      stderr: { write: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, status: "disabled", label: AUTOSTART_LABEL });
  });
});
