import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  lstat,
  realpath,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { build } from "esbuild";
import { installPaneShell, preparePaneShell, inspectPaneShim } from "../../herdr-plugin/claude-path-shim.mjs";

const exec = promisify(execFile);
const roots: string[] = [];
const worker = "clankie-worker@inline";
// This checkout's worker plugin, which the installed launcher hands to every launch (ADR 0317).
const workerRoot = new URL("../worker", import.meta.url).pathname.replace(/\/$/u, "");
const loaded = [
  "--plugin-dir",
  workerRoot,
  "--channels",
  `plugin:${worker}`,
  "--settings",
  '{"enabledPlugins":{"clankie-worker@clankie":false}}',
];
async function fixture() {
  const home = await realpath(await mkdtemp("/tmp/clankie-claude-shim-"));
  roots.push(home);
  const root = join(home, ".clankie/herdr-pane/default");
  const bin = join(home, "native");
  await mkdir(bin);
  await mkdir(join(home, ".claude"));
  await writeFile(
    join(home, ".claude/settings.json"),
    JSON.stringify({ enabledPlugins: { [worker]: true } }),
  );
  // A native child fixture records the process boundary, not a mocked executor.
  await writeFile(
    join(bin, "claude"),
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),pid:process.pid,cwd:process.cwd(),rc:process.env.OWNER_RC,login:process.env.OWNER_LOGIN,zd:process.env.ZDOTDIR,seatHarness:process.env.CLANKIE_SEAT_HARNESS??null,seatSession:process.env.CLANKIE_SEAT_SESSION_ID??null,seatParent:process.env.CLANKIE_SEAT_PARENT_ARGV??null})+'\\n'); process.exit(23);\n`,
    { mode: 0o700 },
  );
  const env = {
    HOME: home,
    SHELL: "/bin/zsh",
    PATH: `${bin}:/usr/bin:/bin`,
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_SOCKET_PATH: join(home, "herdr.sock"),
    CLANKIE_CLAUDE_SHIM_SOCKET: join(home, "herdr.sock"),
  };
  const paneShell = await installPaneShell({ root, socketPath: env.HERDR_SOCKET_PATH, owner: env });
  env.PATH = `${root}/bin:${env.PATH}`;
  const launch = async (args: string[], overrides = {}) => {
    try {
      await exec(join(root, "bin/claude"), args, { env: { ...env, ...overrides }, cwd: home });
      throw new Error("Expected the native child's exit status");
    } catch (error) {
      const result = error as { code: number; stdout: string };
      expect(result.code).toBe(23);
      return JSON.parse(result.stdout) as { args: string[]; cwd: string };
    }
  };
  return { home, root, bin, env, paneShell, launch };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("a bundled consumer can diagnose an unprepared shim without a standalone launcher asset", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-shim-consumer-")));
  roots.push(root);
  const entry = join(root, "consumer.mjs");
  await build({
    stdin: {
      contents: `import {inspectPaneShim} from './integrations/herdr-plugin/claude-path-shim.mjs'; console.log(JSON.stringify(await inspectPaneShim(JSON.parse(process.argv[2]))));`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: entry,
  });
  const result = await exec(process.execPath, [
    entry,
    JSON.stringify({ root: join(root, "unprepared"), configPath: join(root, "herdr.toml"), env: {} }),
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    installed: false,
    configured: false,
    active: false,
    state: "not-configured",
  });
});

it.skipIf(process.platform !== "darwin")(
  "copies the standalone launcher when preparation runs from a real release-layout bundle",
  async () => {
    const f = await fixture();
    const release = join(f.home, "release");
    const asset = join(release, "integrations/herdr-plugin/claude-path-shim.mjs");
    await mkdir(join(release, "integrations/herdr-plugin"), { recursive: true });
    await copyFile(new URL("../../herdr-plugin/claude-path-shim.mjs", import.meta.url), asset);
    // A release carries its worker plugin beside the shim.
    const releaseWorker = join(release, "integrations/claude-plugin/worker");
    await mkdir(join(releaseWorker, ".claude-plugin"), { recursive: true });
    await writeFile(join(releaseWorker, ".claude-plugin/plugin.json"), "{}");
    const entry = join(release, "apps/clankie/src/index.mjs");
    await build({
      stdin: {
        contents: `import {installPaneShell} from './integrations/herdr-plugin/claude-path-shim.mjs'; await installPaneShell(JSON.parse(process.argv[2]));`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: entry,
    });
    await exec(process.execPath, [
      entry,
      JSON.stringify({ root: f.root, socketPath: f.env.HERDR_SOCKET_PATH, owner: f.env }),
    ]);
    expect(await readFile(join(f.root, "claude-path-shim.mjs"), "utf8")).toBe(await readFile(asset, "utf8"));
    expect((await f.launch(["--resume", "released-session"])).args).toEqual([
      ...loaded.with(1, releaseWorker),
      "--resume",
      "released-session",
    ]);
  },
);

it.skipIf(process.platform !== "darwin")(
  "adds one channel to plain and resumed launches, preserving native argv, cwd and exit status",
  async () => {
    const f = await fixture();
    // /tmp is a real macOS alias of /private/tmp. Bake that spelling into
    // the launcher to exercise the canonical entry guard as well as argv.
    await installPaneShell({
      root: f.root.replace(/^\/private\/tmp/u, "/tmp"),
      socketPath: f.env.HERDR_SOCKET_PATH,
      owner: f.env,
    });
    for (const args of [
      [],
      ["--resume", "session-1"],
      ["--model", "sonnet", "--", "a prompt with 'quotes' $and `text`"],
    ]) {
      expect(await f.launch(args)).toMatchObject({
        args: [...loaded, ...args],
        cwd: f.home,
      });
    }
    for (const args of [
      ["--channels", "plugin:other@market"],
      ["--channels=plugin:other@market", "--resume", "session-1"],
      ["--settings", '{"enabledPlugins":{}}'],
      ["--setting-sources", ""],
      ["--bare"],
      ["plugin", "list"],
      ["--print", "hello"],
    ]) {
      expect((await f.launch(args)).args).toEqual(args);
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "passes through outside the selected managed pane and after a plugin is disabled",
  async () => {
    const f = await fixture();
    const args = ["--resume", "session-1"];
    for (const overrides of [
      { HERDR_ENV: "" },
      { HERDR_PANE_ID: "" },
      { HERDR_SOCKET_PATH: "/other.sock" },
      { CLAUDECODE: "1" },
    ])
      expect((await f.launch(args, overrides)).args).toEqual(args);
    await mkdir(join(f.home, "alternate"));
    expect((await f.launch(args, { CLAUDE_CONFIG_DIR: join(f.home, "alternate") })).args).toEqual(args);
    await writeFile(
      join(f.home, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { [worker]: false } }),
    );
    expect((await f.launch(args)).args).toEqual(args);
    // Switching off the older installed copy's name opts out the same way.
    await writeFile(
      join(f.home, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": false } }),
    );
    expect((await f.launch(args)).args).toEqual(args);
    await writeFile(
      join(f.home, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { [worker]: true } }),
    );
    // The same directory here is home and project; use a separate cwd for project overrides below.
    const project = join(f.home, "project");
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      join(project, ".claude/settings.local.json"),
      JSON.stringify({ enabledPlugins: { [worker]: false } }),
    );
    const result = await exec(join(f.root, "bin/claude"), args, { env: f.env, cwd: project }).catch(
      (error) => error,
    );
    expect(result.code).toBe(23);
    expect(JSON.parse(result.stdout).args).toEqual(args);
  },
);

it.skipIf(process.platform !== "darwin")(
  "skips another installed shim and a symlink to it without recursion",
  async () => {
    const f = await fixture();
    const second = join(f.home, "second");
    await installPaneShell({ root: second, socketPath: f.env.HERDR_SOCKET_PATH, owner: f.env });
    const alias = join(f.home, "alias");
    await mkdir(alias);
    await symlink(join(second, "bin/claude"), join(alias, "claude"));
    expect(
      (await f.launch([], { PATH: `${f.root}/bin:${alias}:${second}/bin:${f.bin}:/usr/bin:/bin` })).args,
    ).toEqual(loaded);
    const missing = await exec(join(f.root, "bin/claude"), [], {
      env: { ...f.env, PATH: `${f.root}/bin:${alias}` },
    }).catch((error) => error);
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain("No real claude on PATH");
  },
);

it.skipIf(process.platform !== "darwin")(
  "wins after real zsh login startup reorders PATH and preserves the owner's ZDOTDIR",
  async () => {
    const f = await fixture();
    const ownerConfig = join(f.home, "owner-zsh");
    await mkdir(ownerConfig);
    await writeFile(join(f.home, ".zshenv"), `export ZDOTDIR='${ownerConfig}'\n`);
    await writeFile(join(ownerConfig, ".zshrc"), "export OWNER_RC=loaded\n");
    await writeFile(
      join(ownerConfig, ".zlogin"),
      `export OWNER_LOGIN=loaded\nexport PATH='${f.bin}:/usr/bin:/bin'\n`,
    );
    // A real interactive PTY loads .zshrc and .zlogin. macOS script requires
    // a terminal on its own stdin, so use the OS pty boundary directly.
    const { stdout } = await exec(
      "/usr/bin/python3",
      [
        "-c",
        `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1]])
os.write(fd, b"claude --resume original-session\\nexit\\n")
while True:
    try:
        data = os.read(fd, 65536)
        if not data: break
        sys.stdout.buffer.write(data)
    except OSError: break
os.close(fd)
os.waitpid(pid, 0)
`,
        f.paneShell,
      ],
      {
        env: {
          ...f.env,
          CLANKIE_SEAT_HARNESS: "claude",
          CLANKIE_SEAT_SESSION_ID: "lead-session",
          CLANKIE_SEAT_PARENT_ARGV: "lead-argv",
        },
        cwd: f.home,
        timeout: 10_000,
      },
    );
    expect(stdout).toContain(`"args":${JSON.stringify([...loaded, "--resume", "original-session"])}`);
    expect(stdout).toContain('"rc":"loaded","login":"loaded"');
    expect(stdout).toContain(`"zd":"${ownerConfig}"`);
    expect(stdout).toContain('"seatHarness":null,"seatSession":null,"seatParent":null');
  },
);

it.skipIf(process.platform !== "darwin")(
  "prepares a stable shell through a config symlink idempotently and removes it without losing owner edits",
  async () => {
    const f = await fixture();
    const source = join(f.home, "canonical.toml");
    const configPath = join(f.home, "config.toml");
    const original = 'onboarding = false\n[ui]\nagent_panel_sort = "spaces"  \n\n';
    await writeFile(source, original);
    await symlink(source, configPath);
    const options = { root: f.root, configPath, socketPath: f.env.HERDR_SOCKET_PATH, owner: f.env };
    expect((await preparePaneShell(options)).changed).toBe(true);
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    const installed = await readFile(source, "utf8");
    expect(installed.startsWith(original)).toBe(true);
    expect((await preparePaneShell(options)).changed).toBe(false);
    expect(await inspectPaneShim({ ...options, env: f.env })).toMatchObject({
      installed: true,
      configured: true,
      active: true,
    });
    await preparePaneShell({ ...options, action: "remove" });
    expect(await readFile(source, "utf8")).toBe(original);
    expect(await inspectPaneShim({ ...options, env: { ...f.env, HERDR_ENV: "" } })).toMatchObject({
      configured: false,
      active: false,
    });
    await preparePaneShell(options);
    await writeFile(source, `${await readFile(source, "utf8")}\n[advanced]\nscrollback_limit_bytes = 1000\n`);
    await preparePaneShell({ ...options, action: "remove" });
    expect(await readFile(source, "utf8")).toContain("scrollback_limit_bytes = 1000");
    expect(await readFile(source, "utf8")).not.toContain("default_shell");
    await writeFile(source, '[terminal]\ndefault_shell = "/owner/launcher"\n');
    await expect(preparePaneShell(options)).rejects.toThrow("preserve");
    expect(await readFile(source, "utf8")).toContain('default_shell = "/owner/launcher"');
  },
);
