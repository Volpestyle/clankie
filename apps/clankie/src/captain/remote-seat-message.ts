import { createHash, randomUUID } from "node:crypto";
import { powershellLiteral, powershellScriptCommand, type FleetShellRun } from "../herdr-fleet.ts";

/**
 * Stage a Windows body that exceeds its native command line or channel limit.
 * The body crosses SSH stdin inside the script, never an argument, and the
 * script reports the written file's SHA-256 so a partial write cannot pass.
 * Failed/refused sends remove their own file. Accepted/uncertain pointers keep
 * it until the receiver reads and removes it; abandoned files expire on a later write.
 */
export async function stageWindowsMessage(
  shell: FleetShellRun,
  text: string,
): Promise<{ path: string; sha256: string; remove(): Promise<void> }> {
  const bytes = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = `${randomUUID()}.md`;
  // Resolve the same generated name remotely even if staging loses its reply.
  // Never use an unvalidated path from a failed staging response for deletion.
  const remove = async () => {
    await shell(
      powershellScriptCommand(
        `$path = Join-Path (Join-Path $env:USERPROFILE '.clankie\\seat-messages') ${powershellLiteral(name)}; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction Stop }`,
      ),
      5_000,
    );
  };
  try {
    const stdout = await shell(
      powershellScriptCommand(
        [
          "$ErrorActionPreference = 'Stop'",
          "$dir = Join-Path $env:USERPROFILE '.clankie\\seat-messages'",
          "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
          "Get-ChildItem -LiteralPath $dir -Filter '*.md' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue",
          `$path = Join-Path $dir ${powershellLiteral(name)}`,
          `[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String('${bytes.toString("base64")}'))`,
          "$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($path))).Replace('-','').ToLowerInvariant()",
          "[Console]::WriteLine($path + '|' + $hash)",
        ].join("; "),
      ),
      30_000,
    );
    const [path, written] = (stdout.trim().split(/\r?\n/u).at(-1) ?? "").split("|");
    if (!path || written !== sha256) throw new Error("The staged message did not match what was sent");
    return { path, sha256, remove };
  } catch (error) {
    // Staging cannot dispatch a message, so even a lost reply permits cleanup.
    // allow-swallowed-rejection -- Preserve the staging failure and definite not-sent result; age pruning covers cleanup failure.
    await remove().catch(() => undefined);
    throw error;
  }
}

/** The short queued message that points a Windows seat at its staged message. */
export function stagedMessagePointer(staged: { path: string; sha256: string }, text: string): string {
  return `This message is ${String(text.length)} characters, too long for this delivery channel, so it is saved in full at ${staged.path} (UTF-8, SHA-256 ${staged.sha256}). Read that entire file now and verify its SHA-256; its contents are the message. After reading and verifying it, delete this staged file.`;
}
