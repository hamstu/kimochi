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
- Linux: a systemd unit `actions.runner.*.service`, started at boot, running as `hamstu`.
- Windows: a Windows service `actions.runner.*`, start type Automatic, running as LocalSystem.
  Jobs use the named user's rustup/cargo through the runner's `.env` and `.path` files.
- Parallels VMs: `prlctl set <vm> --autostart start-host` starts the VM with Parallels. The Omarchy
  VM was left as is.
- WSL: WSL only runs while something holds it open, so `install-wsl-keepalive.ps1` registers a
  hidden scheduled task at logon of the Windows user that keeps the distro (and its systemd
  runner service) alive. Someone has to log on to the arcade PC after a reboot, or enable
  automatic logon, for that runner to come back.

The runner application updates itself. Check a machine with `./svc.sh status` (macOS/Linux)
or `Get-Service actions.runner.*` (Windows); logs live in `_diag/` beside the runner.

## Adding or re-registering a machine

1. On the Mac: `ci/runners/token.sh` prints a registration token (valid one hour, reusable).
2. macOS/Linux, as the build user:
   ```sh
   RUNNER_TOKEN=... ci/runners/setup-runner.sh --name NAME --labels kimochi[,ubuntu|arch] --deps
   ```
   `--deps` installs rustup and the Tauri system packages (apt or pacman). On Linux the build
   user needs passwordless sudo (the workflow's apt step uses it too).
3. Windows, in an elevated PowerShell:
   ```powershell
   $env:RUNNER_TOKEN = '...'
   powershell -ExecutionPolicy Bypass -File ci\runners\setup-runner.ps1 -Name NAME -Labels kimochi -Dir C:\actions-runner -ToolchainUser USER
   ```
   Needs rustup for `USER`, Visual Studio Build Tools with the C++ workload (ARM64 tools and
   the Clang component on ARM, since `ring` compiles with clang there), and the WebView2
   runtime. NSIS is fetched by the Tauri CLI on first use.
4. Re-running either script with the same `--name` replaces the registration.

To share the fleet across repositories, register the runners against an organisation instead
(`token.sh --org NAME`, `--url https://github.com/NAME`); personal accounts cannot own runners.

## Builds are incremental

Runners are persistent, so the workflow checks out with `clean: false` and keeps
`src-tauri/target`, `capture-core/target`, `node_modules` and the staged OCR runtimes between
runs. Everything else is `git clean`ed. Delete `_work/kimochi-tauri` beside a runner for a
cold build. Expect 10–20 GB per machine for the work directory.

## Sibling repositories

The private `kimochi-meikiocr` and `kimochi-mangaocr` repositories are checked out beside this
one with read-only deploy keys (secrets `MEIKIOCR_DEPLOY_KEY` and `MANGAOCR_DEPLOY_KEY`,
public halves added as deploy keys on each sibling). `SIBLING_REPOS_TOKEN`, a fine-grained PAT
with Contents: read on both, works as an alternative.

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
