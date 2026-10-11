#!/usr/bin/env node
// Clankie's pane-local launcher. It conveys no authority: the worker bridge
// still proves the native pane/session and the channel policy still applies.
import { access, copyFile, mkdir, readFile, realpath, writeFile, chmod, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const plugin = "clankie-worker@clankie";
const channel = `plugin:${plugin}`;
// Release entrypoints live under apps/*/{src,bin}. Their import.meta.url
// names the bundle; copy the standalone asset shipped alongside it instead.
const modulePath = fileURLToPath(import.meta.url);
const here = await realpath(
  basename(modulePath) === "claude-path-shim.mjs"
    ? modulePath
    : new URL("../../../integrations/herdr-plugin/claude-path-shim.mjs", import.meta.url),
);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

/** Skip every copy/symlink of our launcher, without removing PATH from Claude's children. */
async function realClaude(env = process.env) {
  for (const directory of (env.PATH ?? "").split(":")) {
    const candidate = resolve(directory || ".", "claude");
    try {
      await access(candidate, constants.X_OK);
      const target = await realpath(candidate);
      if (target === here) continue;
      // Generated launchers are tiny; only read those, never a native executable.
      if (
        (await stat(target)).size < 1024 &&
        (await readFile(target, "utf8")).includes("# clankie-claude-path-shim")
      )
        continue;
      return candidate;
    } catch {
      /* Missing/non-executable PATH entry. */
    }
  }
  throw new Error(
    "No real claude on PATH after excluding Clankie's shim; install Claude Code or repair PATH.",
  );
}

function managedPane(env = process.env) {
  return (
    env.HERDR_ENV === "1" &&
    Boolean(env.HERDR_PANE_ID) &&
    Boolean(env.HERDR_SOCKET_PATH) &&
    env.HERDR_SOCKET_PATH === env.CLANKIE_CLAUDE_SHIM_SOCKET
  );
}

async function claudeArguments(args, env = process.env, cwd = process.cwd()) {
  const options = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  // Explicit channels and alternate settings belong wholly to the caller.
  // Administrative/print modes aren't interactive worker receivers.
  if (
    !managedPane(env) ||
    env.CLAUDECODE ||
    env.CLAUDE_CODE_SIMPLE === "1" ||
    options.some((arg) => /^(?:--channels|--settings|--setting-sources)(?:=|$)/u.test(arg)) ||
    options.some((arg) => ["--bare", "--print", "-p", "--help", "-h", "--version", "-v"].includes(arg)) ||
    ["plugin", "plugins", "mcp", "auth", "install", "update", "upgrade", "doctor", "setup-token"].includes(
      args[0],
    )
  )
    return args;
  const profile = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  try {
    // Read on every launch, including resume; never cache an enable/disable decision.
    let enabled = (await json(join(profile, "settings.json"))).enabledPlugins?.[plugin];
    for (const name of ["settings.json", "settings.local.json"]) {
      const settings = await json(join(cwd, ".claude", name)).catch((error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      });
      if (settings.enabledPlugins?.[plugin] !== undefined) enabled = settings.enabledPlugins[plugin];
    }
    // The repository-root local override also applies from subdirectories/worktrees.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = await promisify(execFile)("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      env,
      timeout: 1000,
    }).catch(() => undefined);
    if (git) {
      const root = dirname(resolve(cwd, git.stdout.trim()));
      if (root !== cwd) {
        const settings = await json(join(root, ".claude", "settings.local.json")).catch((error) => {
          if (error.code === "ENOENT") return {};
          throw error;
        });
        if (settings.enabledPlugins?.[plugin] !== undefined) enabled = settings.enabledPlugins[plugin];
      }
    }
    return enabled === true ? ["--channels", channel, ...args] : args;
  } catch {
    return args;
  } // Unreadable/invalid settings never manufacture an opt-in.
}

/** Stable installed files; the config reference never names a checkout or release version. */
export async function installPaneShell({ root, socketPath, owner = process.env, restore = {} }) {
  if (process.platform !== "darwin")
    throw new Error("Automatic Claude PATH shim currently supports Mac zsh; linked Windows is a follow-up.");
  const shell = owner.SHELL?.trim() || "/bin/zsh";
  if (!shell.endsWith("/zsh"))
    throw new Error(`Claude PATH shim requires zsh on this Mac; selected shell: ${shell}`);
  await mkdir(join(root, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "zsh"), { recursive: true, mode: 0o700 });
  const runner = join(root, "claude-path-shim.mjs");
  if ((await realpath(runner).catch(() => undefined)) !== here) await copyFile(here, runner);
  const launcher = join(root, "bin", "claude");
  await writeFile(
    launcher,
    `#!/bin/sh\n# clankie-claude-path-shim\nexec ${quote(process.execPath)} ${quote(runner)} "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(launcher, 0o700);
  const overlay = join(root, "zsh");
  const prepend = `export PATH=${quote(join(root, "bin"))}:"$PATH"\nexport CLANKIE_CLAUDE_SHIM_SOCKET=${quote(socketPath)}\n`;
  for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
    // Present the owner's actual ZDOTDIR while sourcing their files, honoring
    // changes made by .zshenv. Only redirect zsh's subsequent startup-file lookup.
    const content = [
      'if [[ "$CLANKIE_OWNER_ZDOTDIR_SET" = 1 ]]; then export ZDOTDIR="$CLANKIE_OWNER_ZDOTDIR"; else unset ZDOTDIR; fi',
      `[[ ! -f "\${ZDOTDIR:-$HOME}/${name}" ]] || source "\${ZDOTDIR:-$HOME}/${name}"`,
      "export CLANKIE_OWNER_ZDOTDIR_SET=${+ZDOTDIR}",
      "export CLANKIE_OWNER_ZDOTDIR=${ZDOTDIR-}",
      prepend,
      ...(name === ".zlogin"
        ? ["unset CLANKIE_OWNER_ZDOTDIR CLANKIE_OWNER_ZDOTDIR_SET"]
        : [`export ZDOTDIR=${quote(overlay)}`]),
      "",
    ].join("\n");
    await writeFile(join(overlay, name), content, { mode: 0o600 });
  }
  const paneShell = join(root, "pane-shell");
  await writeFile(
    paneShell,
    [
      "#!/bin/sh",
      "# Clankie-owned login shell; only future panes use this setup.",
      ...Object.entries(restore).map(([key, value]) =>
        value === undefined ? `unset ${key}` : `export ${key}=${quote(value)}`,
      ),
      `export SHELL=${quote(shell)}`,
      'if [ "${ZDOTDIR+x}" = x ]; then export CLANKIE_OWNER_ZDOTDIR_SET=1 CLANKIE_OWNER_ZDOTDIR="$ZDOTDIR"; else export CLANKIE_OWNER_ZDOTDIR_SET=0 CLANKIE_OWNER_ZDOTDIR=; fi',
      `export ZDOTDIR=${quote(overlay)}`,
      `exec ${quote(shell)} -l`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(paneShell, 0o700);
  return paneShell;
}

/** Patch only the terminal's shell, including configs linked to their canonical source. */
function replaceDefaultShell(config, value) {
  const line = value === undefined ? undefined : `default_shell = ${JSON.stringify(value)}`;
  const section = /^[ \t]*\[terminal\][ \t]*(?:#.*)?\r?$/mu.exec(config);
  if (!section)
    return line ? `${config}${config.endsWith("\n") ? "\n" : "\n\n"}[terminal]\n${line}\n` : config;
  const start = section.index + section[0].length;
  const next = /^[ \t]*\[/mu.exec(config.slice(start));
  const end = next ? start + next.index : config.length;
  const body = config.slice(start, end);
  const match = /^[ \t]*default_shell[ \t]*=.*(?:\r?\n|$)/mu;
  const patched = match.test(body)
    ? body.replace(match, line ? `${line}\n` : "")
    : line
      ? `\n${line}\n${body.replace(/^\r?\n/u, "")}`
      : body;
  return config.slice(0, start) + patched + config.slice(end);
}

export async function preparePaneShell({
  root,
  socketPath,
  configPath,
  owner = process.env,
  action = "install",
}) {
  const metadata = join(root, "installation.json");
  const previous = await json(metadata).catch(() => undefined);
  const canonical = await realpath(configPath);
  const config = await readFile(canonical, "utf8");
  const current = /^[ \t]*\[terminal\][^\n]*\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/mu.exec(config)?.[1];
  const shellValue = /^[ \t]*default_shell[ \t]*=[ \t]*("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$/mu.exec(
    current ?? "",
  )?.[1];
  if (/^[ \t]*default_shell[ \t]*=/mu.test(current ?? "") && !shellValue)
    throw new Error("Existing default_shell uses unsupported TOML syntax; leaving it untouched.");
  const selected = shellValue ? JSON.parse(shellValue) : undefined;
  const paneShell = join(root, "pane-shell");
  if (action === "remove") {
    if (!previous || previous.configPath !== canonical || selected !== paneShell)
      throw new Error("Claude shim no longer owns default_shell; leaving current configuration untouched.");
    const restored =
      config === previous.installedConfig
        ? previous.previousConfig
        : replaceDefaultShell(config, previous.previousShell ?? undefined);
    if ((await readFile(canonical, "utf8")) !== config)
      throw new Error("Herdr configuration changed during setup; inspect before retrying.");
    await writeFile(canonical, restored);
    return { action, configPath, canonical, paneShell, changed: true };
  }
  if (selected && selected !== paneShell && !selected.endsWith("/zsh"))
    throw new Error(
      `Existing default_shell is ${selected}; preserve that owner's launcher and prepare it explicitly.`,
    );
  await installPaneShell({
    root,
    socketPath,
    owner: { ...owner, SHELL: selected && selected !== paneShell ? selected : owner.SHELL },
  });
  const patched = replaceDefaultShell(config, paneShell);
  if (selected !== paneShell)
    await writeFile(
      metadata,
      JSON.stringify({
        configPath: canonical,
        previousShell: selected ?? null,
        previousConfig: config,
        installedConfig: patched,
      }),
      { mode: 0o600 },
    );
  if ((await readFile(canonical, "utf8")) !== config)
    throw new Error("Herdr configuration changed during setup; inspect before retrying.");
  if (patched !== config) await writeFile(canonical, patched);
  return { action, configPath, canonical, paneShell, changed: patched !== config };
}

export async function inspectPaneShim({ root, configPath, env = process.env }) {
  const paneShell = join(root, "pane-shell");
  const config = await readFile(configPath, "utf8").catch(() => "");
  const section = /^[ \t]*\[terminal\][^\n]*\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/mu.exec(config)?.[1] ?? "";
  const selected = /^[ \t]*default_shell[ \t]*=[ \t]*("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$/mu.exec(section)?.[1];
  const configured = selected !== undefined && JSON.parse(selected) === paneShell;
  const installed = await access(join(root, "bin", "claude"), constants.X_OK).then(
    () => true,
    () => false,
  );
  const active = managedPane(env) && resolve((env.PATH ?? "").split(":")[0] || ".") === join(root, "bin");
  return {
    installed,
    configured,
    active,
    paneShell,
    state: active
      ? "active"
      : managedPane(env) && configured && installed
        ? "shadowed-in-pane"
        : configured && installed
          ? "configured-for-new-panes"
          : "not-configured",
    detail: active
      ? "PATH shim selected in this managed pane; live delivery still needs a native channel poll."
      : "Open a new pane after preparation; existing shells and Claude sessions keep their launch configuration.",
  };
}

if (process.argv[1] && (await realpath(process.argv[1]).catch(() => undefined)) === here) {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
    const executable = await realClaude(env);
    const args = await claudeArguments(process.argv.slice(2), env);
    process.execve(executable, [executable, ...args], env);
  } catch (error) {
    process.stderr.write(`clankie claude shim: ${error.message}\n`);
    process.exitCode = 127;
  }
}
