// A linked machine's way back to Clankie (VUH-1527). On a machine in one of
// his ssh fleets, he writes ~/.clankie/link.json: his service through a reverse
// ssh forward on this machine's loopback, and a token good only for the seat
// routes of panes on this fleet. Nothing else is installed here: these scripts
// need only Node, which Claude Code already brings.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEXT_MAX = 16_384;
export const SUMMARY_MAX = 512;
const WORKER_CHANNEL = "plugin:clankie-worker@clankie";

/** The link, when this machine has one; a Mac running Clankie itself never does. */
export function readLink() {
  try {
    const link = JSON.parse(readFileSync(join(homedir(), ".clankie", "link.json"), "utf8"));
    const valid =
      link?.schemaVersion === 1 &&
      typeof link.fleet === "string" &&
      /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(String(link.url)) &&
      typeof link.token === "string" &&
      link.token.length >= 32;
    return valid ? link : undefined;
  } catch {
    return undefined;
  }
}

/** One seat route on Clankie's service, for the pane this process sits in. */
export function seatRoute(link, paneId, route) {
  return new URL(`/v1/fleet/seats/${encodeURIComponent(paneId)}/${route}`, link.url);
}

export function authorization(link) {
  return { authorization: `Bearer ${link.token}` };
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
