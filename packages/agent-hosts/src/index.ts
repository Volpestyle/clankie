import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

export interface AgentSessionFile {
  harness: "claude" | "codex";
  path: string;
  size: number;
  mtimeMs: number;
}
export interface AgentHost {
  id: string;
  list(opts?: { limit?: number }): Promise<AgentSessionFile[]>;
  readBytes(path: string, from: number, maxBytes: number): Promise<{ bytes: Buffer; size: number }>;
}
export interface AgentHostConfig {
  id: string;
  ssh: string;
  shell: "posix" | "powershell";
}
const MAX_BYTES = 4 * 1024 * 1024;
function limit(value = 100): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
    throw new Error("Invalid session limit (1..1000)");
  return value;
}
function range(from: number, max: number) {
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(max) || max < 1 || max > MAX_BYTES)
    throw new Error("Invalid transcript byte range (maximum 4 MiB)");
}
function within(root: string, path: string) {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
}
export function createLocalAgentHost(options: { home?: string } = {}): AgentHost {
  const home = options.home ?? homedir();
  const roots = [
    { harness: "claude" as const, path: join(home, ".claude", "projects") },
    { harness: "codex" as const, path: join(home, ".codex", "sessions") },
  ];
  return {
    id: "local",
    async list(opts) {
      const count = limit(opts?.limit);
      const files: AgentSessionFile[] = [];
      async function walk(path: string, harness: AgentSessionFile["harness"]) {
        let entries;
        try {
          entries = await readdir(path, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) await walk(file, harness);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            try {
              const info = await stat(file);
              files.push({ harness, path: file, size: info.size, mtimeMs: info.mtimeMs });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        }
      }
      for (const root of roots) await walk(root.path, root.harness);
      return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)).slice(0, count);
    },
    async readBytes(path, from, maxBytes) {
      range(from, maxBytes);
      if (!path.endsWith(".jsonl")) throw new Error("Not a transcript path");
      const actual = await realpath(path);
      let allowed = false;
      for (const root of roots) {
        try {
          if (within(await realpath(root.path), actual)) allowed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!allowed) throw new Error("Transcript path outside allowed roots");
      const file = await open(actual, "r");
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error("Not a transcript file");
        const bytes = Buffer.alloc(Math.min(maxBytes, Math.max(0, info.size - from)));
        const result = await file.read(bytes, 0, bytes.length, from);
        return { bytes: bytes.subarray(0, result.bytesRead), size: info.size };
      } finally {
        await file.close();
      }
    },
  };
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const psQuote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const psRoots =
  "$roots = @(@{h='claude';p=(Join-Path $env:USERPROFILE '.claude\\projects')}, @{h='codex';p=(Join-Path $env:USERPROFILE '.codex\\sessions')})";
function powershell(script: string) {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; " + script, "utf16le").toString("base64")}`;
}
function posix(script: string) {
  return `sh -c ${quote(script)}`;
}
function listCommand(shell: AgentHostConfig["shell"], count: number) {
  if (shell === "powershell")
    return powershell(
      `${psRoots}; $rows = @(foreach ($r in $roots) { if (Test-Path -LiteralPath $r.p) { Get-ChildItem -LiteralPath $r.p -Recurse -File -Filter '*.jsonl' | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | ForEach-Object { [PSCustomObject]@{harness=$r.h; path=$_.FullName; size=$_.Length; mtimeMs=([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds()} } } }); ConvertTo-Json -Compress -InputObject @($rows | Sort-Object mtimeMs -Descending | Select-Object -First ${count})`,
    );
  return posix(`set -eu
for h in claude codex; do
  if [ "$h" = claude ]; then root="$HOME/.claude/projects"; else root="$HOME/.codex/sessions"; fi
  [ -d "$root" ] || continue
  find "$root" -type f -name '*.jsonl' -exec sh -c '
    h=$1; shift
    for p do
      meta=$(stat -c "%s %Y" "$p" 2>/dev/null || stat -f "%z %m" "$p")
      encoded=$(printf "%s" "$p" | base64 | tr -d "\\n")
      printf "%s %s %s\\n" "$meta" "$h" "$encoded"
    done
  ' sh "$h" {} +
done | sort -k2,2nr | head -n ${count}`);
}
function readCommand(shell: AgentHostConfig["shell"], path: string, from: number, max: number) {
  if (shell === "powershell")
    return powershell(
      `${psRoots}; $p=[IO.Path]::GetFullPath(${psQuote(path)}); $ok=$false; foreach($r in $roots) { $root=[IO.Path]::GetFullPath($r.p).TrimEnd('\\')+'\\'; if($p.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { $ok=$true } }; if(-not $ok -or -not $p.EndsWith('.jsonl',[StringComparison]::OrdinalIgnoreCase)) { throw 'Transcript path outside allowed roots' }; $item=Get-Item -LiteralPath $p; for($node=$item; $null -ne $node; $node=$node.Parent) { if($node.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Transcript reparse points are unsupported' }; if($node -is [IO.FileInfo]) { $node=$node.Directory; if($node.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Transcript reparse points are unsupported' } } }; $f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { $size=$f.Length; [void]$f.Seek(${from},[IO.SeekOrigin]::Begin); $b=New-Object byte[] ${max}; $n=0; while($n -lt $b.Length) { $got=$f.Read($b,$n,$b.Length-$n); if($got -eq 0){break}; $n+=$got }; [Console]::WriteLine($size); [Console]::Write([Convert]::ToBase64String($b,0,$n)) } finally { $f.Dispose() }`,
    );
  return posix(`set -eu
p=${quote(path)}
case "$p" in /*.jsonl) ;; *) exit 2;; esac
[ ! -L "$p" ] && [ -f "$p" ] || exit 2
dir=$(CDPATH= cd -P -- "$(dirname "$p")" && pwd)
p="$dir/$(basename "$p")"
ok=false
for root in "$HOME/.claude/projects" "$HOME/.codex/sessions"; do
  [ -d "$root" ] || continue
  root=$(CDPATH= cd -P -- "$root" && pwd)
  case "$p" in "$root"/*) ok=true;; esac
done
[ "$ok" = true ] || exit 2
size=$(stat -c %s "$p" 2>/dev/null || stat -f %z "$p")
printf '%s\\n' "$size"
tail -c +${from + 1} "$p" | head -c ${max} | base64`);
}
export function createSshAgentHost(
  config: AgentHostConfig,
  options: {
    run?: (command: string, args: string[]) => Promise<string>;
  } = {},
): AgentHost {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(config.id) || config.id === "local")
    throw new Error("Invalid remote host ID");
  if (!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(config.ssh))
    throw new Error("Invalid SSH target; use an SSH config alias for advanced options");
  if (!["posix", "powershell"].includes(config.shell)) throw new Error("Invalid remote shell");
  const run =
    options.run ??
    (async (command, args) =>
      (
        await promisify(execFile)(command, args, {
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: "utf8",
        })
      ).stdout);
  const call = (command: string) =>
    run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", config.ssh, command]);
  return {
    id: config.id,
    async list(opts) {
      const count = limit(opts?.limit);
      const output = await call(listCommand(config.shell, count));
      const rows: unknown =
        config.shell === "powershell"
          ? JSON.parse(output.replace(/^\uFEFF/, ""))
          : output
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [size, mtime, harness, path] = line.trim().split(" ");
                return {
                  size: Number(size),
                  mtimeMs: Number(mtime) * 1000,
                  harness,
                  path: Buffer.from(path ?? "", "base64").toString("utf8"),
                };
              });
      if (!Array.isArray(rows) || rows.length > count) throw new Error("Invalid remote session listing");
      return rows.map((row: unknown) => {
        const r = row as AgentSessionFile;
        if (
          !r ||
          !["claude", "codex"].includes(r.harness) ||
          typeof r.path !== "string" ||
          !r.path.endsWith(".jsonl") ||
          !Number.isSafeInteger(r.size) ||
          r.size < 0 ||
          !Number.isFinite(r.mtimeMs)
        )
          throw new Error("Invalid remote session metadata");
        return { harness: r.harness, path: r.path, size: r.size, mtimeMs: r.mtimeMs };
      });
    },
    async readBytes(path, from, maxBytes) {
      range(from, maxBytes);
      if (path.includes("\0") || !path.endsWith(".jsonl")) throw new Error("Invalid transcript path");
      const output = await call(readCommand(config.shell, path, from, maxBytes));
      const newline = output.indexOf("\n");
      const size = Number(output.slice(0, newline).trim());
      const encoded = output.slice(newline + 1).replace(/\s/g, "");
      if (
        newline < 0 ||
        !/^\d+\r?$/.test(output.slice(0, newline)) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
        encoded.length % 4 !== 0
      )
        throw new Error("Invalid remote transcript response");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new Error("Invalid remote transcript encoding");
      if (bytes.length > maxBytes) throw new Error("Oversized remote transcript response");
      return { bytes, size };
    },
  };
}
export function resolveAgentHost(id: string, connections: readonly AgentHostConfig[]): AgentHost {
  if (id === "local") return createLocalAgentHost();
  const config = connections.find((entry) => entry.id === id);
  if (!config) throw new Error(`Unknown agent host: ${id}`);
  return createSshAgentHost(config);
}
