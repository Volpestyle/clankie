import type { AgentTurnInput } from "./turn.ts";
import { agentTurnArgs } from "./turn.ts";
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Windows PowerShell 5.1-compatible supervisor; compiled in memory, never installed. */
export function powershellTurnScript(input: AgentTurnInput, token: string, duration: number): string {
  const args = agentTurnArgs(input, "PROMPT_FILE")
    .map((arg) => (arg === "PROMPT_FILE" ? "$prompt" : literal(arg)))
    .join(",");
  const inner = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $OutputEncoding=New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding=$OutputEncoding; [Console]::InputEncoding=$OutputEncoding; Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue; $dir=Join-Path $env:TEMP 'clankie-agent-turn-${token}'; $prompt=Join-Path $dir 'prompt'; $argv=@(${args}); try { ${input.harness === "grok" ? `& ${literal(input.harness)} @argv` : `$message=[Console]::In.ReadToEnd(); $message | & ${literal(input.harness)} @argv`}; if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 127 }`;
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding $false
$dir=Join-Path $env:TEMP 'clankie-agent-turn-${token}'
[void][IO.Directory]::CreateDirectory($dir)
try {
  if(Test-Path -LiteralPath (Join-Path $dir 'cancel')) { [Console]::Error.WriteLine(); [Console]::Error.WriteLine("CLANKIE_RUN_${token}:125:aborted"); exit 0 }
  $message=[Console]::In.ReadToEnd()
  [IO.File]::WriteAllText((Join-Path $dir 'prompt'),$message,(New-Object System.Text.UTF8Encoding $false))
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
public static class ClankieTurnSupervisor {
  static void Forward(StreamReader reader, bool error) {
    var buffer=new char[4096];
    try {
      int count;
      while((count=reader.Read(buffer,0,buffer.Length))>0) {
        if(error)Console.Error.Write(buffer,0,count);else Console.Out.Write(buffer,0,count);
      }
    } catch(IOException) {} catch(ObjectDisposedException) {}
  }
  static bool StopTree(Process process) {
    if(process.HasExited)return true;
    using(var kill=new Process()) {
      kill.StartInfo=new ProcessStartInfo("taskkill.exe", "/PID "+process.Id+" /T /F") {UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true};
      kill.Start();
      if(!kill.WaitForExit(5000)) {kill.Kill();return false;}
      return kill.ExitCode==0 && process.WaitForExit(5000);
    }
  }
  public static string Run(string arguments,string cwd,string input,string directory,int timeout) {
    using(var process=new Process()) {
      process.StartInfo=new ProcessStartInfo("powershell.exe",arguments) {WorkingDirectory=cwd,UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=System.Text.Encoding.UTF8,StandardErrorEncoding=System.Text.Encoding.UTF8};
      bool started=false;
      try {
        process.Start();started=true;
        var output=Task.Run(()=>Forward(process.StandardOutput,false));
        var errors=Task.Run(()=>Forward(process.StandardError,true));
        Task.Run(()=>{try { var bytes=System.Text.Encoding.UTF8.GetBytes(input);process.StandardInput.BaseStream.Write(bytes,0,bytes.Length);process.StandardInput.Close(); } catch(Exception) {} });
        var watch=Stopwatch.StartNew();
        string reason="completed";
        while(!process.WaitForExit(100)) {
          if(File.Exists(Path.Combine(directory,"cancel")))reason="aborted";
          else if(watch.ElapsedMilliseconds>=timeout)reason="timeout";
          else continue;
          if(!StopTree(process))reason="unknown";
          break;
        }
        Task.WaitAll(new Task[] {output,errors},500);
        return (process.HasExited?process.ExitCode:125)+":"+reason;
      } catch(Exception error) {
        Console.Error.WriteLine(error.Message);
        return "125:"+(!started || StopTree(process)?"completed":"unknown");
      }
    }
  }
}
'@
  $result=[ClankieTurnSupervisor]::Run('-NoProfile -NonInteractive -EncodedCommand ${encoded}',${literal(input.cwd)},${input.harness === "grok" ? "''" : "$message"},$dir,${duration})
  [Console]::Error.WriteLine(); [Console]::Error.WriteLine("CLANKIE_RUN_${token}:"+$result)
} finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
exit 0`;
}
