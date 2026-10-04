import { z } from "zod";
import { powershellScriptCommand, type FleetShellRun } from "./herdr-fleet.ts";
import type { ComputerUseHarness } from "./computer-use-harnesses.ts";

// Read the native harness, not the active desktop. No model request or GUI process is started.
const probeScript = String.raw`
$ErrorActionPreference = 'Continue'
$command = Get-Command codex -ErrorAction SilentlyContinue
if ($null -eq $command) { @{installed=$false} | ConvertTo-Json -Compress; exit }
$login = (& $command.Source login status 2>&1 | Out-String)
$signedIn = $LASTEXITCODE -eq 0 -and $login -match 'Logged in'
$features = (& $command.Source features list 2>&1 | Out-String)
$enabled = $LASTEXITCODE -eq 0 -and $features -match '(?m)^computer_use\s+.*\s+true\s*$'
$disabled = $false
$selected = $false
$config = Join-Path $env:USERPROFILE '.codex\config.toml'
if (Test-Path -LiteralPath $config) {
  foreach ($line in (Get-Content -LiteralPath $config)) {
    $text = $line.Trim()
    if ($text.StartsWith('[')) { $selected = $text -match '^\[\s*["'']?plugins["'']?\s*\.\s*["'']computer-use@openai-bundled["'']\s*\]\s*(#.*)?$' }
    elseif ($selected -and $text -match '^["'']?enabled["'']?\s*=\s*false\b') { $disabled = $true }
  }
}
$plugin = $false
$root = Join-Path $env:USERPROFILE '.codex\plugins\cache\openai-bundled\computer-use'
foreach ($version in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Select-Object -First 64)) {
  $manifest = Join-Path $version.FullName '.codex-plugin\plugin.json'
  try {
    $entry = Get-Content -Raw -LiteralPath $manifest -ErrorAction Stop | ConvertFrom-Json
    if ($entry.name -eq 'computer-use' -and $entry.keywords -contains 'windows') { $plugin = $true }
  } catch {}
}
@{installed=$true;signedIn=[bool]$signedIn;enabled=[bool]$enabled;disabled=$disabled;plugin=$plugin} | ConvertTo-Json -Compress
`;

export async function detectWindowsComputerUseHarnesses(
  run: FleetShellRun,
  machineId?: string,
): Promise<readonly ComputerUseHarness[]> {
  const raw = JSON.parse(await run(powershellScriptCommand(probeScript), 15000));
  const installed = z.object({ installed: z.boolean() }).parse(raw).installed;
  if (!installed) return [];
  const state = z
    .object({
      installed: z.literal(true),
      signedIn: z.boolean(),
      enabled: z.boolean(),
      disabled: z.boolean(),
      plugin: z.boolean(),
    })
    .parse(raw);
  const ready = state.enabled && !state.disabled && state.plugin;
  const missing = !state.signedIn
    ? "not signed in: the owner runs `codex login`"
    : !state.enabled || state.disabled
      ? "Windows computer use is off: the owner enables the Codex computer-use plugin"
      : !state.plugin
        ? "the native Windows computer-use plugin is not installed"
        : undefined;
  return [
    {
      harness: "codex",
      signedIn: state.signedIn,
      surfaces: ready ? ["desktop"] : [],
      chromeNeedsHireFlag: false,
      platform: "win32",
      ...(machineId === undefined ? {} : { machineId }),
      ...(missing === undefined ? {} : { missing }),
    },
  ];
}
