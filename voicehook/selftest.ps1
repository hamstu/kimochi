# Self-test: runs the fixtures under the hook and checks that every voice line came back as its
# own clip, byte for byte (and that no duplicate or fragment of it came back too).
# Run from dist\ (or wherever the binaries are).
#
#   .\selftest.ps1                       COM scenes (DirectSound, XAudio2) in both bitnesses
#   .\selftest.ps1 -RenpyFrom <dir>      plus the Ren'Py fixture, using the engine of an
#                                        installed Ren'Py 8 game or SDK at <dir> (linked, not copied)
param(
    [string[]]$Scenes = @('ds', 'dss', 'xa9', 'xa8', 'xa7', 'wo', 'sdl'),
    [string]$RenpyFrom = $env:VOICEHOOK_RENPY,
    [switch]$OnlyEngines
)
$here = $PSScriptRoot
$failed = 0
$ran = 0

function Check($out, $expected) {
    & (Join-Path $here 'vh-fixture.exe') check $out $expected
    if ($LASTEXITCODE) { $script:failed++ }
    $script:ran++
}

if (-not $OnlyEngines) {
    foreach ($fx in @('vh-fixture.exe', 'vh-fixture32.exe')) {
        $name = [IO.Path]::GetFileNameWithoutExtension($fx)
        $out = Join-Path $here "captures\selftest-$name"
        if (Test-Path $out) { Remove-Item -Recurse -Force $out }
        $expected = Join-Path $here "captures\selftest-$name.expected.json"
        Write-Host "`n=== $fx" -ForegroundColor Cyan
        & (Join-Path $here 'voicehook.exe') launch --out $out (Join-Path $here $fx) play $expected @Scenes
        Start-Sleep -Milliseconds 500
        Check $out $expected
    }
}

# Ren'Py: the engine of an existing Ren'Py 8 install, our own game folder.
if ($RenpyFrom) {
    Write-Host "`n=== Ren'Py fixture (engine from $RenpyFrom)" -ForegroundColor Cyan
    $exe = Get-ChildItem $RenpyFrom -Filter *.exe | Where-Object { Test-Path (Join-Path $RenpyFrom ($_.BaseName + '.py')) } | Select-Object -First 1
    if (-not $exe) {
        Write-Host "SKIP  no <name>.exe + <name>.py pair in $RenpyFrom" -ForegroundColor Yellow
    } else {
        $root = Join-Path $here 'captures\renpy-fixture'
        if (Test-Path $root) { cmd /c rmdir /s /q "$root" }
        New-Item -ItemType Directory -Force $root | Out-Null
        Copy-Item $exe.FullName (Join-Path $root 'vhfixture.exe')
        Copy-Item (Join-Path $RenpyFrom ($exe.BaseName + '.py')) (Join-Path $root 'vhfixture.py')
        foreach ($d in 'renpy', 'lib') { cmd /c mklink /J (Join-Path $root $d) (Join-Path $RenpyFrom $d) | Out-Null }
        $expected = Join-Path $root 'expected.json'
        & (Join-Path $here 'vh-fixture.exe') renpy-game (Join-Path $root 'game') $expected
        $out = Join-Path $here 'captures\selftest-renpy'
        if (Test-Path $out) { Remove-Item -Recurse -Force $out }
        & (Join-Path $here 'voicehook.exe') launch --out $out (Join-Path $root 'vhfixture.exe')
        Start-Sleep -Milliseconds 500
        Check $out $expected
    }
}

if ($failed) { Write-Host "`nSELFTEST FAILED ($failed of $ran)" -ForegroundColor Red; exit 1 }
Write-Host "`nSELFTEST PASSED ($ran)" -ForegroundColor Green
