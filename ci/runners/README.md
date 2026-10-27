# Build runners

CI runs on our own machines, registered as GitHub Actions self-hosted runners for this
repository. Self-hosted runners are free on every GitHub plan and never touch the Actions
minutes quota; GitHub only provides the queue, the logs and the artifact storage. A job waits
up to 24 hours for a matching runner, so a machine that is off just picks the job up when it
is back.

Runs and artifacts: https://github.com/hamstu/kimochi-tauri/actions
Runner fleet: https://github.com/hamstu/kimochi-tauri/settings/actions/runners

## The fleet

A Mac (Apple Silicon) runs the macOS runner and, in Parallels VMs, the ARM64 Windows and Linux
ones; a Windows 11 x64 PC runs the x64 Windows runner and, in WSL, the x64 Linux one.

| Machine | Labels | Builds |
| --- | --- | --- |
| macOS, Apple Silicon | `macOS`, `ARM64` | macOS, plus the `plan` and `release` jobs |
| Windows 11 ARM64 VM | `Windows`, `ARM64` | Windows ARM64 |
| Ubuntu 24.04 ARM64 VM | `Linux`, `ARM64`, `ubuntu` | Linux ARM64 |
| Arch Linux ARM64 VM | `Linux`, `ARM64`, `arch` | Linux ARM64, only when a manual run ticks "Arch" |
| Windows 11 x64 PC | `Windows`, `X64` | Windows x64 |
| WSL Ubuntu on that PC | `Linux`, `X64`, `ubuntu` | Linux x64 |

Every runner also carries the `kimochi` label and the automatic `self-hosted` one. The
workflow picks machines by OS + architecture (+ distro) labels, never by name, so a
replacement machine only needs the same labels.

## How a runner stays up

- macOS: a launchd agent in `~/Library/LaunchAgents/actions.runner.*.plist`, started at login.
- Linux: a systemd unit `actions.runner.*.service`, started at boot, running as the build user, with a
  `restart.conf` drop-in (`Restart=always`) that `setup-runner.sh` adds.
- Windows: a Windows service `actions.runner.*`, start type Automatic, running as LocalSystem.
  Jobs use the runner's own rustup/cargo in `<runner dir>\_rust` (through the runner's `.env` and
  `.path` files), never a user's, so `tauri dev` on the same machine can't lock files a job needs.
- Parallels VMs: `prlctl set <vm> --autostart start-host` starts the VM with Parallels.
- WSL: see [WSL runner](#wsl-runner) below.

The runner application updates itself. Check a machine with `./svc.sh status` (macOS/Linux)
or `Get-Service actions.runner.*` (Windows); logs live in `_diag/` beside the runner.

## WSL runner

WSL only runs while a session holds the distro open, and only in its owner's Windows session.
`install-wsl-keepalive.ps1` (elevated, on the Windows host; needs OpenSSH Server) sets up:

```powershell
powershell -ExecutionPolicy Bypass -File ci\runners\install-wsl-keepalive.ps1 -Distro Ubuntu -User <user> -SshPort <port> -CompactBelowGB 12
```

- `WSL keepalive (Ubuntu)`: a SYSTEM task at boot (nobody needs to log on) that SSHes to the
  machine's own sshd as the user and holds `wsl.exe -d Ubuntu -u root -- sleep infinity`.
- `WSL watchdog (Ubuntu)`: a SYSTEM task at boot and every 5 minutes running
  `wsl-watchdog.ps1`. It restarts the keepalive when it has exited, probes the distro with
  `/usr/local/sbin/runner-health` (restarting the runner unit if inactive) and, after two failed
  probes in a row, resets WSL (`wsl --shutdown`, restart `WSLService`, start the keepalive). It
  also warns when C: or the distro's drive has under 10 GB free (Application log, source
  `WslWatchdog`, event 1001). With `-CompactBelowGB N` it also compacts the vhdx (the manual
  steps below) when the distro's drive has under N GB free, no job is running and the last
  compaction was over a day ago; WSL, and anything else running in the distro, is down for about
  five minutes. Log: `C:\ProgramData\wsl-keepalive\watchdog.log`.
- `vmIdleTimeout=-1` and `instanceIdleTimeout=-1` in the user's `.wslconfig`, and the
  `Restart=always` drop-in for the runner unit inside the distro.
- `wsl-housekeeping.timer` inside the distro (Sundays 03:00): prunes Docker's build cache older
  than a week and dangling images, caps the journal at 200 MB, `apt-get clean`, keeps two snap
  revisions and runs `fstrim /`, so the vhdx has something to give back when it is compacted.
  Docker's build cache was the biggest filler on the Ubuntu VM (26 GB in a week).

Failure seen on the x64 Windows runner (October 2026): the distro's `ext4.vhdx` had grown until C: was
full; the distro died and every start then failed with `Wsl/Service/CreateInstance/E_FAIL`
(error code 6, failure step 2) while the WSL utility VM stayed up. Only `wsl --shutdown` plus a
`WSLService` restart cleared it, which is what the watchdog now does. The distro now lives on a
second SSD (moved with `wsl --manage Ubuntu --move`), away from C:.

The vhdx grows but never shrinks on its own: ext4 spreads writes over its whole 1 TB virtual
size, so the file creeps towards used space plus everything ever written, whatever the build
caches are capped at. To reclaim space by hand: inside the distro delete
regenerable data (`_work/*/src-tauri/target`, `~/.npm/_cacache`, `apt-get clean`) and run
`sudo fstrim -v /`; then on Windows (elevated) disable both keepalive tasks and the watchdog,
`wsl --shutdown`, `Stop-Service WSLService`, wait until the vhdx opens exclusively (the utility
VM can hold a kernel handle on it for a minute after the service stops; a `vmwp.exe` that still
parents a `vmmemWSL` process has to be ended), and in `diskpart`: `select vdisk
file=<ext4.vhdx>`, `compact vdisk`, nothing else. Then re-enable and start the tasks. Compact the
detached file: `attach vdisk readonly` first hangs or fails with "Incorrect function", reclaims
nothing (101 GB stayed 101 GB) and leaves an attachment behind, after which every start fails
with `MountDisk/HCS/ERROR_SHARING_VIOLATION` or `E_ACCESSDENIED` until it is dismounted. Do not
kill `diskpart` either; let it exit. Sparse vhdx mode (`wsl --manage --set-sparse`) needs
`--allow-unsafe` and is left off. Second occurrence (24 October 2026): G: was down to 7 MB free
with the vhdx at 108 GB; freeing caches inside the distro took it from 95 GB to 39 GB used and
the detached compaction took the file from 103 GB to 49 GB.

## Adding or re-registering a machine

1. On the Mac: `ci/runners/token.sh` prints a registration token (valid one hour, reusable).
2. macOS/Linux, as the build user:
   ```sh
   RUNNER_TOKEN=... ci/runners/setup-runner.sh --name NAME --labels kimochi[,ubuntu|arch] --deps
   ```
   `--deps` installs rustup and the Tauri system packages (apt or pacman). Linux builds also
   link libavif 1.x for dictionary images (`libavif-dev` on Ubuntu, `libavif` on Arch);
   `node scripts/linux-appimage.mjs --check-avif` says whether a machine has it, and the bundle
   job runs that check first.
3. Windows, in an elevated PowerShell:
   ```powershell
   $env:RUNNER_TOKEN = '...'
   powershell -ExecutionPolicy Bypass -File ci\runners\setup-runner.ps1 -Name NAME -Labels kimochi -Dir C:\actions-runner
   ```
   Installs its own rustup under `<Dir>\_rust`. Needs Visual Studio Build Tools with the C++ workload (ARM64 tools and
   the Clang component on ARM, since `ring` compiles with clang there), and the WebView2
   runtime. NSIS is fetched by the Tauri CLI on first use. For signing, the Azure CLI must be
   installed at its default path (`artifact-signing-cli` refuses to run without
   `C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd`, though it signs with the
   service principal from the secrets): `msiexec /i https://aka.ms/installazurecliwindowsx64 /qn`
   (the x64 build, which also runs on ARM64). Azure's signing library is x64 C++/CLI, so the
   .NET 8 x64 runtime is needed too (`https://aka.ms/dotnet/8.0/dotnet-runtime-win-x64.exe
   /install /quiet`; on ARM64 it installs beside the native one, under `dotnet\x64`). Without it
   signtool exits with code 3 and prints nothing.
4. Re-running either script with the same `--name` replaces the registration.

To share the fleet across repositories, register the runners against an organisation instead
(`token.sh --org NAME`, `--url https://github.com/NAME`); personal accounts cannot own runners.

## Builds are incremental

Runners are persistent, so the workflow checks out with `clean: false` and keeps
`src-tauri/target`, `capture-core/target`, `node_modules` and the staged OCR runtimes between
runs. Everything else is `git clean`ed. Delete `_work/kimochi-tauri` beside a runner for a
cold build. Expect 10–20 GB per machine for the work directory.

Cargo never deletes stale artifacts, so a kept target directory only grows (25 GB on the Ubuntu
VM within a week). Every `checks` and `bundle` job therefore runs `prune-build-cache.sh` first,
which wipes the Rust target directories (the next build is a cold one) when they are older than
7 days, larger than 25 GB together, or the drive has under 15 GB free; it also drops runner
`_diag` logs older than 30 days. Running inside the jobs means it never deletes a cache a build
is using. Override the limits per machine in the runner's `.env` (restart the runner service
afterwards):

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIMOCHI_CACHE_MAX_DAYS` | 7 | Wipe the target directories this long after the last wipe |
| `KIMOCHI_CACHE_MAX_GB` | 25 | Wipe them when they exceed this |
| `KIMOCHI_MIN_FREE_GB` | 15 | Wipe them when the drive has less free; `0` turns the check off |
| `KIMOCHI_FREE_SPACE_PATH` | the checkout | Where to measure free space |

Where a small drive holds the WSL distro's vhdx, which only shrinks when the watchdog compacts
it, the WSL runner sets a lower `KIMOCHI_CACHE_MAX_GB`, `KIMOCHI_MIN_FREE_GB=0` and
`KIMOCHI_FREE_SPACE_PATH` to that drive's mount (deleting inside WSL gives nothing back to it). A
Windows runner's work directory can live on another drive than the runner (set `workFolder` in
the runner's `.runner` file).
After moving a work directory, delete its `*/target` directories: build scripts record absolute
paths, so a moved cache fails with "failed to read plugin permissions" pointing at the old path.

## OCR crates

The public `kimochi-meikiocr` and `kimochi-mangaocr` crates are git dependencies pinned to exact
revisions in `src-tauri/Cargo.toml`; Cargo fetches them into the runner's `~/.cargo/git`, and no
credentials are needed.

## Triggers and releases

Bundles are published to GitHub Releases, not kept as workflow artifacts: release assets are
not metered the way Actions artifact storage is (500 MB on the Free plan), each file may be up
to 2 GB, and there is no total cap beyond fair use.

- Push to `main`: debug bundles for every platform, uploaded into the rolling `nightly`
  pre-release. Its tag moves to the pushed commit and each platform replaces its own asset
  (version-less names such as `Kimochi_x64-setup.exe`), so only one set is ever stored.
- Manual run: choose `bundle` or `release`, and optionally add the Arch runner (its Linux ARM64
  bundles get an `-arch` suffix).
- Tag `v*`: optimised bundles, uploaded into a draft release of that tag with tauri's versioned
  file names. Publish the draft by hand once the bundles look right.

GitHub has no retention setting for releases; a release stays until deleted. To prune old
versions, `gh release list` and `gh release delete <tag> --cleanup-tag`, or add a scheduled job
that keeps the newest N.

Every runner needs the `gh` CLI for the upload (the setup scripts install it); the workflow's
own `GITHUB_TOKEN` is used, nothing to log in.

## Signing

The bundle job signs when the repository has the secrets, and verifies what it signed:

- macOS: `APPLE_CERTIFICATE` (base64 `.p12` of the Developer ID Application certificate) and
  `APPLE_CERTIFICATE_PASSWORD`, imported into a keychain the job creates and deletes, since the
  runner's launchd job cannot use the login keychain; `APPLE_SIGNING_IDENTITY`; and the App
  Store Connect API key for notarisation (`APPLE_API_ISSUER`, `APPLE_API_KEY`,
  `APPLE_API_KEY_CONTENT`, the `.p8` text). Without `APPLE_CERTIFICATE` bundles are ad-hoc signed.
- Windows: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` (service principal) and
  the variables `KIMOCHI_SIGNING_ENDPOINT`, `KIMOCHI_SIGNING_ACCOUNT`, `KIMOCHI_SIGNING_PROFILE`
  for Azure Artifact Signing (`scripts/sign-windows.mjs`).

The workflow runs on pushes to `main`, tags and manual runs only. Keep it off `pull_request`:
on self-hosted runners with these secrets, a fork's pull request would run on these machines.
