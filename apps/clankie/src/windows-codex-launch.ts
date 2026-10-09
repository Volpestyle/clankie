import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { powershellLiteral, powershellScriptCommand } from "./herdr-fleet.ts";

const launcher = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ClankieCodexLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int size; public string reserved,desktop,title; public int x,y,width,height,xChars,yChars,fill,flags; public short show,reservedSize; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Created { public IntPtr process,thread; public int pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Created process);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string p,uint a,uint s,IntPtr security,uint d,uint f,IntPtr t);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(IntPtr h,StringBuilder p,uint n,uint f);
  [DllImport("kernel32.dll")] static extern bool GetFileInformationByHandleEx(IntPtr h,int kind,byte[] b,uint n);
  static string Path(string path,bool directory) {
    IntPtr h=CreateFile(path,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
    if(h==new IntPtr(-1))throw new Exception("Path unavailable");
    try {
      if(directory){byte[] info=new byte[40];if(!GetFileInformationByHandleEx(h,0,info,40)||(BitConverter.ToUInt32(info,32)&0x10)==0)throw new Exception("Directory unavailable");}
      var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,32768,0);if(n==0||n>=32768)throw new Exception("Path unavailable");
      string p=b.ToString();if(p.StartsWith(@"\\?\UNC\"))p=@"\\"+p.Substring(8);else if(p.StartsWith(@"\\?\"))p=p.Substring(4);return p.Length>3?p.TrimEnd('\\'):p;
    } finally {CloseHandle(h);}
  }
  public static string Canonical(string p){return Path(p,false);}
  public static string DirectoryCanonical(string p){return Path(p,true);}
  public class Result { public int pid; public string startTime; }
  static string Quote(string s) {
    var b=new StringBuilder("\"");int n=0;
    foreach(char c in s){if(c=='\\'){n++;continue;}if(c=='"'){b.Append('\\',n*2+1);b.Append(c);}else{b.Append('\\',n);b.Append(c);}n=0;}
    return b.Append('\\',n*2).Append('"').ToString();
  }
  public static void Stop(int pid,string lifetime) {
    IntPtr h=OpenProcess(0x1001,false,pid);if(h==IntPtr.Zero)return;
    try {long birth,exit,kernel,user;if(GetProcessTimes(h,out birth,out exit,out kernel,out user)&&DateTime.FromFileTimeUtc(birth).ToString("O")==lifetime)TerminateProcess(h,0);}finally{CloseHandle(h);}
  }
  public static Result Start(string exe,string[] args,string cwd,string environment) {
    var startup=new Startup {size=Marshal.SizeOf(typeof(Startup))};var created=new Created();
    var command=new StringBuilder(Quote(exe));foreach(string arg in args)command.Append(' ').Append(Quote(arg));
    if(command.Length>=32767)throw new Exception("Native Codex command exceeds Windows limit; no agent created");
    IntPtr env=Marshal.StringToHGlobalUni(environment);bool resumed=false;
    try {
      // Original process handle, suspended; no inherited SSH handles. Breakaway is mandatory.
      if(!CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x09000404,env,cwd,ref startup,out created))throw new Exception("Atomic Codex launch unavailable: "+Marshal.GetLastWin32Error());
      long birth,exit,kernel,user;
      if(!GetProcessTimes(created.process,out birth,out exit,out kernel,out user))throw new Exception("Original process lifetime unavailable");
      var result=new Result {pid=created.pid,startTime=DateTime.FromFileTimeUtc(birth).ToString("O")};
      if(ResumeThread(created.thread)==0xffffffff)throw new Exception("Native server resume failed");
      resumed=true;return result;
    } finally {
      if(created.process!=IntPtr.Zero){if(!resumed)TerminateProcess(created.process,1);CloseHandle(created.process);}
      if(created.thread!=IntPtr.Zero)CloseHandle(created.thread);Marshal.FreeHGlobal(env);
    }
  }
}
`;

export interface WindowsCodexBridge {
  readonly version: string;
  readonly files: Readonly<Record<string, string>>;
}
export interface WindowsCodexBridgeBinding {
  readonly root: string;
  readonly node: string;
  readonly entry: string;
}
/** Exact service-packaged modules, not a claimed version or a discovery file. */
export async function windowsCodexBridge(): Promise<WindowsCodexBridge> {
  const paths = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "bin/fleet-mcp.mjs",
    "bin/seat-channel.mjs",
    "bin/mcp-result.mjs",
    "bin/catalog-watch.mjs",
    "bin/link.mjs",
    "bin/inbound-receipt.mjs",
    "bin/peer-receipt.mjs",
  ];
  const files: Record<string, string> = {};
  let version: string | undefined;
  for (const path of paths) {
    const bytes = await readFile(
      new URL(`../../../integrations/claude-plugin/worker/${path}`, import.meta.url),
    );
    files[path] = createHash("sha256").update(bytes).digest("hex");
    if (path.endsWith("plugin.json")) {
      const observed = (JSON.parse(bytes.toString("utf8")) as { version?: unknown }).version;
      if (typeof observed !== "string" || (version !== undefined && observed !== version))
        throw new Error("Worker bridge manifests disagree");
      version = observed;
    }
  }
  return { version: version!, files };
}

function bridgeScript(expected: WindowsCodexBridge, pinned?: WindowsCodexBridgeBinding): string {
  return `
$bridgeRoot=[ClankieCodexLaunch]::DirectoryCanonical((Join-Path $env:USERPROFILE '.clankie\\claude-plugin\\worker'))
$nodes=@(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object {[ClankieCodexLaunch]::Canonical($_.Source)} | Select-Object -Unique)
if($nodes.Count -ne 1){throw 'Unique installed native Node unavailable'}
$bridgeNode=$nodes[0]
$bridgeEntry=Join-Path $bridgeRoot 'bin\\fleet-mcp.mjs'
${pinned ? `if($bridgeRoot -cne ${powershellLiteral(pinned.root)} -or $bridgeNode -cne ${powershellLiteral(pinned.node)} -or $bridgeEntry -cne ${powershellLiteral(pinned.entry)}){throw 'Worker bridge installation changed'}` : ""}
foreach($expected in (@{${Object.entries(expected.files)
    .map(([path, hash]) => `${powershellLiteral(path.replaceAll("/", "\\"))}=${powershellLiteral(hash)}`)
    .join(";")}}).GetEnumerator()){
 $module=Join-Path $bridgeRoot $expected.Key
 if([ClankieCodexLaunch]::Canonical($module) -cne $module -or (Get-FileHash -LiteralPath $module -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected.Value){throw 'Worker bridge is stale or redirected; owner preparation required'}
}
foreach($manifest in @('.claude-plugin\\plugin.json','.codex-plugin\\plugin.json')){
 if((Get-Content -Raw -LiteralPath (Join-Path $bridgeRoot $manifest) | ConvertFrom-Json).version -cne ${powershellLiteral(expected.version)}){throw 'Worker bridge version is stale; owner preparation required'}
}
`;
}

export function windowsCodexBridgeCheckCommand(
  expected: WindowsCodexBridge,
  pinned: WindowsCodexBridgeBinding,
): string {
  return powershellScriptCommand(`$ErrorActionPreference='Stop'
if (-not ('ClankieCodexLaunch' -as [type])) { Add-Type -TypeDefinition @'
${launcher}
'@
}
${bridgeScript(expected, pinned)}
'bridge-current'`);
}

export function windowsCodexStopCommand(server: { pid: number; startTime: string }): string {
  return powershellScriptCommand(`$ErrorActionPreference='Stop'
if (-not ('ClankieCodexLaunch' -as [type])) { Add-Type -TypeDefinition @'
${launcher}
'@
}
[ClankieCodexLaunch]::Stop(${server.pid},${powershellLiteral(server.startTime)})`);
}

export function windowsCodexLaunchCommand(input: {
  session: string;
  pane: string;
  cwd: string;
  args: readonly string[];
  id: string;
  bridge: WindowsCodexBridge;
  /** Trusted controller owns catalog observation; this flag grants no tools. */
  catalogObserved?: boolean;
  /** The selected Codex home on that machine; absent keeps its default. */
  codexHome?: string;
}): string {
  const command = powershellScriptCommand(`$ErrorActionPreference='Stop'
if (-not ('ClankieCodexLaunch' -as [type])) { Add-Type -TypeDefinition @'
${launcher}
'@
}
${bridgeScript(input.bridge)}
$session=${powershellLiteral(input.session)}
$pane=${powershellLiteral(input.pane)}
$bindings=@((& herdr session list --json | ConvertFrom-Json).sessions | Where-Object { $_.name -ceq $session -and $_.running })
if($bindings.Count -ne 1){throw 'Herdr binding unavailable'}
$env:HERDR_SOCKET_PATH=$bindings[0].socket_path
$info=(& herdr pane process-info --pane $pane | ConvertFrom-Json).result.process_info
if($info.pane_id -cne $pane){throw 'Allocated pane unavailable'}
$shellProcess=Get-Process -Id ([int]$info.shell_pid) -ErrorAction Stop
$shell=[ordered]@{pid=[int]$info.shell_pid;startTime=$shellProcess.StartTime.ToUniversalTime().ToString('O')}
$installed=@(Get-Command codex.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object {[ClankieCodexLaunch]::Canonical($_.Source)})
foreach($shim in @(Get-Command codex.cmd -All -CommandType Application -ErrorAction SilentlyContinue)){
 foreach($relative in @('node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe','node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe')){
  $candidate=Join-Path (Split-Path $shim.Source) $relative
  if(Test-Path -LiteralPath $candidate -PathType Leaf){$installed += [ClankieCodexLaunch]::Canonical($candidate)}
 }
}
$installed=@($installed | Select-Object -Unique)
if($installed.Count -ne 1){throw 'Unique installed native Codex unavailable'}
$cwd=[ClankieCodexLaunch]::DirectoryCanonical(${powershellLiteral(input.cwd)})
$environment=[Environment]::GetEnvironmentVariables()
$environment['HERDR_PANE_ID']=$pane
$environment['HERDR_SOCKET_PATH']=$bindings[0].socket_path
${input.catalogObserved ? "$environment['CLANKIE_CODEX_CATALOG_OBSERVED']='1'" : ""}
${input.codexHome === undefined ? "" : `$environment['CODEX_HOME']=${powershellLiteral(input.codexHome)}`}
$block=(@($environment.Keys | Sort-Object | ForEach-Object {[string]$_ + '=' + [string]$environment[$_]}) -join [char]0) + [char]0 + [char]0
$bridgeConfig=[string[]]@('-c','mcp_servers.clankie.enabled=false','-c','mcp_servers.worker.enabled=true','-c','mcp_servers.worker.env.NODE_OPTIONS=""','-c','mcp_servers.worker.env.NODE_PATH=""','-c',('mcp_servers.worker.command=' + (ConvertTo-Json -InputObject $bridgeNode -Compress)),'-c',('mcp_servers.worker.args=' + (ConvertTo-Json -InputObject @($bridgeEntry) -Compress)),'-c',('mcp_servers.worker.env.HERDR_PANE_ID=' + (ConvertTo-Json -InputObject $pane -Compress)),'-c',('mcp_servers.worker.env.HERDR_SOCKET_PATH=' + (ConvertTo-Json -InputObject $bindings[0].socket_path -Compress)))
$serverArgs=@(${input.args.slice(0, -3).map(powershellLiteral).join(",")}) + $bridgeConfig + @(${input.args.slice(-3).map(powershellLiteral).join(",")})
$created=[ClankieCodexLaunch]::Start($installed[0],[string[]]$serverArgs,$cwd,$block)
[ordered]@{pid=$created.pid;log='';bridge=[ordered]@{root=$bridgeRoot;node=$bridgeNode;entry=$bridgeEntry};bridgeConfig=$bridgeConfig;binding=[ordered]@{session=$session;socketPath=$bindings[0].socket_path};shell=[ordered]@{pid=$shell.pid;startTime=$shell.startTime};server=[ordered]@{pid=$created.pid;startTime=$created.startTime;executable=$installed[0]}} | ConvertTo-Json -Compress -Depth 5
`);
  // Includes the PowerShell executable/flags; reserve 767 characters for sshd
  // default-shell wrapping and the terminating NUL. Reject before any SSH call.
  if (command.length > 32_000)
    throw new Error("Windows Codex launch command exceeds 32000 characters; no agent created");
  return command;
}
