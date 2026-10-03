import { powershellLiteral, powershellScriptCommand } from "./herdr-fleet.ts";

/** Read process parameters through a live kernel handle, never the observer shell's cwd.
 * x64 only: unsupported pointer layouts fail closed. No environment or command-line secrets read.
 */
const WINDOWS_PROCESS_NATIVE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ClankieProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr handle, out bool wow);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, byte[] info, int length, out int needed);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] data, int size, out IntPtr read);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint length, uint flags);
  static byte[] Read(IntPtr handle, long address, int length) {
    if (address <= 0 || length < 0 || length > 65536) throw new Exception("Invalid process memory range");
    byte[] bytes = new byte[length]; IntPtr read;
    if (!ReadProcessMemory(handle, new IntPtr(address), bytes, length, out read) || read.ToInt64() != length) throw new Exception("Process memory unavailable");
    return bytes;
  }
  public static string Canonical(string path) {
    IntPtr handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Exception("Path unavailable");
    try {
      var buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(handle, buffer, 32768, 0);
      if (length == 0 || length >= 32768) throw new Exception("Canonical path unavailable");
      string value = buffer.ToString();
      if (value.StartsWith(@"\\?\UNC\")) value = @"\\" + value.Substring(8);
      else if (value.StartsWith(@"\\?\")) value = value.Substring(4);
      if (value.Length > 3) value = value.TrimEnd('\\');
      return value;
    } finally { CloseHandle(handle); }
  }
  public static string Cwd(int pid) {
    if (IntPtr.Size != 8) throw new Exception("Unsupported observer architecture");
    IntPtr handle = OpenProcess(0x1410, false, pid);
    if (handle == IntPtr.Zero) throw new Exception("Process unavailable");
    try {
      bool wow;
      if (!IsWow64Process(handle, out wow) || wow) throw new Exception("Unsupported process architecture");
      byte[] basic = new byte[48]; int needed;
      if (NtQueryInformationProcess(handle, 0, basic, basic.Length, out needed) != 0) throw new Exception("Process information unavailable");
      long peb = BitConverter.ToInt64(basic, 8);
      long parameters = BitConverter.ToInt64(Read(handle, peb + 0x20, 8), 0);
      byte[] directory = Read(handle, parameters + 0x38, 16);
      int length = BitConverter.ToUInt16(directory, 0);
      if (length == 0 || length % 2 != 0) throw new Exception("Process cwd unavailable");
      return Canonical(Encoding.Unicode.GetString(Read(handle, BitConverter.ToInt64(directory, 8), length)));
    } finally { CloseHandle(handle); }
  }
}
`;
const native = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${WINDOWS_PROCESS_NATIVE}\n'@\n`;

export function windowsCanonicalCommand(path: string): string {
  return powershellScriptCommand(
    `${native}\n[ClankieProcess]::Canonical(${powershellLiteral(path)}) | ConvertTo-Json -Compress`,
  );
}

/** One bounded observation. All PID/tuple inputs here originate in the service, not request data. */
export function windowsProcessCommand(input: {
  session: string;
  pane: string;
  clientPort?: number;
  serverPort?: number;
}): string {
  return powershellScriptCommand(`${native}
$session = ${powershellLiteral(input.session)}
$pane = ${powershellLiteral(input.pane)}
$sessions = (& herdr session list --json | ConvertFrom-Json).sessions
$binding = @($sessions | Where-Object { $_.name -ceq $session -and $_.running })
if ($binding.Count -ne 1) { throw 'Session unavailable' }
$env:HERDR_SOCKET_PATH = $binding[0].socket_path
$info = (& herdr pane process-info --pane $pane | ConvertFrom-Json).result.process_info
$agent = (& herdr agent get $pane | ConvertFrom-Json).result.agent
if ($info.pane_id -cne $pane -or $agent.pane_id -cne $pane) { throw 'Pane unavailable' }
$all = @(Get-CimInstance Win32_Process | ForEach-Object {
  [ordered]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; startTime=if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('O')} else {''}; executable=$_.ExecutablePath}
})
$installed = @()
if ($agent.agent -eq 'claude') {
  $installed = @(Get-Command claude.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { [ClankieProcess]::Canonical($_.Source) })
} elseif ($agent.agent -eq 'codex') {
  # Installed npm package candidates come from the SSH account's PATH, never pane metadata.
  foreach ($command in @(Get-Command codex.cmd -All -CommandType Application -ErrorAction SilentlyContinue)) {
    $root = Split-Path $command.Source
    foreach ($relative in @('node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe', 'node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe')) {
      $candidate = Join-Path $root $relative
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $installed += [ClankieProcess]::Canonical($candidate) }
    }
  }
  $installed += @(Get-Command codex.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { [ClankieProcess]::Canonical($_.Source) })
}
$nativeProcesses = @($all | Where-Object { $_.executable -and $installed -contains $_.executable } | ForEach-Object {
  try { [ordered]@{pid=$_.pid; cwd=[ClankieProcess]::Cwd($_.pid); executable=[ClankieProcess]::Canonical($_.executable)} } catch { }
})
$owners = @(${input.clientPort === undefined || input.serverPort === undefined ? "" : `Get-NetTCPConnection -State Established -LocalAddress 127.0.0.1 -LocalPort ${input.clientPort} -RemoteAddress 127.0.0.1 -RemotePort ${input.serverPort} -ErrorAction Stop | ForEach-Object { [int]$_.OwningProcess }`})
[ordered]@{binding=[ordered]@{socketPath=$binding[0].socket_path;session=$session};info=$info;agent=$agent;processes=$all;nativeProcesses=$nativeProcesses;owners=$owners;installed=$installed} | ConvertTo-Json -Compress -Depth 12
`);
}
