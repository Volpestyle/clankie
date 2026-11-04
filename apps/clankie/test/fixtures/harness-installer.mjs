// Stands in for a vendor installer (#737) so no real Claude Code or Codex install
// ever runs in tests. It writes progress the way installers do (colour codes,
// carriage returns), then, like the real ones, puts the harness's command on PATH.
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [bin, harness, mode] = process.argv.slice(2);
process.stdout.write("Downloading the installer…\n");
process.stderr.write("\u001b[32mInstalling\u001b[0m 9.9.9\r\n");
if (mode === "stuck") {
  // Ignores the timeout's SIGTERM, as a wedged installer would; only SIGKILL ends it.
  process.on("SIGTERM", () => process.stdout.write("ignoring SIGTERM\n"));
  for (;;) await new Promise((done) => setTimeout(done, 1_000));
}
if (mode === "hold")
  while (!existsSync(join(bin, "release"))) await new Promise((done) => setTimeout(done, 20));
if (mode === "fail") {
  process.stderr.write("Checksum mismatch\n");
  process.exit(3);
}
if (mode !== "noop") {
  // The installed command answers its own status as signed out, as a fresh install does.
  const status =
    harness === "claude"
      ? `echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`
      : `echo 'Not logged in'; exit 1`;
  writeFileSync(join(bin, harness), `#!/bin/sh\n${status}\n`);
  chmodSync(join(bin, harness), 0o755);
}
process.stdout.write(`${harness} installed\n`);
