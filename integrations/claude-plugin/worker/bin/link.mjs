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
const WORKER_CHANNEL = "plugin:clankie-worker@clankie";

/** A socket path as this machine compares it: Windows paths are case-insensitive. */
function normalSocket(path) {
  const value = String(path ?? "").trim();
  return process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
}

/**
 * The link for the Herdr session this pane is in, when this machine has one;
 * including Clankie’s own local fleet. One machine can host several of
 * his fleets, one per Herdr session, so the pane's own HERDR_SOCKET_PATH
 * chooses among <CLANKIE_STATE or ~/.clankie>/links/*.json.
 */
export function readLink(socket = process.env.HERDR_SOCKET_PATH, env = process.env) {
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

/** One seat route on Clankie's service, for the pane this process sits in. */
export function seatRoute(link, paneId, route) {
  return new URL(`/v1/fleet/seats/${encodeURIComponent(paneId)}/${route}`, link.url);
}

export function authorization(link) {
  return link.authentication === "local-process"
    ? { "x-clankie-pane": process.env.HERDR_PANE_ID?.trim() ?? "" }
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
    if (token.startsWith("--channels="))
      return token.slice("--channels=".length).split(",").includes(WORKER_CHANNEL);
    if (token !== "--channels") continue;
    for (const value of tokens.slice(index + 1)) {
      if (value.startsWith("-")) break;
      if (value.split(",").includes(WORKER_CHANNEL)) return true;
    }
  }
  return false;
}
