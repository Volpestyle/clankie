import { powershellLiteral, powershellScriptCommand } from "./herdr-fleet.ts";
import { gzipSync } from "node:zlib";

/** Windows caps a process command line at 32,767 characters; expand larger probes only in memory. */
function probeCommand(script: string): string {
  const command = powershellScriptCommand(script);
  if (command.length < 32_000) return command;
  const compressed = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  const bounded = powershellScriptCommand(`$ErrorActionPreference='Stop'
$bytes=[Convert]::FromBase64String('${compressed}')
$memory=New-Object IO.MemoryStream(,$bytes)
$gzip=New-Object IO.Compression.GZipStream($memory,[IO.Compression.CompressionMode]::Decompress)
$reader=New-Object IO.StreamReader($gzip,[Text.Encoding]::UTF8)
try { & ([ScriptBlock]::Create($reader.ReadToEnd())) } finally { $reader.Dispose(); $gzip.Dispose(); $memory.Dispose() }`);
  if (bounded.length >= 32_000)
    throw new Error("Windows process probe exceeds the native command-line bound");
  return bounded;
}

/** Read process parameters through a live kernel handle, never the observer shell's cwd.
 * x64 only: unsupported pointer layouts fail closed. Only bounded role/endpoint and
 * fixed seat-marker projections cross the link; no full argv/environment is exported.
 */
const WINDOWS_PROCESS_NATIVE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class ClankieProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr sourceHandle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr handle, out bool wow);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, byte[] info, int length, out int needed);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] data, int size, out IntPtr read);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, byte[] info, uint size);
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
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [StructLayout(LayoutKind.Explicit, Size=48)] struct Region {
    [FieldOffset(0)] public long address;
    [FieldOffset(24)] public ulong size;
    [FieldOffset(32)] public uint state;
    [FieldOffset(36)] public uint protect;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr handle, IntPtr address, out Region region, UIntPtr length);
  public class Row { public int pid, parent; public string name; }
  public class Process { public int pid, parent; public string startTime, executable; }
  public class CodexRole { public string role, endpoint; public bool standalone; }
  public class SeatMarkers { public string pane, socketPath, homeHash; }
  public class Listener { public int pid, port; public string address; }
  public class TcpRow { public int pid, state, localPort, remotePort; public string localAddress, remoteAddress; }
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
  // One kernel TCP reader supplies targeted owner/listener projections and SSH forwarding proof.
  public static TcpRow[] TcpRows() {
    uint length=0; GetExtendedTcpTable(IntPtr.Zero,ref length,false,2,5,0);
    if(length<4 || length>2000000) throw new Exception("TCP table unavailable");
    IntPtr memory=Marshal.AllocHGlobal((int)length);
    try {
      if(GetExtendedTcpTable(memory,ref length,false,2,5,0)!=0) throw new Exception("TCP table changed");
      byte[] bytes=new byte[length];Marshal.Copy(memory,bytes,0,(int)length);
      uint count=BitConverter.ToUInt32(bytes,0);
      if(4+24L*count>length) throw new Exception("Invalid TCP table");
      var rows=new System.Collections.Generic.List<TcpRow>();
      for(int n=0;n<count;n++) {int at=4+n*24;
        rows.Add(new TcpRow {
          state=(int)BitConverter.ToUInt32(bytes,at),
          localAddress=String.Join(".",new byte[]{bytes[at+4],bytes[at+5],bytes[at+6],bytes[at+7]}),
          localPort=bytes[at+8]*256+bytes[at+9],
          remoteAddress=String.Join(".",new byte[]{bytes[at+12],bytes[at+13],bytes[at+14],bytes[at+15]}),
          remotePort=bytes[at+16]*256+bytes[at+17],
          pid=(int)BitConverter.ToUInt32(bytes,at+20)
        });
      }
      return rows.ToArray();
    } finally {Marshal.FreeHGlobal(memory);}
  }
  public static int[] Owners(int clientPort,int serverPort) {
    var owners=new System.Collections.Generic.List<int>();
    foreach(var row in TcpRows()) {
      if(row.state==(serverPort==0?2:5) && row.localAddress=="127.0.0.1" && row.localPort==clientPort && (serverPort==0 || (row.remoteAddress=="127.0.0.1" && row.remotePort==serverPort))) owners.Add(row.pid);
    }
    return owners.ToArray();
  }
  public static Listener[] Listeners(int pid) {
    var listeners=new System.Collections.Generic.List<Listener>();
    foreach(var row in TcpRows()) {
      if(row.state==2 && row.pid==pid) listeners.Add(new Listener {pid=pid,port=row.localPort,address=row.localAddress});
    }
    return listeners.ToArray();
  }
  static long Parameters(IntPtr handle) {
    if(IntPtr.Size!=8) throw new Exception("Unsupported observer architecture");
    bool wow;
    if(!IsWow64Process(handle,out wow) || wow) throw new Exception("Unsupported process architecture");
    byte[] basic=new byte[48]; int needed;
    if(NtQueryInformationProcess(handle,0,basic,basic.Length,out needed)!=0) throw new Exception("Process information unavailable");
    return BitConverter.ToInt64(Read(handle,BitConverter.ToInt64(basic,8)+0x20,8),0);
  }
  static string Loopback(string value,bool allowZero) {
    if(value==null || !System.Text.RegularExpressions.Regex.IsMatch(value,@"\Aws://127\.0\.0\.1:(0|[1-9][0-9]{0,4})/?\z")) return null;
    int port;
    if(!Int32.TryParse(value.Substring(15).TrimEnd('/'),out port) || port>65535 || (!allowZero && port==0)) return null;
    return "ws://127.0.0.1:"+port;
  }
  static string[] Arguments(int pid) {
    IntPtr handle=OpenProcess(0x1410,false,pid);
    if(handle==IntPtr.Zero) throw new Exception("Process unavailable");
    try {
      long parameters=Parameters(handle);
      // RTL_USER_PROCESS_PARAMETERS.CommandLine, x64 UNICODE_STRING.
      byte[] command=Read(handle,parameters+0x70,16);
      int length=BitConverter.ToUInt16(command,0);
      if(length==0 || length%2!=0) throw new Exception("Process command unavailable");
      string value=Encoding.Unicode.GetString(Read(handle,BitConverter.ToInt64(command,8),length));
      return ParseArguments(value);
    } finally {CloseHandle(handle);}
  }
  static string[] ParseArguments(string value) {
    if(value.IndexOf('\0')>=0) throw new Exception("Invalid process command");
    int count; IntPtr parsed=CommandLineToArgvW(value,out count);
    if(parsed==IntPtr.Zero) throw new Exception("Process arguments unavailable");
    try {
      if(count<1 || count>256) throw new Exception("Invalid process arguments");
      var arguments=new string[count];
      for(int n=0;n<count;n++) arguments[n]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(parsed,n*IntPtr.Size));
      return arguments;
    } finally {LocalFree(parsed);}
  }
  /** Windows parses argv internally. Only the role and safe loopback endpoint leave this method. */
  public static CodexRole Codex(int pid) { return ProjectCodex(Arguments(pid)); }
  // Endpoint uncertainty cannot turn a positively recognized backend into a pane TUI.
  static CodexRole UncertainCodexRole(string command) {
    return new CodexRole {role=command=="app-server"?"server":"other"};
  }
  // Codex 0.160: [OPTIONS] [PROMPT] or [OPTIONS] <COMMAND> [ARGS].
  // Unknown positional text is the initial TUI prompt, never a subcommand.
  static CodexRole ProjectCodex(string[] args) {
    string command=null,remote=null,listen=null;
    int remotes=0,listens=0,positionals=0; bool noDaemon=false;
    var maintenance=new System.Collections.Generic.HashSet<string>(new string[]{"agents","tcp-tunnel","exec","e","review","login","logout","mcp","mcp-server","plugin","remote-control","app","completion","update","doctor","sandbox","debug","execpolicy","apply","a","queue","archive","delete","migrate-rollouts","unarchive","cloud","cloud-tasks","responses-api-proxy","stdio-to-uds","exec-server","features","help","daemon","proxy"});
    var values=new System.Collections.Generic.HashSet<string>(new string[]{"-c","--config","-m","--model","-p","--profile","-s","--sandbox","-a","--ask-for-approval","-C","--cd","-i","--image","--add-dir","--enable","--disable","--local-provider","--code-mode-host","--remote","--listen","--ws-auth","--ws-token-file","--ws-token-sha256","--ws-shared-secret-file","--ws-issuer","--ws-audience","--ws-max-clock-skew-seconds"});
    var flags=new System.Collections.Generic.HashSet<string>(new string[]{"--no-daemon","--no-alt-screen","--search","--full-auto","--dangerously-bypass-approvals-and-sandbox","--oss","--strict-config","--analytics-default-enabled","--stdio","--last","--all"});
    for(int n=1;n<args.Length;n++) {
      string arg=args[n];
      if(arg=="--help" || arg=="-h" || arg=="--version" || arg=="-V") return UncertainCodexRole(command);
      if(arg=="--") {
        // An option-looking prompt after the separator is text, not authority.
        int remaining=args.Length-n-1;
        if(command=="app-server" || remaining>1 || (command==null && positionals+remaining>1)) return UncertainCodexRole(command);
        positionals+=remaining;
        break;
      }
      if(arg.StartsWith("-")) {
        int equals=arg.IndexOf('='); string name=equals<0?arg:arg.Substring(0,equals); string value=null;
        if(values.Contains(name)) {
          if(equals>=0) value=arg.Substring(equals+1);
          else if(++n<args.Length) value=args[n];
          else return UncertainCodexRole(command);
          if(name=="--remote") {remote=value;remotes++;}
          if(name=="--listen") {listen=value;listens++;}
        } else if(equals<0 && flags.Contains(name)) {if(name=="--no-daemon") noDaemon=true;}
        else return UncertainCodexRole(command);
      } else if(command==null && positionals==0) {
        if(arg=="app-server" || arg=="resume" || arg=="fork") command=arg;
        else if(maintenance.Contains(arg)) return UncertainCodexRole(command);
        else positionals=1;
      } else if(command=="app-server" || (command==null && ++positionals>1)) return UncertainCodexRole(command);
    }
    if(command=="app-server") return new CodexRole {role="server",endpoint=remotes==0 && listens==1 && !noDaemon?Loopback(listen,true):null};
    return new CodexRole {role="tui",endpoint=remotes==1 && listens==0 && !noDaemon?Loopback(remote,false):null,standalone=remotes==0 && listens==0};
  }
  /** Read only fixed consistency markers; unrelated entries are neither retained nor exported. */
  public static SeatMarkers Markers(int pid) {
    IntPtr handle=OpenProcess(0x1410,false,pid);
    if(handle==IntPtr.Zero) throw new Exception("Process unavailable");
    try {
      long cursor=BitConverter.ToInt64(Read(handle,Parameters(handle)+0x80,8),0);
      var selected=new System.Collections.Generic.Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      var entry=new StringBuilder(); bool zero=false,done=false; int total=0;
      while(total<65536 && !done) {
        Region region;
        if(VirtualQueryEx(handle,new IntPtr(cursor),out region,new UIntPtr(48))==UIntPtr.Zero || region.state!=0x1000 || (region.protect&0x101)!=0) throw new Exception("Process markers unavailable");
        long remaining=checked(region.address+(long)region.size-cursor);
        int length=(int)Math.Min(4096,Math.Min(remaining,65536-total));
        if(length<2 || length%2!=0) throw new Exception("Invalid process markers");
        byte[] bytes=Read(handle,cursor,length);cursor+=length;total+=length;
        for(int at=0;at<length;at+=2) {
          char value=(char)BitConverter.ToUInt16(bytes,at);
          if(value=='\0') {
            if(zero) {done=true;break;}
            string line=entry.ToString();entry.Length=0;int equals=line.IndexOf('=');
            if(equals>0) {
              string name=line.Substring(0,equals);
              if(name.Equals("HERDR_PANE_ID",StringComparison.OrdinalIgnoreCase) || name.Equals("HERDR_SOCKET_PATH",StringComparison.OrdinalIgnoreCase) || name.Equals("CODEX_HOME",StringComparison.OrdinalIgnoreCase) || name.Equals("USERPROFILE",StringComparison.OrdinalIgnoreCase)) {
                if(selected.ContainsKey(name)) throw new Exception("Ambiguous process markers");
                selected.Add(name,line.Substring(equals+1));
              }
            }
            zero=true;
          } else {entry.Append(value);zero=false;}
        }
      }
      if(!done) throw new Exception("Unbounded process markers");
      string pane,socket,home,profile;
      selected.TryGetValue("HERDR_PANE_ID",out pane);selected.TryGetValue("HERDR_SOCKET_PATH",out socket);
      if(!selected.TryGetValue("CODEX_HOME",out home) || String.IsNullOrEmpty(home)) {
        if(!selected.TryGetValue("USERPROFILE",out profile) || String.IsNullOrEmpty(profile)) throw new Exception("Process home unavailable");
        home=System.IO.Path.Combine(profile,".codex");
      }
      if(!System.IO.Path.IsPathRooted(home)) throw new Exception("Relative process home");
      return new SeatMarkers {pane=pane,socketPath=socket,homeHash=HomeHash(home)};
    } finally {CloseHandle(handle);}
  }
  public static string HomeHash(string home) {
    using(var hash=SHA256.Create()) {
      return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(DirectoryCanonical(home)))).Replace("-","").ToLowerInvariant();
    }
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
  public static string DirectoryCanonical(string path) {
    IntPtr handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Exception("Directory unavailable");
    try {
      byte[] info = new byte[40];
      if (!GetFileInformationByHandleEx(handle, 0, info, 40) || (BitConverter.ToUInt32(info, 32) & 0x10) == 0) throw new Exception("Path is not a directory");
      return HandlePath(handle);
    } finally { CloseHandle(handle); }
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
  return probeCommand(
    `${native}\n[ClankieProcess]::DirectoryCanonical(${powershellLiteral(path)}) | ConvertTo-Json -Compress`,
  );
}

/** One bounded observation. All PID/tuple inputs here originate in the service, not request data. */
export function windowsProcessCommand(input: {
  session: string;
  pane: string;
  clientPort?: number;
  serverPort?: number;
  privateServer?: { pid: number; port: number };
  /** Project bounded native argv and fixed seat markers for dedicated Codex control. */
  codexControl?: boolean;
  /** Compare the native home to the SSH account's default; no home path is exported. */
  codexDefaultHome?: boolean;
}): string {
  return probeCommand(`${native}
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
  $packageRoots = @(Get-Command codex.cmd -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { Split-Path $_.Source })
  # A PATH shim may live in dotfiles rather than beside the installed npm package.
  # APPDATA belongs to the authenticated SSH account, never the native pane's env.
  if ($env:APPDATA) { $packageRoots += Join-Path $env:APPDATA 'npm' }
  foreach ($root in @($packageRoots | Select-Object -Unique)) {
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
    if ($installed -contains $executable${input.codexControl ? " -or $row.name -eq 'codex.exe'" : ""}) {
      $cwd = $null
      try { $cwd = [ClankieProcess]::Cwd($row.pid) } catch { }
      $native = [ordered]@{pid=$row.pid; cwd=$cwd; executable=$executable}
      ${
        input.codexControl
          ? `if ($row.name -eq 'codex.exe') {
        $role = $null
        try { $role = [ClankieProcess]::Codex($row.pid) } catch { }
        $native.role = if ($role) { $role.role } else { 'unavailable' }
        $native.endpoint = if ($role) { $role.endpoint } else { $null }
        $native.standalone = if ($role) { $role.standalone } else { $false }
        $native.markers = $null
        try { $native.markers = [ClankieProcess]::Markers($row.pid) } catch { }
        if ($role -and $role.role -eq 'server') {
          $native.listeners = @([ClankieProcess]::Listeners($row.pid))
          $native.listenerOwners = @(foreach ($listener in $native.listeners) { [ClankieProcess]::Owners($listener.port,0) })
        }
      }`
          : ""
      }
      $native
    }
  } catch { }
})
$owners = @(${input.clientPort === undefined || input.serverPort === undefined ? "" : `[ClankieProcess]::Owners(${input.clientPort}, ${input.serverPort})`})
$privateServer=$null
${
  input.privateServer
    ? `$detail=[ClankieProcess]::Details(${input.privateServer.pid})
$privateServer=[ordered]@{pid=$detail.pid;startTime=$detail.startTime;executable=[ClankieProcess]::Canonical($detail.executable);cwd=[ClankieProcess]::Cwd($detail.pid);port=${input.privateServer.port};listeners=@([ClankieProcess]::Owners(${input.privateServer.port},0))}`
    : ""
}
# Return only relevant ancestry; unrelated machine process paths never cross the link.
$needed = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($start in @($nativeProcesses | ForEach-Object { $_.pid }) + @($owners) + @(${input.privateServer?.pid ?? 0}) + @([int]$info.shell_pid, [int]$info.foreground_process_group_id)) {
  $current = [int]$start
  for ($depth=0; $depth -lt 64 -and $current -gt 4; $depth++) {
    if (!$needed.Add($current)) { break }
    if ($current -eq [int]$info.shell_pid) { break }
    if (!$byPid.ContainsKey($current)) { break }
    $current = $byPid[$current].parent
  }
}
$relevant = @(foreach ($processId in $needed) { try { $detail=[ClankieProcess]::Details($processId); $detail.executable=[ClankieProcess]::Canonical($detail.executable); $detail } catch { } })
$foregroundMarkers=$null
${input.codexControl ? "try { $foregroundMarkers=[ClankieProcess]::Markers([int]$info.foreground_process_group_id) } catch { }" : ""}
$defaultHomeHash=$null
${
  input.codexDefaultHome
    ? `try {
  $defaultHome=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)) '.codex'
  $defaultHash=[ClankieProcess]::HomeHash($defaultHome)
  # The CLI will inherit this SSH account's environment; a custom CODEX_HOME cannot select the fallback.
  if ([ClankieProcess]::Markers([int]$PID).homeHash -ceq $defaultHash) { $defaultHomeHash=$defaultHash }
} catch { }`
    : ""
}
[ordered]@{binding=[ordered]@{socketPath=$binding[0].socket_path;session=$session};info=[ordered]@{pane_id=$info.pane_id;shell_pid=$info.shell_pid;foreground_process_group_id=$info.foreground_process_group_id};agent=[ordered]@{pane_id=$agent.pane_id;terminal_id=$agent.terminal_id;agent=$agent.agent;agent_session=$agent.agent_session;agent_status=$agent.agent_status};processes=$relevant;nativeProcesses=$nativeProcesses;owners=$owners;installed=$installed;privateServer=$privateServer;foregroundMarkers=$foregroundMarkers;defaultHomeHash=$defaultHomeHash}
}
$first = Observe-ClankieProcess
$last = Observe-ClankieProcess
[ordered]@{first=$first;last=$last} | ConvertTo-Json -Compress -Depth 12
`);
}

/** Observe the actual TCP client owned by this SSH transport's nearest live SSHD ancestor.
 * The caller's native SSH -L channel carries all protocol bytes; this command only emits facts.
 */
export function windowsCodexForwardCommand(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("Invalid native loopback port");
  return probeCommand(`${native}
$serverPort=${port}
function Get-ClankieForwardOwner {
  $byPid=@{}
  foreach ($row in @([ClankieProcess]::Table())) {
    if ($byPid.ContainsKey($row.pid)) {throw 'Duplicate process identity'}
    $byPid[$row.pid]=$row
  }
  $seen=New-Object 'System.Collections.Generic.HashSet[int]'
  $chain=New-Object 'System.Collections.Generic.List[object]'
  $current=[int]$PID
  $childStarted=$null
  for ($depth=0; $depth -lt 64 -and $current -gt 4; $depth++) {
    if (!$seen.Add($current) -or !$byPid.ContainsKey($current)) {throw 'SSH ancestry unavailable'}
    $detail=[ClankieProcess]::Details($current)
    $row=$byPid[$current]
    if ($detail.pid -ne $current -or $detail.parent -ne $row.parent -or [IO.Path]::GetFileName($detail.executable) -ine $row.name) {throw 'SSH ancestry changed'}
    $started=[DateTime]::ParseExact($detail.startTime,'O',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
    if ($null -ne $childStarted -and $started -gt $childStarted) {throw 'SSH ancestor process identity reused'}
    $chain.Add($detail)
    if ($row.name -ieq 'sshd.exe' -or $row.name -ieq 'sshd-session.exe') {
      return [ordered]@{owner=$detail;chain=$chain.ToArray()}
    }
    $childStarted=$started
    $current=$detail.parent
  }
  throw 'Nearest SSHD ancestor unavailable'
}
$identity=Get-ClankieForwardOwner
$identityJson=$identity | ConvertTo-Json -Compress -Depth 5
$sshdPid=[int]$identity.owner.pid
function Assert-ClankieForwardOwner {
  $currentJson=Get-ClankieForwardOwner | ConvertTo-Json -Compress -Depth 5
  if ($currentJson -cne $identityJson) {throw 'Owned SSH transport lifetime changed'}
}
function Get-ClankieForwardRows {
  @([ClankieProcess]::TcpRows() | Where-Object {
    $_.pid -eq $sshdPid -and $_.state -eq 5 -and
    $_.localAddress -ceq '127.0.0.1' -and $_.remoteAddress -ceq '127.0.0.1' -and
    $_.remotePort -eq $serverPort
  })
}
[Console]::Out.WriteLine('CLANKIE_CODEX_FORWARD_READY')
[Console]::Out.Flush()
$waiting=[Diagnostics.Stopwatch]::StartNew()
$connection=$null
while ($waiting.ElapsedMilliseconds -lt 10000) {
  $rows=@(Get-ClankieForwardRows)
  if ($rows.Count -gt 1) {throw 'Ambiguous owned SSH forward connection'}
  if ($rows.Count -eq 1) {
    $connection=$rows[0]
    if ($connection.localPort -lt 1 -or $connection.localPort -gt 65535 -or $connection.localPort -eq $serverPort) {throw 'Invalid owned SSH forward tuple'}
    Assert-ClankieForwardOwner
    $final=@(Get-ClankieForwardRows)
    if ($final.Count -ne 1 -or $final[0].localPort -ne $connection.localPort) {throw 'Owned SSH forward connection changed'}
    $tuple=[ordered]@{clientPort=$connection.localPort;serverPort=$serverPort} | ConvertTo-Json -Compress
    [Console]::Out.WriteLine('CLANKIE_CODEX_CONNECTION '+$tuple)
    [Console]::Out.Flush()
    break
  }
  Start-Sleep -Milliseconds 100
}
if ($null -eq $connection) {throw 'Owned SSH forward connection timed out'}
$held=[Diagnostics.Stopwatch]::StartNew()
while ($held.ElapsedMilliseconds -lt 60000) {
  Assert-ClankieForwardOwner
  $rows=@(Get-ClankieForwardRows)
  if ($rows.Count -gt 1) {throw 'Ambiguous owned SSH forward connection'}
  if ($rows.Count -eq 0 -or $rows[0].localPort -ne $connection.localPort) {break}
  Start-Sleep -Milliseconds 100
}
`);
}

const gitReader = String.raw`
foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' })) { Remove-Item -LiteralPath ('Env:' + $entry.Name) -ErrorAction Stop }
$git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
function Read-ClankieGit([string]$at, [string[]]$arguments) {
  $output = & $git -C $at @arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Git observation unavailable' }
  return [string]::Join("\n", @($output))
}
`;

export function windowsGitWorktreeCommand(repoPath: string, cwd: string): string {
  return probeCommand(`${native}\n${gitReader}
$cwd = [ClankieProcess]::DirectoryCanonical(${powershellLiteral(cwd)})
$repo = [ClankieProcess]::DirectoryCanonical(${powershellLiteral(repoPath)})
$top = [ClankieProcess]::DirectoryCanonical((Read-ClankieGit $cwd @('rev-parse','--show-toplevel')).Trim())
$gitDir = [ClankieProcess]::DirectoryCanonical((Read-ClankieGit $cwd @('rev-parse','--absolute-git-dir')).Trim())
$common = [ClankieProcess]::DirectoryCanonical((Read-ClankieGit $cwd @('rev-parse','--path-format=absolute','--git-common-dir')).Trim())
$repoTop = [ClankieProcess]::DirectoryCanonical((Read-ClankieGit $repo @('rev-parse','--show-toplevel')).Trim())
if ($repoTop -cne $repo) { throw 'Enrolled repository root changed' }
$repoCommon = [ClankieProcess]::DirectoryCanonical((Read-ClankieGit $repo @('rev-parse','--path-format=absolute','--git-common-dir')).Trim())
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
  return probeCommand(`${native}\n${gitReader}
$root = [ClankieProcess]::DirectoryCanonical(${powershellLiteral(path)})
$repo = [ClankieProcess]::DirectoryCanonical(${powershellLiteral(repoPath)})
$repoTop = [ClankieProcess]::DirectoryCanonical((Read-ClankieGit $repo @('rev-parse','--show-toplevel')).Trim())
if ($repoTop -cne $repo) { throw 'Not a repository root' }
$common = [ClankieProcess]::DirectoryCanonical((Read-ClankieGit $repo @('rev-parse','--path-format=absolute','--git-common-dir')).Trim())
[ordered]@{path=$root;repoPath=$repo;commonDirectory=$common;homePath=[ClankieProcess]::DirectoryCanonical($env:USERPROFILE)} | ConvertTo-Json -Compress
`);
}
