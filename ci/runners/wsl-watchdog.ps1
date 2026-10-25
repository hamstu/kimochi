<#
Watchdog for the WSL runner, run as SYSTEM every few minutes by the "WSL watchdog (<Distro>)"
task that install-wsl-keepalive.ps1 registers. Each run:

  1. warns (log + Application event 1001) when C: or the drive holding the distro's disk is low
     on space: a full host drive is what kills the distro, since its ext4.vhdx cannot grow;
  2. starts the "WSL keepalive (<Distro>)" task if it is not running;
  3. probes the distro through the same SSH-to-self session the keepalive uses (SYSTEM cannot
     run a user's distro directly) with /usr/local/sbin/runner-health (installed by
     install-wsl-keepalive.ps1), which restarts the runner's systemd unit if it is inactive;
  4. if the distro does not answer twice in a row, resets WSL: stops the keepalive, runs
     `wsl --shutdown`, restarts WSLService, starts the keepalive again. That clears the state
     where the utility VM is up but every start fails with Wsl/Service/CreateInstance/E_FAIL;
  5. with -CompactBelowGB set, compacts the distro's vhdx when its drive has less free than that,
     the runner is idle and the last compaction was over a day ago: fstrim inside, stop WSL,
     wait until nothing holds the vhdx, diskpart `compact vdisk` on the detached file, start WSL
     again (a few minutes). The vhdx only ever grows (ext4 spreads writes over its whole virtual
     size and Windows never takes freed blocks back), so without this it creeps up to fill the
     drive however small the build caches are kept. The file must be compacted detached: an
     `attach vdisk readonly` first hangs or fails on this host, reclaims nothing, and leaves a
     stale attachment that makes every later start fail with MountDisk/HCS sharing violations.

Logs to C:\ProgramData\wsl-keepalive\watchdog.log.
#>
param(
  [string]$Distro = 'Ubuntu',
  [string]$User = $env:USERNAME,
  [int]$SshPort = 22,
  [int]$MinFreeGB = 10,
  [int]$CompactBelowGB = 0
)
$ErrorActionPreference = 'Continue'
$dir = 'C:\ProgramData\wsl-keepalive'
$log = "$dir\watchdog.log"
$state = "$dir\watchdog.failures"
$compactStamp = "$dir\watchdog.compacted"
$keepalive = "WSL keepalive ($Distro)"
$ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe"

function Log($msg) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.1" -Force }
  Add-Content -Path $log -Value $line
}
function Alert($msg) {
  Log "WARN $msg"
  if (-not [Diagnostics.EventLog]::SourceExists('WslWatchdog')) { New-EventLog -LogName Application -Source WslWatchdog }
  Write-EventLog -LogName Application -Source WslWatchdog -EntryType Warning -EventId 1001 -Message $msg
}

# Runs a command on this machine as $User through SSH (the distro is that user's); returns $null
# on timeout. The user's shell may print a profile banner first, so callers match markers.
function AsUser([string]$cmd, [int]$timeoutSec = 90) {
  $out = [IO.Path]::GetTempFileName()
  $err = [IO.Path]::GetTempFileName()
  $sshArgs = @('-i', "`"$dir\id_ed25519`"", '-o', 'StrictHostKeyChecking=no', '-o', "UserKnownHostsFile=`"$dir\known_hosts`"",
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', $SshPort, "$User@127.0.0.1", "`"$cmd`"")
  $p = Start-Process -FilePath $ssh -ArgumentList $sshArgs -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle  # keeps ExitCode readable once the process has exited
  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Remove-Item $out, $err -ErrorAction SilentlyContinue
    return $null
  }
  $text = ((Get-Content $out -Raw) + (Get-Content $err -Raw)) -replace "`0", ''
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  [pscustomobject]@{ Code = $p.ExitCode; Text = "$text".Trim() }
}
function Describe($r) {
  if (-not $r) { return 'timed out' }
  $lines = $r.Text -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch '^\*\*|Developer PowerShell|Copyright' }
  "exit $($r.Code): $(($lines | ForEach-Object { $_.Trim() }) -join ' | ')"
}

# True once nothing holds the vhdx open. After WSLService stops, the utility VM can outlive it for
# a minute or so with a kernel handle on the file; a VM worker still hosting a WSL partition
# (the parent of a vmmemWSL process) is ended, which is what finally releases the handle.
function Wait-VhdxFree([string]$path, [int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  do {
    try { $fs = [IO.File]::Open($path, 'Open', 'ReadWrite', 'None'); $fs.Close(); return $true } catch {}
    Get-CimInstance Win32_Process -Filter "Name='vmmemWSL'" -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.ParentProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Compact-IfLow {
  $vhdx = Join-Path $basePath 'ext4.vhdx'
  $drive = $basePath.Substring(0, 1)
  $free = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
  if ($free -ge $CompactBelowGB -or -not (Test-Path $vhdx)) { return }
  if ((Test-Path $compactStamp) -and (Get-Item $compactStamp).LastWriteTime -gt (Get-Date).AddDays(-1)) { return }
  $w = AsUser "wsl.exe -d $Distro -u root --exec /usr/bin/pgrep -c -x Runner.Worker"
  $n = if ($w) { [regex]::Match($w.Text, '(?m)^\s*(\d+)\s*$') } else { $null }
  if (-not $n -or -not $n.Success -or [int]$n.Groups[1].Value -gt 0) { Log "compaction wanted (${drive}: $free GB free) but a job is running; later"; return }
  Set-Content $compactStamp (Get-Date -Format s)
  $before = [math]::Round((Get-Item $vhdx).Length / 1GB, 1)
  Alert "Drive ${drive}: has $free GB free; compacting $vhdx ($before GB). WSL ($Distro) stops for a few minutes."
  $null = AsUser "wsl.exe -d $Distro -u root --exec /usr/bin/systemctl stop actions.runner.*"
  $t = AsUser "wsl.exe -d $Distro -u root --exec /usr/sbin/fstrim -v /" 600
  Log "fstrim: $(Describe $t)"
  Disable-ScheduledTask -TaskName $keepalive | Out-Null  # later watchdog runs skip while disabled
  try {
    Stop-ScheduledTask -TaskName $keepalive -ErrorAction SilentlyContinue
    $null = AsUser 'wsl.exe --shutdown'
    Start-Sleep -Seconds 5
    Stop-Service WSLService -Force -ErrorAction SilentlyContinue
    if (-not (Wait-VhdxFree $vhdx 120)) { Log 'vhdx still held open after 120 s; compaction skipped'; return }
    $script = "$dir\compact.txt"
    # Detached compaction: no attach/detach (see the header).
    "select vdisk file=`"$vhdx`"`r`ncompact vdisk`r`n" | Set-Content -Encoding ascii $script
    $out = & diskpart /s $script 2>&1 | Where-Object { $_ -match 'successfully|error|failed' }
    Log "diskpart: $($out -join ' | ')"
  } finally {
    # Nothing may hold the file when WSL comes back or every start fails with a sharing violation.
    # diskpart can outlive its script while it finishes with the file; it must be left to exit
    # (killing it leaves a kernel handle behind for a minute or more), then any attachment it
    # left is dismounted and the file is checked once more.
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Process -Name diskpart -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
    try { if ((Get-DiskImage -ImagePath $vhdx -ErrorAction Stop).Attached) { Dismount-DiskImage -ImagePath $vhdx | Out-Null; Log 'dismounted a leftover vhdx attachment' } } catch {}
    if (-not (Wait-VhdxFree $vhdx 180)) { Log 'WARN vhdx still held open after compaction; WSL may not start until it is released' }
    Start-Service WSLService -ErrorAction SilentlyContinue
    Enable-ScheduledTask -TaskName $keepalive | Out-Null
    Start-ScheduledTask -TaskName $keepalive
  }
  $after = [math]::Round((Get-Item $vhdx).Length / 1GB, 1)
  Log "compacted $vhdx $before -> $after GB; ${drive}: now $([math]::Round((Get-PSDrive $drive).Free / 1GB, 1)) GB free"
}

# 1. Disk space.
$basePath = $null
Get-ChildItem "Registry::HKEY_USERS\*\Software\Microsoft\Windows\CurrentVersion\Lxss\*" -ErrorAction SilentlyContinue |
  ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DistributionName -eq $Distro) { $basePath = $p.BasePath } }
$drives = @('C')
if ($basePath) { $drives += $basePath.Substring(0, 1).ToUpper() }
foreach ($d in ($drives | Select-Object -Unique)) {
  $free = [math]::Round((Get-PSDrive $d).Free / 1GB, 1)
  if ($free -lt $MinFreeGB) { Alert "Drive ${d}: has $free GB free (threshold $MinFreeGB GB). WSL ($Distro) dies when its disk cannot grow; free space or compact the vhdx (ci/runners/README.md)." }
}

# 2. Keepalive task.
$task = Get-ScheduledTask -TaskName $keepalive -ErrorAction SilentlyContinue
if (-not $task) { Log "ERROR task '$keepalive' missing; run install-wsl-keepalive.ps1"; exit 1 }
if ($task.State -eq 'Disabled') { Log "task '$keepalive' is disabled (maintenance?); skipping"; exit 0 }
if ($task.State -ne 'Running') {
  Log "keepalive task was $($task.State); starting it"
  Start-ScheduledTask -TaskName $keepalive
  Start-Sleep -Seconds 20
}

# 3. Probe the distro and the runner unit.
$probe = "wsl.exe -d $Distro -u root -- /usr/local/sbin/runner-health"
$r = AsUser $probe
$m = if ($r) { [regex]::Match($r.Text, 'RUNNER=(\S+)( restarted)?') } else { $null }
if ($m -and $m.Success -and $m.Groups[1].Value -ne 'missing') {
  if ($m.Groups[2].Success) { Log "runner unit was $($m.Groups[1].Value); restarted it" }
  if (Test-Path $state) { Remove-Item $state; Log 'distro healthy again' }
  if ($CompactBelowGB -gt 0 -and $basePath) { Compact-IfLow }
  exit 0
}
$why = Describe $r
$failures = 1 + [int](Get-Content $state -ErrorAction SilentlyContinue)
Set-Content $state $failures
Log "distro probe failed ($failures in a row): $why"
if ($failures -lt 2) { exit 0 }

# 4. Reset WSL.
Alert "WSL ($Distro) not answering after $failures checks; resetting WSL ($why)"
Stop-ScheduledTask -TaskName $keepalive -ErrorAction SilentlyContinue
# wsl --shutdown must run in the distro owner's session, hence SSH again.
$null = AsUser 'wsl.exe --shutdown'
Start-Sleep -Seconds 5
Restart-Service WSLService -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
Start-ScheduledTask -TaskName $keepalive
Start-Sleep -Seconds 30
$r = AsUser $probe
if ($r -and $r.Text -match 'RUNNER=active') { Remove-Item $state -ErrorAction SilentlyContinue; Log 'reset worked; runner active' }
else { Log "reset done, distro still not healthy: $(Describe $r)" }
