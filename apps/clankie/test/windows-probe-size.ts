/**
 * Every generated Windows probe command at its largest inputs, measured on the
 * Node that runs this script. Windows caps a command line at 32,767 characters
 * and gzip output varies by Node's zlib, so the release smoke also runs this on
 * the bundled runtime (VUH-2516).
 */
import {
  windowsCanonicalCommand,
  windowsCodexForwardCommand,
  windowsGitWorktreeCommand,
  windowsOriginUrlCommand,
  windowsProcessCommand,
  windowsWorktreeRootCommand,
} from "../src/windows-process-probe.ts";

const LIMIT = 30_000;
// MAX_PATH-length paths and every optional process projection at once.
const path = `C:\\${"a".repeat(120)}\\${"b".repeat(120)}\\worktree`;
const process_ = {
  session: "s".repeat(64),
  pane: "w99999:p99999",
  clientPort: 65_535,
  serverPort: 65_535,
  privateServer: { pid: 4_294_967_295, port: 65_535 },
  codexControl: true,
  codexDefaultHome: true,
};
const commands = {
  process: windowsProcessCommand(process_),
  processBatch: windowsProcessCommand({
    ...process_,
    panes: ["w99999:p99991", "w99999:p99992", "w99999:p99993", "w99999:p99994"],
  }),
  canonical: windowsCanonicalCommand(path),
  codexForward: windowsCodexForwardCommand(65_535),
  gitWorktree: windowsGitWorktreeCommand(path, path),
  originUrl: windowsOriginUrlCommand(path),
  worktreeRoot: windowsWorktreeRootCommand(path, path),
};
const sizes = Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, command.length]));
const over = Object.entries(sizes).filter(([, size]) => size > LIMIT);
console.log(JSON.stringify({ node: process.version, zlib: process.versions.zlib, limit: LIMIT, sizes }));
if (over.length) {
  console.error(`Windows probe commands over ${LIMIT} characters: ${over.map(([name]) => name).join(", ")}`);
  process.exitCode = 1;
}
