# Authored native host; no external provider or account setup.
$ErrorActionPreference = 'Stop'
$framework = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$references = @('System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Core.dll')
$references += @('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll') | ForEach-Object { Join-Path $framework ('WPF\' + $_) }
Add-Type -Path (Join-Path $PSScriptRoot 'LentScreen.cs') -ReferencedAssemblies $references
[ClankieLentScreen]::Run()
