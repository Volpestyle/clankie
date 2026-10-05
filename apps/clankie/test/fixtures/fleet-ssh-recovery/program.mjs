import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const root = process.env.CLANKIE_FLEET_SSH_FIXTURE;
const args = process.argv.slice(2);
const mode = JSON.parse(readFileSync(join(root, "login.json"), "utf8")).mode;
appendFileSync(
  join(root, "program.jsonl"),
  `${JSON.stringify({ args, directory: dirname(process.argv[1]), cwd: process.cwd() })}\n`,
);
if (mode === "herdr-business-error") {
  process.stdout.write(
    JSON.stringify({
      error: { code: "server_not_running", message: "The requested session is not running" },
    }),
  );
  process.exitCode = 1;
} else if (mode === "native-business-error") {
  process.stderr.write("Application rejected the mutation\n");
  process.exitCode = 1;
} else if (mode === "native-business-launcher-error") {
  // This process has already recorded the mutation. Its own missing
  // dependency produces the same PS diagnostic as a failed outer launcher,
  // but it cannot know that launcher's per-command marker.
  process.stderr.write(
    readFileSync(new URL("missing-command.clixml", import.meta.url), "utf8").replaceAll(
      "{{PROGRAM}}",
      "dependency",
    ),
  );
  process.exitCode = 127;
} else if (args.includes("session") && args.includes("list")) {
  process.stdout.write(
    JSON.stringify({ sessions: [{ name: "default", socket_path: "C:\\fixture\\herdr.sock" }] }),
  );
} else {
  process.stdout.write(
    JSON.stringify({ result: { environment: basename(dirname(process.argv[1])), accepted: true } }),
  );
}
