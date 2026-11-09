# Builds the harness for x64 and x86 and assembles dist\ (copy that folder to the test machine).
# Targets are explicit so the result is the same on an ARM64 host as on x64.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
cargo build --release --target x86_64-pc-windows-msvc
if ($LASTEXITCODE) { exit $LASTEXITCODE }
cargo build --release --target i686-pc-windows-msvc
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$target = (cargo metadata --format-version 1 --no-deps | ConvertFrom-Json).target_directory
$x64 = Join-Path $target 'x86_64-pc-windows-msvc\release'
$x86 = Join-Path $target 'i686-pc-windows-msvc\release'
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item "$x64\voicehook.exe" "$dist\voicehook.exe"
Copy-Item "$x86\voicehook.exe" "$dist\voicehook32.exe"
Copy-Item "$x64\vhhook.dll" "$dist\voicehook_x64.dll"
Copy-Item "$x86\vhhook.dll" "$dist\voicehook_x86.dll"
Copy-Item "$x64\vh-fixture.exe" "$dist\vh-fixture.exe"
Copy-Item "$x86\vh-fixture.exe" "$dist\vh-fixture32.exe"
Copy-Item "$x64\vh-classify.exe" "$dist\vh-classify.exe"
Copy-Item "$PSScriptRoot\fetch-fixture-libs.ps1" "$dist\fetch-fixture-libs.ps1"
New-Item -ItemType Directory -Force "$dist\tools" | Out-Null
Copy-Item "$PSScriptRoot\tools\*.ps1" "$dist\tools\"
Copy-Item "$PSScriptRoot\selftest.ps1" "$dist\selftest.ps1"
Copy-Item "$PSScriptRoot\README.md" "$dist\README.md"
Get-ChildItem $dist | Format-Table Name, Length
