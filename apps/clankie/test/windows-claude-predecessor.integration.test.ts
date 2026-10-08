import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { powershellScriptCommand } from "../src/herdr-fleet.ts";
import { windowsProcessCommand } from "../src/windows-process-probe.ts";

// Manual, read-only: runs the production PowerShell admission function on an
// explicitly supplied Windows SSH host. Creates no pane, file or configuration.
test.skipIf(!process.env.WINDOWS_CLAUDE_PROOF_HOST)(
  "real PowerShell admits only the installed launcher's lifetime-bound predecessor",
  () => {
    const command = windowsProcessCommand({ session: "default", pane: "w9:p2" });
    let script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    const compressed = /FromBase64String\('([^']+)'\)/u.exec(script)?.[1];
    if (compressed) script = gunzipSync(Buffer.from(compressed, "base64")).toString("utf8");
    const fn = /function Test-ClankieClaudePredecessor[\s\S]*?(?=function Observe-ClankieProcess)/u.exec(
      script,
    )?.[0];
    if (!fn) throw new Error("Production admission function missing");
    const checks = `${fn}
$ErrorActionPreference = 'Stop'
$launcher = 'C:\\Users\\fixture\\.local\\bin\\claude.exe'
$birth = [DateTimeOffset]::UtcNow.AddMinutes(-2)
$stamp = $birth.AddMinutes(1).ToUnixTimeMilliseconds()
$before = $birth.AddMinutes(-1).ToUnixTimeMilliseconds()
$future = [DateTimeOffset]::UtcNow.AddMinutes(1).ToUnixTimeMilliseconds()
$pidValue = 648452
$cases = @(
  "$launcher.old.$stamp.$pidValue",
  "$launcher.old.$stamp.123",
  "C:\\other\\claude.exe.old.$stamp.$pidValue",
  "$launcher.lookalike.old.$stamp.$pidValue",
  "$launcher.old.$before.$pidValue",
  "$launcher.old.$future.$pidValue",
  "$launcher.old.$stamp.$pidValue.extra",
  ("$launcher.old.$stamp.$pidValue" + '.old.' + $stamp + '.' + $pidValue)
)
@($cases | ForEach-Object {
  Test-ClankieClaudePredecessor $_ @($launcher) $pidValue $birth.ToString('O')
}) | ConvertTo-Json -Compress
`;
    const result = execFileSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=yes",
        "--",
        process.env.WINDOWS_CLAUDE_PROOF_HOST!,
        powershellScriptCommand(checks),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(JSON.parse(result)).toEqual([true, false, false, false, false, false, false, false]);
  },
  40_000,
);
