// A linked machine's way back to Clankie (VUH-1527). On a machine in one of
// his ssh fleets, he writes ~/.clankie/links/<fleet>.json per Herdr session:
// his service through a reverse ssh forward on this machine's loopback, and a
// token good only for the seat routes of panes on that fleet. Nothing else is installed here: these scripts
// need only Node, which Claude Code already brings.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEXT_MAX = 16_384;
export const SUMMARY_MAX = 512;
// A hire loads the worker per launch as `@inline` (ADR 0317); an older install's copy is `@clankie`.
const WORKER_CHANNELS = ["plugin:clankie-worker@inline", "plugin:clankie-worker@clankie"];

/** A socket path as this machine compares it: Windows paths are case-insensitive. */
function normalSocket(path) {
  const value = String(path ?? "").trim();
  return process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
}

/**
 * Where this process sits: its Herdr pane and that session's socket, else the Herdr
 * desktop app's terminal it runs in (ADR 0319), named `herdr-core/<address>` beside
 * the core's socket. Herdr's own variables win when either is set, and empty ones
 * are none: Clankie clears those a desktop-app core inherited from the Herdr pane
 * it was started in.
 */
export function seatIdentity(env = process.env) {
  const pane = env.HERDR_PANE_ID?.trim();
  const herdr = env.HERDR_SOCKET_PATH?.trim();
  if (pane || herdr) return { pane: pane || undefined, socket: herdr || undefined };
  const terminal = env.HC_TERMINAL_ID?.trim();
  const core = env.HC_TERMINAL_SOCKET?.trim();
  if (terminal && core && /^t\d+$/u.test(terminal)) return { pane: `herdr-core/${terminal}`, socket: core };
  return { pane: undefined, socket: undefined };
}

/**
 * The link for the Herdr session this pane is in, when this machine has one;
 * including Clankie’s own local fleet. One machine can host several of
 * his fleets, one per Herdr session, so the pane's own HERDR_SOCKET_PATH
 * chooses among <CLANKIE_STATE or ~/.clankie>/links/*.json.
 */
export function readLink(socket = seatIdentity().socket, env = process.env) {
  const dir = join(env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie"), "links");
  let links = [];
  try {
    links = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, name), "utf8"));
        } catch {
          return undefined;
        }
      })
      .filter(
        (link) =>
          (link?.schemaVersion === 1 ||
            (link?.schemaVersion === 2 && link.authentication === "local-process")) &&
          typeof link.fleet === "string" &&
          typeof link.socket === "string" &&
          /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(String(link.url)) &&
          (link.schemaVersion === 2 || (typeof link.token === "string" && link.token.length >= 32)),
      );
  } catch {
    return undefined;
  }
  if (links.length === 0) return undefined;
  const mine = links.filter((link) => normalSocket(link.socket) === normalSocket(socket));
  return mine.length === 1 ? mine[0] : undefined;
}

/** Whether this machine has any link at all: it is in one of his fleets. */
export function hasLinks(env = process.env) {
  try {
    return readdirSync(join(env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie"), "links")).some((name) =>
      name.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

/**
 * Node's built-in fetch before undici 8.10.0 (Node 26.7 ships 8.9.0) checks an
 * idle keep-alive socket through an unref'd setImmediate before reusing it, so
 * on an otherwise idle event loop the request is not written until some
 * unrelated timer wakes the loop (nodejs/undici#5600, #5606). A bridge sits idle
 * between its polls and acks, so its next request could wait out its own
 * timeouts. On those versions a link request keeps the loop awake for its first
 * moments. The socket is still reused, and the service's per-connection fleet
 * proof (ADR 0217) still holds.
 */
const STALLS_IDLE_REUSE = undiciBefore(process.versions.undici, [8, 10, 0]);
const WAKE_TICK_MS = 5;
const WAKE_WINDOW_MS = 250;

export function linkFetch(input, init) {
  if (!STALLS_IDLE_REUSE) return fetch(input, init);
  const wake = setInterval(() => {}, WAKE_TICK_MS);
  const settle = () => clearInterval(wake);
  const deadline = setTimeout(settle, WAKE_WINDOW_MS);
  return fetch(input, init).finally(() => {
    clearTimeout(deadline);
    settle();
  });
}

function undiciBefore(version, fixed) {
  if (typeof version !== "string") return false;
  const parts = version.split(".").map(Number);
  for (const [index, part] of fixed.entries()) {
    const value = parts[index] ?? 0;
    if (Number.isNaN(value)) return false;
    if (value !== part) return value < part;
  }
  return false;
}

/** One seat route on Clankie's service, for the pane this process sits in. */
export function seatRoute(link, paneId, route) {
  return new URL(`/v1/fleet/seats/${encodeURIComponent(paneId)}/${route}`, link.url);
}

export function authorization(link) {
  return link.authentication === "local-process"
    ? { "x-clankie-pane": seatIdentity().pane ?? "" }
    : { authorization: `Bearer ${link.token}` };
}

/** The command line of a process's parent: `ps` where it exists, PowerShell on Windows. */
export function parentCommandLine(pid = process.ppid) {
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(Number(pid))}").CommandLine`,
        ],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      ).trim();
    }
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch {
    return "";
  }
}

/** Command hooks may have a shell between them and Claude, including on Windows. */
export function claudeParentCommandLine() {
  let pid = process.ppid;
  for (let hop = 0; hop < 4 && Number.isSafeInteger(pid) && pid > 1; hop++) {
    try {
      let parent;
      if (process.platform === "win32") {
        parent = JSON.parse(
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"; @{pid=$p.ParentProcessId; argv=$p.CommandLine} | ConvertTo-Json -Compress`,
            ],
            { encoding: "utf8", timeout: 1000, windowsHide: true },
          ),
        );
      } else {
        const line = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 1000,
        }).trim();
        const match = /^(\d+)\s+(.+)$/u.exec(line);
        parent = { pid: Number(match?.[1]), argv: match?.[2] };
      }
      if (typeof parent.argv !== "string") return "";
      const executable = /^(?:"([^"]+)"|(\S+))/u.exec(parent.argv);
      const command = executable?.[1] ?? executable?.[2] ?? "";
      if (
        /^claude(?:[2-9])?(?:\.exe)?$/iu.test(command.split(/[\\/]/u).at(-1) ?? "") ||
        /[\\/]claude[\\/]versions[\\/][\d.]+$/iu.test(command)
      )
        return parent.argv;
      if (parent.pid === pid) return "";
      pid = parent.pid;
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Whether that Claude session approved this plugin's channel. Print mode never
 * shows channel events, so polling there would consume mail nobody sees.
 */
export function approvesWorkerChannel(argv) {
  const tokens = String(argv ?? "")
    .trim()
    .split(/\s+/u)
    .map((token) => token.replace(/^"(.*)"$/u, "$1"))
    .filter((token) => token.length > 0);
  if (tokens.includes("--print") || tokens.includes("-p")) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const flag = ["--channels", "--dangerously-load-development-channels"].find(
      (name) => token === name || token.startsWith(`${name}=`),
    );
    if (!flag) continue;
    if (token.startsWith(`${flag}=`)) {
      if (
        token
          .slice(flag.length + 1)
          .split(",")
          .some((entry) => WORKER_CHANNELS.includes(entry))
      )
        return true;
      continue;
    }
    for (const value of tokens.slice(index + 1)) {
      if (value.startsWith("-")) break;
      if (value.split(",").some((entry) => WORKER_CHANNELS.includes(entry))) return true;
    }
  }
  return false;
}
