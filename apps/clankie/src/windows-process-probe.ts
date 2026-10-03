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
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr sourceHandle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr handle, out bool wow);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, byte[] info, int length, out int needed);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] data, int size, out IntPtr read);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint length, uint flags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref uint length);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref uint length, bool order, uint family, uint kind, uint reserved);
  public class Row { public int pid, parent; public string name; }
  public class Process { public int pid, parent; public string startTime, executable; }
  public static Row[] Table() {
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw new Exception("Process table unavailable");
    var rows=new System.Collections.Generic.List<Row>();
    try {
      var entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      if(!Process32FirstW(snapshot,ref entry)) throw new Exception("Process table unavailable");
      do { rows.Add(new Row {pid=(int)entry.pid,parent=(int)entry.parent,name=entry.name}); } while(Process32NextW(snapshot,ref entry));
      return rows.ToArray();
    } finally {CloseHandle(snapshot);}
  }
  public static Process Details(int pid) {
    IntPtr handle=OpenProcess(0x1000,false,pid);
    if(handle==IntPtr.Zero) throw new Exception("Process unavailable");
    try {
      byte[] basic=new byte[48]; int needed; long created,exited,kernel,user;
      if(NtQueryInformationProcess(handle,0,basic,basic.Length,out needed)!=0 || !GetProcessTimes(handle,out created,out exited,out kernel,out user)) throw new Exception("Process lifetime unavailable");
      var path=new StringBuilder(32768); uint length=32768;
      if(!QueryFullProcessImageName(handle,0,path,ref length)) throw new Exception("Process executable unavailable");
      return new Process {pid=pid,parent=(int)BitConverter.ToInt64(basic,40),startTime=DateTime.FromFileTimeUtc(created).ToString("O"),executable=path.ToString()};
    } finally {CloseHandle(handle);}
  }
  public static int[] Owners(int clientPort,int serverPort) {
    uint length=0; GetExtendedTcpTable(IntPtr.Zero,ref length,false,2,5,0);
    if(length<4 || length>2000000) throw new Exception("TCP table unavailable");
    IntPtr memory=Marshal.AllocHGlobal((int)length);
    try {
      if(GetExtendedTcpTable(memory,ref length,false,2,5,0)!=0) throw new Exception("TCP table changed");
      byte[] bytes=new byte[length];Marshal.Copy(memory,bytes,0,(int)length);
      uint count=BitConverter.ToUInt32(bytes,0);
      if(4+24L*count>length) throw new Exception("Invalid TCP table");
      var owners=new System.Collections.Generic.List<int>();
      for(int n=0;n<count;n++) {int at=4+n*24;
        if(BitConverter.ToUInt32(bytes,at)==5 && BitConverter.ToUInt32(bytes,at+4)==0x0100007f && BitConverter.ToUInt32(bytes,at+12)==0x0100007f && (bytes[at+8]*256+bytes[at+9])==clientPort && (bytes[at+16]*256+bytes[at+17])==serverPort) owners.Add((int)BitConverter.ToUInt32(bytes,at+20));
      }
      return owners.ToArray();
    } finally {Marshal.FreeHGlobal(memory);}
  }
  static byte[] Read(IntPtr handle, long address, int length) {
    if (address <= 0 || length < 0 || length > 65536) throw new Exception("Invalid process memory range");
    byte[] bytes = new byte[length]; IntPtr read;
    if (!ReadProcessMemory(handle, new IntPtr(address), bytes, length, out read) || read.ToInt64() != length) throw new Exception("Process memory unavailable");
    return bytes;
  }
  public static string Canonical(string path) {
    IntPtr handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Exception("Path unavailable");
    try { return HandlePath(handle); } finally { CloseHandle(handle); }
  }
  static string HandlePath(IntPtr handle) {
      var buffer = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(handle, buffer, 32768, 0);
      if (length == 0 || length >= 32768) throw new Exception("Canonical path unavailable");
      string value = buffer.ToString();
      if (value.StartsWith(@"\\?\UNC\")) value = @"\\" + value.Substring(8);
      else if (value.StartsWith(@"\\?\")) value = value.Substring(4);
      if (value.Length > 3) value = value.TrimEnd('\\');
      return value;
  }
  public static string Cwd(int pid) {
    if (IntPtr.Size != 8) throw new Exception("Unsupported observer architecture");
    IntPtr handle = OpenProcess(0x1450, false, pid);
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
      string claimed = Encoding.Unicode.GetString(Read(handle, BitConverter.ToInt64(directory, 8), length));
      IntPtr directoryHandle = new IntPtr(BitConverter.ToInt64(Read(handle, parameters + 0x48, 8), 0));
      IntPtr duplicate;
      if (!DuplicateHandle(handle, directoryHandle, GetCurrentProcess(), out duplicate, 0, false, 2)) throw new Exception("Process cwd handle unavailable");
      try {
        string actual = HandlePath(duplicate);
        if (!String.Equals(actual, Canonical(claimed), StringComparison.Ordinal)) throw new Exception("Process cwd changed");
        return actual;
      } finally { CloseHandle(duplicate); }
    } finally { CloseHandle(handle); }
  }
}
`;
const native = `$ErrorActionPreference = 'Stop'\nif (-not ('ClankieProcess' -as [type])) { Add-Type -TypeDefinition @'\n${WINDOWS_PROCESS_NATIVE}\n'@\n}\n`;

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
function Observe-ClankieProcess {
$sessions = (& herdr session list --json | ConvertFrom-Json).sessions
$binding = @($sessions | Where-Object { $_.name -ceq $session -and $_.running })
if ($binding.Count -ne 1) { throw 'Session unavailable' }
$env:HERDR_SOCKET_PATH = $binding[0].socket_path
$info = (& herdr pane process-info --pane $pane | ConvertFrom-Json).result.process_info
$agent = (& herdr agent get $pane | ConvertFrom-Json).result.agent
if ($info.pane_id -cne $pane -or $agent.pane_id -cne $pane) { throw 'Pane unavailable' }
$all = @([ClankieProcess]::Table())
$byPid = @{}
foreach ($row in $all) { if ($byPid.ContainsKey($row.pid)) { throw 'Duplicate PID' }; $byPid[$row.pid]=$row }
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
$nativeProcesses = @(foreach ($row in $all) {
  if ($row.name -notin @('claude.exe','codex.exe')) { continue }
  $chain = New-Object 'System.Collections.Generic.HashSet[int]'
  $current = $row.pid
  for ($depth=0; $depth -lt 64 -and $byPid.ContainsKey($current); $depth++) {
    if (!$chain.Add($current)) { break }
    if ($current -eq [int]$info.shell_pid) { break }
    $current = $byPid[$current].parent
  }
  if (!$chain.Contains([int]$info.shell_pid) -or !$chain.Contains([int]$info.foreground_process_group_id)) { continue }
  try {
    $detail = [ClankieProcess]::Details($row.pid)
    $executable = [ClankieProcess]::Canonical($detail.executable)
    if ($installed -contains $executable) {
      $cwd = $null
      try { $cwd = [ClankieProcess]::Cwd($row.pid) } catch { }
      [ordered]@{pid=$row.pid; cwd=$cwd; executable=$executable}
    }
  } catch { }
})
$owners = @(${input.clientPort === undefined || input.serverPort === undefined ? "" : `[ClankieProcess]::Owners(${input.clientPort}, ${input.serverPort})`})
# Return only relevant ancestry; unrelated machine process paths never cross the link.
$needed = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($start in @($nativeProcesses | ForEach-Object { $_.pid }) + @($owners) + @([int]$info.shell_pid, [int]$info.foreground_process_group_id)) {
  $current = [int]$start
  for ($depth=0; $depth -lt 64 -and $current -gt 4; $depth++) {
    if (!$needed.Add($current)) { break }
    if ($current -eq [int]$info.shell_pid) { break }
    if (!$byPid.ContainsKey($current)) { break }
    $current = $byPid[$current].parent
  }
}
$relevant = @(foreach ($processId in $needed) { try { [ClankieProcess]::Details($processId) } catch { } })
[ordered]@{binding=[ordered]@{socketPath=$binding[0].socket_path;session=$session};info=[ordered]@{pane_id=$info.pane_id;shell_pid=$info.shell_pid;foreground_process_group_id=$info.foreground_process_group_id};agent=[ordered]@{pane_id=$agent.pane_id;terminal_id=$agent.terminal_id;agent=$agent.agent;agent_session=$agent.agent_session;agent_status=$agent.agent_status};processes=$relevant;nativeProcesses=$nativeProcesses;owners=$owners;installed=$installed}
}
$first = Observe-ClankieProcess
$last = Observe-ClankieProcess
[ordered]@{first=$first;last=$last} | ConvertTo-Json -Compress -Depth 12
`);
}

const gitReader = String.raw`
foreach ($name in @('GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
$git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
function Read-ClankieGit([string]$at, [string[]]$arguments) {
  $output = & $git -C $at @arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Git observation unavailable' }
  return [string]::Join("\n", @($output))
}
`;

export function windowsGitWorktreeCommand(repoPath: string, cwd: string): string {
  return powershellScriptCommand(`${native}\n${gitReader}
$cwd = [ClankieProcess]::Canonical(${powershellLiteral(cwd)})
$repo = [ClankieProcess]::Canonical(${powershellLiteral(repoPath)})
$top = [ClankieProcess]::Canonical((Read-ClankieGit $cwd @('rev-parse','--show-toplevel')).Trim())
$gitDir = [ClankieProcess]::Canonical((Read-ClankieGit $cwd @('rev-parse','--absolute-git-dir')).Trim())
$common = [ClankieProcess]::Canonical((Read-ClankieGit $cwd @('rev-parse','--path-format=absolute','--git-common-dir')).Trim())
$repoTop = [ClankieProcess]::Canonical((Read-ClankieGit $repo @('rev-parse','--show-toplevel')).Trim())
if ($repoTop -cne $repo) { throw 'Enrolled repository root changed' }
$repoCommon = [ClankieProcess]::Canonical((Read-ClankieGit $repo @('rev-parse','--path-format=absolute','--git-common-dir')).Trim())
$gitFile = [ClankieProcess]::Canonical((Join-Path $top '.git'))
$backlink = [IO.File]::ReadAllText((Join-Path $gitDir 'gitdir')).Trim()
if (![IO.Path]::IsPathRooted($backlink)) { $backlink = Join-Path $gitDir $backlink }
$backlink = [ClankieProcess]::Canonical($backlink)
$ledger = Read-ClankieGit $repo @('worktree','list','--porcelain','-z')
$registered = @(foreach ($field in $ledger.Split([char]0)) {
  if (!$field.StartsWith('worktree ')) { continue }
  try { [ClankieProcess]::Canonical($field.Substring(9)) } catch { }
})
[ordered]@{cwd=$cwd;worktreePath=$top;gitDirectory=$gitDir;commonDirectory=$common;repoPath=$repo;repoCommonDirectory=$repoCommon;registeredWorktrees=$registered;gitFilePath=$gitFile;gitDirectoryBacklink=$backlink} | ConvertTo-Json -Compress -Depth 5
`);
}

export function windowsWorktreeRootCommand(path: string, repoPath: string): string {
  return powershellScriptCommand(`${native}\n${gitReader}
$root = [ClankieProcess]::Canonical(${powershellLiteral(path)})
$repo = [ClankieProcess]::Canonical(${powershellLiteral(repoPath)})
$repoTop = [ClankieProcess]::Canonical((Read-ClankieGit $repo @('rev-parse','--show-toplevel')).Trim())
if ($repoTop -cne $repo) { throw 'Not a repository root' }
$common = [ClankieProcess]::Canonical((Read-ClankieGit $repo @('rev-parse','--path-format=absolute','--git-common-dir')).Trim())
[ordered]@{path=$root;repoPath=$repo;commonDirectory=$common;homePath=[ClankieProcess]::Canonical($env:USERPROFILE)} | ConvertTo-Json -Compress
`);
}
