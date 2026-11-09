# Downloads the third-party libraries the engine fixtures load (official release builds), into
# dist\fixture-libs\{x64,x86}. Not committed; selftest.ps1 skips a fixture whose library is missing.
#   SDL2 + SDL2_mixer (zlib licence) from github.com/libsdl-org
$ErrorActionPreference = 'Stop'
# From the source folder: dist\fixture-libs; from dist\ itself: fixture-libs.
$root = if (Test-Path (Join-Path $PSScriptRoot 'voicehook.exe')) { Join-Path $PSScriptRoot 'fixture-libs' } else { Join-Path $PSScriptRoot 'dist\fixture-libs' }
$tmp = Join-Path $root '_download'
New-Item -ItemType Directory -Force $tmp | Out-Null
$libs = @(
    @{ url = 'https://github.com/libsdl-org/SDL/releases/download/release-2.30.9/SDL2-2.30.9-win32-x64.zip'; arch = 'x64' },
    @{ url = 'https://github.com/libsdl-org/SDL/releases/download/release-2.30.9/SDL2-2.30.9-win32-x86.zip'; arch = 'x86' },
    @{ url = 'https://github.com/libsdl-org/SDL_mixer/releases/download/release-2.8.0/SDL2_mixer-2.8.0-win32-x64.zip'; arch = 'x64' },
    @{ url = 'https://github.com/libsdl-org/SDL_mixer/releases/download/release-2.8.0/SDL2_mixer-2.8.0-win32-x86.zip'; arch = 'x86' }
)
foreach ($l in $libs) {
    $zip = Join-Path $tmp ([IO.Path]::GetFileName($l.url))
    if (-not (Test-Path $zip)) {
        Write-Host "downloading $($l.url)"
        Invoke-WebRequest -Uri $l.url -OutFile $zip -UseBasicParsing
    }
    $dest = Join-Path $root $l.arch
    New-Item -ItemType Directory -Force $dest | Out-Null
    $x = Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($zip))
    Expand-Archive -Force $zip $x
    Get-ChildItem $x -Recurse -Filter *.dll | Where-Object { $_.DirectoryName -notmatch 'optional' } | Copy-Item -Destination $dest
}
Remove-Item -Recurse -Force $tmp
Get-ChildItem $root -Recurse -File | Format-Table FullName, Length
