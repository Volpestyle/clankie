/** Collector hook configuration only: no native runtime, Herdr or service code is imported here. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SOCKET = "/eval/control/claude/collector/hooks.sock";
export const CONTROL = "/eval/control/claude/collector";
export const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "SessionEnd",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HOOK = `import socket,sys\nraw=sys.stdin.buffer.read(65537)\nif len(raw)>65536:sys.exit(2)\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)\ns.settimeout(15)\ns.connect(${JSON.stringify(SOCKET)})\ns.sendall(raw)\ns.shutdown(socket.SHUT_WR)\nif s.recv(3)!=b"ok\\n":sys.exit(2)\ns.close()\n`;

export function privateDirectory(path) {
  if (resolve(path) !== path || realpathSync(path) !== path)
    throw Error("Canonical collector directory required");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw Error("Private controller directory required");
  return { device: stat.dev, inode: stat.ino };
}

/** Writes only collector hook configuration. A future verified runtime must select it explicitly. */
export function writeNativeClaudeCollectorHooks(root) {
  privateDirectory(root);
  privateDirectory(join(root, "control"));
  privateDirectory(join(root, "control/claude"));
  const directory = join(root, "control/claude/collector");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "hook.py"), HOOK, { flag: "wx", mode: 0o500 });
  const settings = {
    disableAllHooks: false,
    enabledPlugins: {},
    permissions: { defaultMode: "default", deny: ["mcp__*", "WebFetch", "WebSearch"] },
    hooks: Object.fromEntries(
      EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: "command", command: `/usr/bin/python3 -I ${CONTROL}/hook.py`, timeout: 20 }] }],
      ]),
    ),
  };
  writeFileSync(join(directory, "settings.json"), JSON.stringify(settings, null, 2) + "\n", {
    flag: "wx",
    mode: 0o400,
  });
  return { settingsPath: `${CONTROL}/settings.json`, settings, hookSha256: hash(HOOK), launchAllowed: false };
}
