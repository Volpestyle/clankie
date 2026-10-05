import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// A process boundary fixture, never a network client. Every executable is
// reached through the test's isolated PATH and every host must be this name.
const root = process.env.CLANKIE_FLEET_SSH_FIXTURE;
const args = process.argv.slice(2);
const hostIndex = args.indexOf("--") + 1;
if (!root || !hostIndex || args[hostIndex] !== "fixture.invalid") {
  throw new Error("Fleet SSH fixture refuses a non-fixture destination");
}
const record = (value) => appendFileSync(join(root, "ssh.jsonl"), `${JSON.stringify(value)}\n`);
if (args.includes("-O")) throw new Error("Recovery must preserve existing SSH masters");

if (args.includes("-N")) {
  record({ kind: "forward", args });
  process.stderr.write("Allocated port 55000 for remote forward to 127.0.0.1:4567\n");
  const hold = setInterval(() => {}, 1_000);
  process.once("SIGTERM", () => {
    clearInterval(hold);
    process.exit(0);
  });
} else {
  const controlPath = args.find((arg) => arg.startsWith("ControlPath="))?.slice("ControlPath=".length);
  if (!controlPath || controlPath === "none") throw new Error("Command needs a fixture master");
  const key = createHash("sha256").update(controlPath).digest("hex");
  const master = join(root, `master-${key}.json`);
  const login = JSON.parse(readFileSync(join(root, "login.json"), "utf8"));
  const fresh = !existsSync(master);
  if (fresh) writeFileSync(master, JSON.stringify({ path: login.path }));
  const captured = JSON.parse(readFileSync(master, "utf8"));
  const command = args[hostIndex + 1];
  record({ kind: "command", controlPath, capturedPath: captured.path, fresh, command });
  const posix = command.startsWith("exec sh -c ");
  const child = spawn(
    posix ? "/bin/sh" : process.execPath,
    posix ? ["-c", command] : [fileURLToPath(new URL("powershell.mjs", import.meta.url)), command],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        ...(posix ? { PATH: `${captured.path}${delimiter}/bin` } : {}),
        CLANKIE_FIXTURE_CAPTURED_PATH: captured.path,
      },
    },
  );
  process.once("SIGTERM", () => child.kill());
  child.once("error", (error) => {
    process.stderr.write(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
