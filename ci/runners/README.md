# Build runners

CI runs on our own machines, registered as GitHub Actions self-hosted runners for this
repository. Self-hosted runners are free on every GitHub plan and never touch the Actions
minutes quota; GitHub only provides the queue, the logs and the artifact storage. A job waits
up to 24 hours for a matching runner, so a machine that is off just picks the job up when it
is back.

Runs and artifacts: https://github.com/hamstu/kimochi-tauri/actions
Runner fleet: https://github.com/hamstu/kimochi-tauri/settings/actions/runners

## The fleet

| Runner | Machine | Labels | Builds |
| --- | --- | --- | --- |
| `typhon` | This Mac (Apple Silicon) | `macOS`, `ARM64` | macOS, plus the `plan` and `release` jobs |
| `win11-arm-vm` | Parallels "Windows 11" VM on the Mac | `Windows`, `ARM64` | Windows ARM64 |
| `ubuntu-arm-vm` | Parallels "Ubuntu 24.04.3 ARM64" VM on the Mac | `Linux`, `ARM64`, `ubuntu` | Linux ARM64 |
| `omarchy-arm-vm` | Parallels "Omarchy ARM" VM on the Mac (Arch) | `Linux`, `ARM64`, `arch` | Linux ARM64, only when a manual run ticks "Arch" |
| `arcade-pc` | Windows 11 x64 PC (SSH host `arcade-pc`) | `Windows`, `X64` | Windows x64 |
| `arcade-pc-wsl` | WSL Ubuntu inside the arcade PC (SSH host `arcade-pc-wsl`) | `Linux`, `X64`, `ubuntu` | Linux x64 |

Every runner also carries the `kimochi` label and the automatic `self-hosted` one. The
workflow picks machines by OS + architecture (+ distro) labels, never by name, so a
replacement machine only needs the same labels.

## How a runner stays up

- macOS: a launchd agent in `~/Library/LaunchAgents/actions.runner.*.plist`, started at login.
- Linux: a systemd unit `actions.runner.*.service`, started at boot, running as `hamstu`, with a
  `restart.conf` drop-in (`Restart=always`) that `setup-runner.sh` adds.
- Windows: a Windows service `actions.runner.*`, start type Automatic, running as LocalSystem.
  Jobs use the runner's own rustup/cargo in `<runner dir>\_rust` (through the runner's `.env` and
  `.path` files), never a user's, so `tauri dev` on the same machine can't lock files a job needs.
- Parallels VMs: `prlctl set <vm> --autostart start-host` starts the VM with Parallels. The Omarchy
  VM was left as is.
- WSL: see [WSL runner](#wsl-runner) below.

The runner application updates itself. Check a machine with `./svc.sh status` (macOS/Linux)
or `Get-Service actions.runner.*` (Windows); logs live in `_diag/` beside the runner.

## WSL runner

WSL only runs while a session holds the distro open, and only in its owner's Windows session.
`install-wsl-keepalive.ps1` (elevated, on the Windows host; needs OpenSSH Server) sets up:

```powershell
powershell -ExecutionPolicy Bypass -File ci\runners\install-wsl-keepalive.ps1 -Distro Ubuntu -User hamst -SshPort 2222
```

- `WSL keepalive (Ubuntu)`: a SYSTEM task at boot (nobody needs to log on) that SSHes to the
  machine's own sshd as the user and holds `wsl.exe -d Ubuntu -u root -- sleep infinity`.
- `WSL watchdog (Ubuntu)`: a SYSTEM task at boot and every 5 minutes running
  `wsl-watchdog.ps1`. It restarts the keepalive when it has exited, probes the distro with
  `/usr/local/sbin/runner-health` (restarting the runner unit if inactive) and, after two failed
  probes in a row, resets WSL (`wsl --shutdown`, restart `WSLService`, start the keepalive). It
  also warns when C: or the distro's drive has under 10 GB free (Application log, source
  `WslWatchdog`, event 1001). Log: `C:\ProgramData\wsl-keepalive\watchdog.log`.
- `vmIdleTimeout=-1` and `instanceIdleTimeout=-1` in the user's `.wslconfig`, and the
  `Restart=always` drop-in for the runner unit inside the distro.

Failure seen on the arcade PC (2026-10-15): the distro's `ext4.vhdx` had grown until C: was
full; the distro died and every start then failed with `Wsl/Service/CreateInstance/E_FAIL`
(error code 6, failure step 2) while the WSL utility VM stayed up. Only `wsl --shutdown` plus a
`WSLService` restart cleared it, which is what the watchdog now does. The distro now lives on the
G: SSD (`G:\wsl\Ubuntu`, moved with `wsl --manage Ubuntu --move`), away from C:.

The vhdx grows but never shrinks on its own. To reclaim space: inside the distro delete
regenerable data (`_work/*/src-tauri/target`, `~/.npm/_cacache`, `apt-get clean`) and run
`sudo fstrim -v /`; then on Windows (elevated) disable both keepalive tasks and the watchdog,
`wsl --shutdown`, `Stop-Service WSLService`, and in `diskpart`: `select vdisk file=<ext4.vhdx>`,
`attach vdisk readonly`, `compact vdisk`, `detach vdisk`; re-enable and start the tasks. Sparse
vhdx mode (`wsl --manage --set-sparse`) needs `--allow-unsafe` and is left off.

## Adding or re-registering a machine

1. On the Mac: `ci/runners/token.sh` prints a registration token (valid one hour, reusable).
2. macOS/Linux, as the build user:
   ```sh
   RUNNER_TOKEN=... ci/runners/setup-runner.sh --name NAME --labels kimochi[,ubuntu|arch] --deps
   ```
   `--deps` installs rustup and the Tauri system packages (apt or pacman).
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
