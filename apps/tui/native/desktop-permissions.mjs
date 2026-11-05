import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** Fixed, non-prompting diagnostic. No environment-supplied actor identity. */
export async function probeDesktopActorPermissions() {
  if (process.platform !== "darwin") throw Error("unsupported");
  const signal = AbortSignal.timeout(8000);
  const ancestors = [];
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    ancestors.push(pid);
    const result = await exec("/bin/ps", ["-p", String(pid), "-o", "ppid="], { timeout: 2000, signal });
    const parent = Number(result.stdout.trim());
    if (!Number.isInteger(parent) || parent <= 1 || parent === pid) break;
    pid = parent;
  }
  // The helper inherits this terminal's responsible application. Find that
  // application through real process ancestry, never TERM_PROGRAM supplied by a caller.
  const script = `
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
function run() {
  var actor = null;
  var ancestors = ${JSON.stringify(ancestors)};
  for (var i = 0; i < ancestors.length; i++) {
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(ancestors[i]);
    if (app && !app.isNil() && app.bundleIdentifier && !app.bundleIdentifier.isNil()) {
      actor = {bundleId: ObjC.unwrap(app.bundleIdentifier), name: ObjC.unwrap(app.localizedName), pid: ancestors[i]};
      break;
    }
  }
  if (!actor) throw new Error('No terminal-host app in the process ancestry');
  return JSON.stringify({actor: actor, observedAt: new Date().toISOString(),
    accessibility: $.AXIsProcessTrusted() ? 'granted' : 'not_granted',
    screenRecording: $.CGPreflightScreenCaptureAccess() ? 'granted' : 'not_granted'});
}`;
  const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 8000,
    signal,
    maxBuffer: 4096,
  }).catch(() => {
    throw Error(
      "No permission report from the acting terminal. Run this check inside that Mac terminal app.",
    );
  });
  return JSON.parse(stdout);
}
