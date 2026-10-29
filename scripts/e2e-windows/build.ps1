param([Parameter(Mandatory=$true)][string]$RunDir)
$ErrorActionPreference='Stop'
# The system drive, and the drive the debug build lives on when it is another one.
$drives=@('C')
if ($env:KIMOCHI_E2E_EXE) { $drives+=([IO.Path]::GetPathRoot($env:KIMOCHI_E2E_EXE)).Substring(0,1) }
foreach ($d in ($drives | Select-Object -Unique)) {
    if ((Get-PSDrive $d).Free -lt 8GB) { throw "Below the 8 GB disk floor on $($d):; clean only this repository's cargo target." }
}
$runRoot=[IO.Path]::GetFullPath($RunDir)
New-Item -ItemType Directory -Force $runRoot,(Join-Path $runRoot 'game'),(Join-Path $runRoot 'evidence') | Out-Null
$output=Join-Path $runRoot 'Desktop.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:anycpu "/out:$output" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "$PSScriptRoot\Desktop.cs"
if ($LASTEXITCODE -ne 0) { throw 'Desktop helper compilation failed' }
Write-Output "Built $output; set KIMOCHI_E2E_DIR to $runRoot."
