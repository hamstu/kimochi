param([Parameter(Mandatory=$true)][string]$RunDir)
$ErrorActionPreference='Stop'
Get-PSDrive C,G
if ((Get-PSDrive C).Free -lt 8GB -or (Get-PSDrive G).Free -lt 8GB) {
    throw 'Below the build disk floor; stop building and clean only this repository cargo target.'
}
$runRoot=[IO.Path]::GetFullPath($RunDir)
New-Item -ItemType Directory -Force $runRoot,(Join-Path $runRoot 'game'),(Join-Path $runRoot 'evidence') | Out-Null
$output=Join-Path $runRoot 'Desktop.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 "/out:$output" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "$PSScriptRoot\Desktop.cs"
if ($LASTEXITCODE -ne 0) { throw 'Desktop helper compilation failed' }
Write-Output "Built $output; set KIMOCHI_E2E_DIR to $runRoot."
