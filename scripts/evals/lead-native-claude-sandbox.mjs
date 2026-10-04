/** Whole-process Claude boundary. No command is executed on import. */
export const CLAUDE = "/opt/claude/bin/claude";
export const CLAUDE_LAUNCHER = "/usr/local/lib/lead-native-claude-launch.py";
const CLAUDE_CONTROL = "/eval/control/claude";

/** This denies all network, including providers; it is not model-request admission. */
export function claudeSandboxArgs({ cwd = "/eval/tasks/lead", hooks = false } = {}) {
  if (cwd !== "/eval/tasks/lead") throw Error("Only the allocated Claude root is implemented");
  return [
    "--unshare-all",
    "--die-with-parent",
    "--as-pid-1",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/opt/claude",
    "/opt/claude",
    "--dir",
    "/etc",
    "--ro-bind-try",
    "/etc/ssl/certs",
    "/etc/ssl/certs",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/eval",
    "--dir",
    "/eval/tasks",
    "--bind",
    cwd,
    cwd,
    "--dir",
    "/eval/control",
    "--dir",
    CLAUDE_CONTROL,
    "--bind",
    `${CLAUDE_CONTROL}/home`,
    `${CLAUDE_CONTROL}/home`,
    "--bind",
    `${CLAUDE_CONTROL}/config`,
    `${CLAUDE_CONTROL}/config`,
    "--ro-bind",
    `${CLAUDE_CONTROL}/settings.json`,
    `${CLAUDE_CONTROL}/settings.json`,
    ...(hooks ? ["--ro-bind", `${CLAUDE_CONTROL}/collector`, `${CLAUDE_CONTROL}/collector`] : []),
    "--chdir",
    cwd,
  ];
}

export function claudeEnvironment({ paneId } = {}) {
  if (paneId !== undefined && !/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/u.test(paneId))
    throw Error("Invalid allocated Claude pane");
  return {
    PATH: "/opt/claude/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: `${CLAUDE_CONTROL}/home`,
    CLAUDE_CONFIG_DIR: `${CLAUDE_CONTROL}/config`,
    TMPDIR: "/tmp",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    ...(paneId ? { HERDR_PANE_ID: paneId } : {}),
  };
}
