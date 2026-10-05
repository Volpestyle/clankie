/** The bounded Codex argv contract shared by the Windows probe and its TypeScript projection. */
export const WINDOWS_CODEX_ARGV = {
  commands: ["app-server", "resume", "fork"],
  maintenance: [
    "agents",
    "tcp-tunnel",
    "exec",
    "e",
    "review",
    "login",
    "logout",
    "mcp",
    "mcp-server",
    "plugin",
    "remote-control",
    "app",
    "completion",
    "update",
    "doctor",
    "sandbox",
    "debug",
    "execpolicy",
    "apply",
    "a",
    "queue",
    "archive",
    "delete",
    "migrate-rollouts",
    "unarchive",
    "cloud",
    "cloud-tasks",
    "responses-api-proxy",
    "stdio-to-uds",
    "exec-server",
    "features",
    "help",
    "daemon",
    "proxy",
  ],
  values: [
    "-c",
    "--config",
    "-m",
    "--model",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-a",
    "--ask-for-approval",
    "-C",
    "--cd",
    "-i",
    "--image",
    "--add-dir",
    "--enable",
    "--disable",
    "--local-provider",
    "--code-mode-host",
    "--remote",
    "--listen",
    "--ws-auth",
    "--ws-token-file",
    "--ws-token-sha256",
    "--ws-shared-secret-file",
    "--ws-issuer",
    "--ws-audience",
    "--ws-max-clock-skew-seconds",
  ],
  flags: [
    "--no-daemon",
    "--no-alt-screen",
    "--search",
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--oss",
    "--strict-config",
    "--analytics-default-enabled",
    "--stdio",
    "--last",
    "--all",
  ],
  stops: ["--help", "-h", "--version", "-V"],
  roles: { server: "server", tui: "tui", uncertainServer: "server", uncertainTui: "other" },
  loopback: String.raw`ws://127\.0\.0\.1:(0|[1-9][0-9]{0,4})/?`,
} as const;

export interface WindowsCodexArgvProjection {
  readonly role: "server" | "tui" | "other" | "unavailable";
  readonly endpoint: string | null;
  readonly standalone: boolean;
}

/** Native argv stays inside Windows; callers use only this role/endpoint/standalone projection. */
export function classifyWindowsCodexArgv(args: readonly string[]): WindowsCodexArgvProjection {
  if (args.length < 1 || args.length > 256 || args.some((arg) => arg.includes("\0")))
    return { role: "unavailable", endpoint: null, standalone: false };
  const commands = new Set<string>(WINDOWS_CODEX_ARGV.commands);
  const maintenance = new Set<string>(WINDOWS_CODEX_ARGV.maintenance);
  const values = new Set<string>(WINDOWS_CODEX_ARGV.values);
  const flags = new Set<string>(WINDOWS_CODEX_ARGV.flags);
  const stops = new Set<string>(WINDOWS_CODEX_ARGV.stops);
  let command: string | undefined, remote: string | undefined, listen: string | undefined;
  let remotes = 0,
    listens = 0,
    positionals = 0;
  let noDaemon = false;
  const uncertain = (): WindowsCodexArgvProjection => ({
    role:
      command === "app-server"
        ? WINDOWS_CODEX_ARGV.roles.uncertainServer
        : WINDOWS_CODEX_ARGV.roles.uncertainTui,
    endpoint: null,
    standalone: false,
  });
  for (let n = 1; n < args.length; n++) {
    const arg = args[n]!;
    if (stops.has(arg)) return uncertain();
    if (arg === "--") {
      const remaining = args.length - n - 1;
      if (command === "app-server" || remaining > 1 || (command === undefined && positionals + remaining > 1))
        return uncertain();
      positionals += remaining;
      break;
    }
    if (arg.startsWith("-")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (values.has(name)) {
        const value = equals >= 0 ? arg.slice(equals + 1) : args[++n];
        if (value === undefined) return uncertain();
        if (name === "--remote") {
          remote = value;
          remotes++;
        }
        if (name === "--listen") {
          listen = value;
          listens++;
        }
      } else if (equals < 0 && flags.has(name)) {
        if (name === "--no-daemon") noDaemon = true;
      } else return uncertain();
    } else if (command === undefined && positionals === 0) {
      if (commands.has(arg)) command = arg;
      else if (maintenance.has(arg)) return uncertain();
      else positionals = 1;
    } else if (command === "app-server" || (command === undefined && ++positionals > 1)) return uncertain();
  }
  const loopback = (value: string | undefined, allowZero: boolean): string | null => {
    if (value === undefined || !new RegExp(`^${WINDOWS_CODEX_ARGV.loopback}(?![\\s\\S])`, "u").test(value))
      return null;
    const port = Number(value.slice(15).replace(/\/$/u, ""));
    return port <= 65_535 && (allowZero || port > 0) ? `ws://127.0.0.1:${port}` : null;
  };
  if (command === "app-server")
    return {
      role: WINDOWS_CODEX_ARGV.roles.server,
      endpoint: remotes === 0 && listens === 1 && !noDaemon ? loopback(listen, true) : null,
      standalone: false,
    };
  return {
    role: WINDOWS_CODEX_ARGV.roles.tui,
    endpoint: remotes === 1 && listens === 0 && !noDaemon ? loopback(remote, false) : null,
    standalone: remotes === 0 && listens === 0,
  };
}

/** Only canonical, source-owned strings are emitted as C# string constants. */
export function windowsCodexArgvSet(values: readonly string[]): string {
  return `new System.Collections.Generic.HashSet<string>(new string[]{${values.map((value) => JSON.stringify(value)).join(",")}})`;
}
