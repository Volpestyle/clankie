import { execFile } from "node:child_process";
import { win32 } from "node:path";

/** Host uptime and the last interactive input projected into that same clock.
 * GetLastInputInfo covers the host's current Windows session, not another session.
 */
export interface WindowsLastInputSnapshot {
  tickMs: number;
  lastInputTickMs: number;
}

export type WindowsLastInputReader = () => Promise<WindowsLastInputSnapshot>;

const MAX_LAST_INPUT_AGE_MS = 86_400_000;

// This process only queries documented Win32 APIs. It injects no input, installs
// no helper and opens no listener. A constant command prevents caller-supplied
// text from becoming PowerShell code; windowsHide avoids stealing foreground.
const LAST_INPUT_COMMAND = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClankieLastInput {
  [StructLayout(LayoutKind.Sequential)]
  private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("kernel32.dll")]
  private static extern ulong GetTickCount64();
  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
  [DllImport("kernel32.dll")]
  private static extern uint WTSGetActiveConsoleSessionId();
  public sealed class Snapshot {
    public ulong tickMs;
    public ulong lastInputTickMs;
  }
  public static Snapshot Read() {
    uint sessionId;
    uint consoleSessionId = WTSGetActiveConsoleSessionId();
    if (!ProcessIdToSessionId(GetCurrentProcessId(), out sessionId))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    // GetLastInputInfo sees only this process's session. SSH/service/RDP
    // sessions cannot claim that the physical console's person is inactive.
    if (sessionId == 0 || consoleSessionId == 0 ||
        consoleSessionId == UInt32.MaxValue || sessionId != consoleSessionId)
      throw new InvalidOperationException("An active physical console session is required");
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref info))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    ulong now = GetTickCount64();
    if (WTSGetActiveConsoleSessionId() != consoleSessionId)
      throw new InvalidOperationException("The physical console session changed");
    // LASTINPUTINFO.dwTime wraps every 2^32 ms; project its age into the
    // GetTickCount64 epoch. Ambiguous old/backward stamps fail closed in JS.
    uint age = unchecked((uint)now - info.dwTime);
    // Refuse an old or future DWORD stamp rather than trusting an ambiguous
    // wrap projection. The owner can interact, wait quietly and start anew.
    if (now < age || age > 86400000)
      throw new InvalidOperationException("Invalid or ambiguous last-input clock");
    return new Snapshot { tickMs = now, lastInputTickMs = now - age };
  }
}
'@
[ClankieLastInput]::Read() | ConvertTo-Json -Compress
`;

/** Constructed only inside the trusted Windows host. Tests supply recorded
 * snapshots instead of invoking PowerShell or contacting a Windows machine.
 */
export function createWindowsLastInputReader(): WindowsLastInputReader {
  if (process.platform !== "win32") throw new Error("Windows last-input checks require a Windows host");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  if (!/^[A-Za-z]:\\/u.test(systemRoot)) throw new Error("Windows system directory is unavailable");
  const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return () =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", LAST_INPUT_COMMAND],
        { windowsHide: true, timeout: 5_000, maxBuffer: 4_096, encoding: "utf8" },
        (error, stdout) => {
          if (error !== null) {
            reject(new Error("Windows person-activity check failed"));
            return;
          }
          try {
            resolve(parseSnapshot(JSON.parse(stdout.trim())));
          } catch {
            reject(new Error("Windows person-activity check failed"));
          }
        },
      );
    });
}

function parseSnapshot(value: unknown): WindowsLastInputSnapshot {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Windows input clock");
  const tickMs = Reflect.get(value, "tickMs"),
    lastInputTickMs = Reflect.get(value, "lastInputTickMs");
  if (
    !Number.isSafeInteger(tickMs) ||
    !Number.isSafeInteger(lastInputTickMs) ||
    tickMs < 0 ||
    lastInputTickMs < 0 ||
    lastInputTickMs > tickMs ||
    tickMs - lastInputTickMs > MAX_LAST_INPUT_AGE_MS
  )
    throw new Error("Invalid Windows input clock");
  return { tickMs, lastInputTickMs };
}

/** Checked at validation and immediately before every native dispatch. The
 * completed primitive establishes its own injected-input baseline; a later
 * input event, clock discontinuity or failed query must retire the adapter.
 * This is an additional person stop, not a native quiescence or effect receipt.
 */
export class WindowsPersonActivityGuard {
  private previous: WindowsLastInputSnapshot | undefined;
  private completedInputTickMs: number | undefined;
  private readonly reader: WindowsLastInputReader;
  private readonly quietWindowMs: number;

  constructor(reader: WindowsLastInputReader, quietWindowMs = 2_000) {
    if (!Number.isSafeInteger(quietWindowMs) || quietWindowMs < 2_000)
      throw new Error("Windows person-activity checks require a quiet margin of at least two seconds");
    this.reader = reader;
    this.quietWindowMs = quietWindowMs;
  }

  private async read(): Promise<WindowsLastInputSnapshot> {
    let snapshot: WindowsLastInputSnapshot;
    try {
      snapshot = parseSnapshot(await this.reader());
    } catch {
      throw new Error("Windows person-activity check failed");
    }
    if (
      this.previous !== undefined &&
      (snapshot.tickMs < this.previous.tickMs || snapshot.lastInputTickMs < this.previous.lastInputTickMs)
    )
      throw new Error("Windows person-activity clock changed; this host must stop");
    this.previous = snapshot;
    return snapshot;
  }

  async assertQuiet(): Promise<void> {
    const snapshot = await this.read();
    if (this.completedInputTickMs !== undefined && snapshot.lastInputTickMs !== this.completedInputTickMs)
      throw new Error("Windows person input arrived after the last dispatch; this host must stop");
    if (snapshot.tickMs - snapshot.lastInputTickMs < this.quietWindowMs)
      throw new Error("Windows input requires a quiet owner-authorized window");
    this.completedInputTickMs ??= snapshot.lastInputTickMs;
  }

  async recordDispatchFinished(): Promise<void> {
    const snapshot = await this.read();
    this.completedInputTickMs = snapshot.lastInputTickMs;
  }
}
