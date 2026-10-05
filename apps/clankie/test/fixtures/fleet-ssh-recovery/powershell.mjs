import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const root = process.env.CLANKIE_FLEET_SSH_FIXTURE;
const encoded = /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand (\S+)$/u.exec(
  process.argv[2],
)?.[1];
if (!root || !encoded) throw new Error("Fixture expects the real encoded PowerShell command boundary");
const script = Buffer.from(encoded, "base64").toString("utf16le");
const program = /Get-Command ([a-z][a-z0-9-]*) -CommandType Application/u.exec(script)?.[1];
const quiet = /\$ProgressPreference\s*=\s*'SilentlyContinue'/u.test(script);
appendFileSync(join(root, "powershell.jsonl"), `${JSON.stringify({ script, program, quiet })}\n`);

if (!program) {
  const returnPort = /\[ClankieRelay\]::Start\((\d+)\)/u.exec(script)?.[1];
  if (returnPort && JSON.parse(readFileSync(join(root, "login.json"), "utf8")).mode === "relay-success") {
    const { startRelay } = await import("./relay.mjs");
    await startRelay(Number(returnPort));
  } else if (script.includes("ClankieRelay")) {
    const diagnostic = readFileSync(new URL("missing-command.clixml", import.meta.url), "utf8")
      .replace("Preparing modules for first use.", "Preparing modules for first use." + "x".repeat(70_000))
      .replaceAll("{{PROGRAM}}", "relay dependency");
    process.stderr.write(diagnostic, () => process.exit(1));
  } else {
    // Link metadata write after the real FleetLink session/socket lookup.
    if (!script.includes("WriteAllText")) throw new Error("Unexpected fixture PowerShell script");
    process.exit(0);
  }
} else {
  const executable = process.env.CLANKIE_FIXTURE_CAPTURED_PATH.split(delimiter)
    .map((directory) => join(directory, program))
    .find(existsSync);
  if (!executable) {
    const marker = /clankie-launch-[a-f0-9]{16}: /u.exec(script)?.[0];
    if (!marker) throw new Error("Missing command must have a service-authored pre-launch marker");
    const mode = JSON.parse(readFileSync(join(root, "login.json"), "utf8")).mode;
    // The new wrapper writes plain launch errors. A retained noisy upstream
    // CLIXML record also proves the decoder before status/doctor consumes it.
    const error =
      mode === "missing-clixml"
        ? readFileSync(new URL("missing-command.clixml", import.meta.url), "utf8")
            .replaceAll("{{PROGRAM}}", program)
            .replace('S="Error">Get-Command', `S="Error">${marker}Get-Command`)
        : `${marker}Get-Command : The term '${program}' is not recognized as the name of a cmdlet, function, script file, or operable program.\n`;
    process.stderr.write(error);
    process.exit(127);
  }
  const argumentBytes = /FromBase64String\('([^']*)'\)/u.exec(script)?.[1];
  if (argumentBytes === undefined) throw new Error("Program arguments must cross the base64 boundary");
  const argumentsText = Buffer.from(argumentBytes, "base64").toString("utf8");
  // These integration commands use uncomplicated arguments. Windows quoting's
  // broader contract has existing coverage in herdr-fleet.test.ts.
  const args = argumentsText === "" ? [] : argumentsText.split(" ");
  const workingDirectory = /\$start\.WorkingDirectory = '((?:[^']|'')*)'/u
    .exec(script)?.[1]
    ?.replaceAll("''", "'");
  const child = spawn(executable, args, {
    stdio: ["ignore", "inherit", "inherit"],
    ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
  });
  process.once("SIGTERM", () => child.kill());
  child.once("error", (error) => {
    const marker = /clankie-launch-[a-f0-9]{16}: /u.exec(script)?.[0];
    process.stderr.write(`${marker}${error.message}\n`);
    process.exitCode = 127;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
