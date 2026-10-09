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
if ($arch -eq 'arm64' -and -not (Get-Command clang.exe -ErrorAction SilentlyContinue)) {
  Write-Warning 'clang not found: the `ring` crate needs it on Windows ARM64. Add the "C++ Clang Compiler for Windows" component (Microsoft.VisualStudio.Component.VC.Llvm.Clang) and put its VC\Tools\Llvm\ARM64\bin on the machine PATH.'
}
$webview = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
if (-not $webview) { Write-Warning 'WebView2 runtime not found; install the Evergreen runtime from Microsoft.' }

# Workflow steps with `shell: powershell` run a generated local .ps1, which the default
# Restricted policy refuses.
if ((Get-ExecutionPolicy -Scope LocalMachine) -in @('Restricted', 'Undefined', 'AllSigned')) {
  Set-ExecutionPolicy RemoteSigned -Scope LocalMachine -Force
}

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
# tauri's bundler verifies signatures with the Windows SDK signtool even with a custom
# signCommand, and its registry-based lookup does not find it under LocalSystem.
$kitArch = if ($arch -eq 'arm64') { 'arm64' } else { 'x64' }
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\$kitArch\signtool.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName
if (-not $signtool) { Write-Warning 'signtool.exe not found: install a Windows 10/11 SDK (the bundler needs it to verify signatures).' }
New-Item -ItemType Directory -Force -Path "$Dir\_appdata\Local", "$Dir\_appdata\Roaming" | Out-Null
Set-Content -Path '.env' -Encoding ascii -Value @(
  "CARGO_HOME=$cargoHome",
  "RUSTUP_HOME=$rustupHome",
  "RUSTUP_TOOLCHAIN=stable",
  $(if ($signtool) { "TAURI_WINDOWS_SIGNTOOL_PATH=$signtool" }),
  # LocalSystem's profile lives under C:\Windows\System32, where 32-bit tools get the path
  # redirected to SysWOW64 (tauri's NSIS launcher then fails with "Unable to start child
  # process"). Tools that honour these variables keep their caches beside the runner instead;
  # tauri uses the known-folder API, so tauri.windows.conf.json sets useLocalToolsDir.
  "LOCALAPPDATA=$Dir\_appdata\Local",
  "APPDATA=$Dir\_appdata\Roaming",
  # actions/checkout's ssh-key support runs `icacls /grant:r USERDOMAIN\USERNAME`, which has no
  # mapping for the LocalSystem account's machine name; give it the account's real name.
  "USERDOMAIN=NT AUTHORITY",
  "USERNAME=SYSTEM"
)
# Git's bin folder (bash.exe for `shell: bash` steps) is not on a normal PATH, only cmd\ is.
# The service inherits the machine PATH, so put it there too (the .path file alone did not do).
$gitBin = Join-Path (Split-Path -Parent (Split-Path -Parent (Get-Command git.exe).Source)) 'bin'
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if (($machinePath -split ';') -notcontains $gitBin) {
  [Environment]::SetEnvironmentVariable('Path', "$gitBin;$machinePath", 'Machine')
}
$pathEntries = @("$cargoHome\bin", $gitBin) + ($env:Path -split ';' | Where-Object { $_ })
Set-Content -Path '.path' -Encoding ascii -Value (($pathEntries | Select-Object -Unique) -join ';')

if (-not $NoService) {
  $svc = Get-Service 'actions.runner.*' | Select-Object -First 1
  if ($svc.Status -ne 'Running') { Start-Service $svc.Name }
  Log "Service $($svc.Name) is $((Get-Service $svc.Name).Status), start type $((Get-Service $svc.Name).StartType)"
}
Log "Done. Runner '$Name' should now show as Idle under $Url/settings/actions/runners"
