param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$directory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $directory) { throw 'Use a new private fixture directory' }
[IO.Directory]::CreateDirectory($directory) | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'The existing Windows .NET Framework compiler is unavailable; no installation fallback' }
$exe = Join-Path $directory 'ClankieWindowsComputerFixture.exe'
& $compiler /nologo /codepage:65001 /target:winexe /platform:x64 "/out:$exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'Fixture.cs')
if ($LASTEXITCODE -ne 0) { throw "Fixture build failed: $LASTEXITCODE" }
foreach ($name in @('manifest.json', 'fixture.json', 'Fixture.cs')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $directory $name)
}
Get-FileHash -Algorithm SHA256 -LiteralPath $exe | Select-Object Path,Hash | ConvertTo-Json -Compress
# Build only. Nothing launches this executable or sends desktop input.
