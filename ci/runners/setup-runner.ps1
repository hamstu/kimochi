<#
.SYNOPSIS
Set up this Windows machine as a persistent GitHub Actions self-hosted runner that starts with
the machine (a Windows service running as LocalSystem, so no password is needed).

.EXAMPLE
$env:RUNNER_TOKEN = '<registration token from ci/runners/token.sh>'
powershell -ExecutionPolicy Bypass -File ci\runners\setup-runner.ps1 -Name arcade-pc -Labels kimochi -Dir G:\actions-runner

Run from an elevated PowerShell. Re-running replaces the existing registration with the same
name. Jobs run as LocalSystem, so the script points them at the named user's Rust toolchain
(RUSTUP_HOME / CARGO_HOME through the runner's .env file) and prepends that user's cargo bin,
Git and Node to the job PATH (.path file).
#>
param(
  [string]$Name = $env:COMPUTERNAME,
  [string]$Labels = '',
  [string]$Url = 'https://github.com/hamstu/kimochi-tauri',
  [string]$Dir = 'C:\actions-runner',
  # The user whose rustup/cargo installation jobs use.
  [string]$ToolchainUser = '',
  [switch]$NoService
)
$ErrorActionPreference = 'Stop'
if (-not $env:RUNNER_TOKEN) { throw 'Set $env:RUNNER_TOKEN to a registration token (ci/runners/token.sh).' }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from an elevated PowerShell.' }
function Log($m) { Write-Host "==> $m" -ForegroundColor Cyan }

$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } 'AMD64' { 'x64' } default { throw "unsupported architecture $($env:PROCESSOR_ARCHITECTURE)" } }

# ------------------------------------------------------------------ toolchain for jobs
if (-not $ToolchainUser) {
  $candidates = Get-ChildItem C:\Users -Directory | Where-Object { Test-Path (Join-Path $_.FullName '.cargo\bin\cargo.exe') }
  if ($candidates.Count -ne 1) { throw 'Pass -ToolchainUser: could not pick a single user with ~\.cargo\bin\cargo.exe' }
  $ToolchainUser = $candidates[0].Name
}
$userHome = "C:\Users\$ToolchainUser"
$cargoHome = "$userHome\.cargo"
$rustupHome = "$userHome\.rustup"
if (-not (Test-Path "$cargoHome\bin\cargo.exe")) { throw "No cargo at $cargoHome\bin; install rustup for $ToolchainUser first (https://rustup.rs)" }
$env:CARGO_HOME = $cargoHome; $env:RUSTUP_HOME = $rustupHome
& "$cargoHome\bin\rustup.exe" show active-toolchain 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Log 'Setting the default Rust toolchain to stable'; & "$cargoHome\bin\rustup.exe" default stable }
& "$cargoHome\bin\rustup.exe" component add clippy | Out-Null
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere) -or -not (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)) {
  Write-Warning 'MSVC C++ build tools not found; install Visual Studio Build Tools with the "Desktop development with C++" workload.'
}
$webview = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
if (-not $webview) { Write-Warning 'WebView2 runtime not found; install the Evergreen runtime from Microsoft.' }

# ------------------------------------------------------------------ runner package
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Location $Dir
if ((Test-Path '.\config.cmd') -and (Test-Path '.\.runner')) {
  Log 'Removing the existing runner registration'
  Get-Service 'actions.runner.*' -ErrorAction SilentlyContinue | Stop-Service -ErrorAction SilentlyContinue
  & .\config.cmd remove --token $env:RUNNER_TOKEN
}
$release = Invoke-RestMethod 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent' = 'kimochi-runner-setup' }
$version = $release.tag_name.TrimStart('v')
$asset = "actions-runner-win-$arch-$version.zip"
$installed = if (Test-Path '.runner_version') { (Get-Content '.runner_version').Trim('"') } else { '' }
if (-not (Test-Path '.\bin\Runner.Listener.exe') -or $installed -ne $version) {
  Log "Downloading runner $version (win/$arch)"
  $zip = Join-Path $env:TEMP $asset
  Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$version/$asset" -OutFile $zip
  if ($release.body -match "BEGIN SHA win-$arch -->([0-9a-f]+)<!-- END SHA") {
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $Matches[1]) { throw "checksum mismatch for $asset" }
  } else { Write-Warning "No published checksum for $asset; continuing unverified" }
  Expand-Archive -Path $zip -DestinationPath $Dir -Force
  Remove-Item $zip
  Set-Content '.runner_version' "`"$version`""
}

# ------------------------------------------------------------------ register + service
$args = @('--unattended', '--replace', '--url', $Url, '--token', $env:RUNNER_TOKEN, '--name', $Name, '--work', '_work')
if ($Labels) { $args += @('--labels', $Labels) }
if (-not $NoService) { $args += @('--runasservice', '--windowslogonaccount', 'NT AUTHORITY\SYSTEM') }
Log "Registering '$Name' with $Url (labels: $Labels)"
& .\config.cmd @args
if ($LASTEXITCODE -ne 0) { throw "config.cmd failed with $LASTEXITCODE" }

# Jobs run as LocalSystem: give them the user's Rust toolchain and the tools on this machine.
Set-Content -Path '.env' -Encoding ascii -Value @(
  "CARGO_HOME=$cargoHome",
  "RUSTUP_HOME=$rustupHome",
  "RUSTUP_TOOLCHAIN=stable",
  # actions/checkout's ssh-key support runs `icacls /grant:r USERDOMAIN\USERNAME`, which has no
  # mapping for the LocalSystem account's machine name; give it the account's real name.
  "USERDOMAIN=NT AUTHORITY",
  "USERNAME=SYSTEM"
)
$pathEntries = @("$cargoHome\bin") + ($env:Path -split ';' | Where-Object { $_ })
Set-Content -Path '.path' -Encoding ascii -Value (($pathEntries | Select-Object -Unique) -join ';')

if (-not $NoService) {
  $svc = Get-Service 'actions.runner.*' | Select-Object -First 1
  if ($svc.Status -ne 'Running') { Start-Service $svc.Name }
  Log "Service $($svc.Name) is $((Get-Service $svc.Name).Status), start type $((Get-Service $svc.Name).StartType)"
}
Log "Done. Runner '$Name' should now show as Idle under $Url/settings/actions/runners"
