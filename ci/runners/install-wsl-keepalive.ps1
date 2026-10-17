<#
Keep a WSL distro (and the GitHub runner's systemd service inside it) running from boot, with
nobody logged on. WSL only runs while something holds a session open and only inside a user's
session, so this registers a startup task, run as SYSTEM, that opens an SSH session to this
machine's own sshd as the given user (sshd starts at boot) and holds `sleep infinity` inside
the distro through it. A dedicated key, readable by SYSTEM only, authorises that session.

It also registers "WSL watchdog (<Distro>)", run as SYSTEM at startup and every 5 minutes
(wsl-watchdog.ps1, copied beside the key): it restarts the keepalive when it has exited, restarts
the runner unit when it is inactive, resets WSL when the distro stops answering, and warns when C:
or the distro's drive runs low on space (and, with -CompactBelowGB, compacts the distro's vhdx
when that drive gets low and the runner is idle). Inside the distro it installs /usr/local/sbin/runner-health
(the watchdog's probe) and a drop-in giving the runner unit Restart=always, and it turns off WSL's
idle shutdown in the user's .wslconfig.

  powershell -ExecutionPolicy Bypass -File ci\runners\install-wsl-keepalive.ps1 -Distro Ubuntu -User hamst -SshPort 2222

Run elevated. The user must be a local administrator (the key is added to
administrators_authorized_keys), and OpenSSH Server must already be installed and running.
#>
param([string]$Distro = 'Ubuntu', [string]$User = $env:USERNAME, [int]$SshPort = 22, [int]$MinFreeGB = 10, [int]$CompactBelowGB = 0)
$ErrorActionPreference = 'Stop'
$dir = 'C:\ProgramData\wsl-keepalive'
$key = "$dir\id_ed25519"
$ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe"
$keygen = "$env:SystemRoot\System32\OpenSSH\ssh-keygen.exe"
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'OpenSSH Server (sshd) is not installed.' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
if (-not (Test-Path $key)) {
  & $keygen -q -t ed25519 -N '""' -C "wsl-keepalive@$env:COMPUTERNAME" -f $key
  if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed' }
}
# The ssh client refuses a key any account but its own (here SYSTEM) can read, so the key is
# owned by SYSTEM and readable by SYSTEM alone; the directory stays manageable by Administrators.
icacls $dir /inheritance:r /grant 'SYSTEM:(OI)(CI)F' /grant 'Administrators:(OI)(CI)F' | Out-Null
icacls $key /setowner 'NT AUTHORITY\SYSTEM' | Out-Null
icacls $key /inheritance:r /grant:r 'SYSTEM:F' | Out-Null
$pub = (Get-Content "$key.pub").Trim()
$auth = 'C:\ProgramData\ssh\administrators_authorized_keys'
if (-not (Test-Path $auth) -or -not ((Get-Content $auth) -contains $pub)) { Add-Content -Path $auth -Value $pub }
icacls $auth /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null

$sshArgs = "-i `"$key`" -o StrictHostKeyChecking=no -o UserKnownHostsFile=`"$dir\known_hosts`" -o ServerAliveInterval=30 -o BatchMode=yes -p $SshPort $User@127.0.0.1 `"wsl.exe -d $Distro -u root -- sleep infinity`""
# Through cmd so ssh's stderr lands in a log for diagnosis.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$ssh`" $sshArgs 2>> `"$dir\ssh.log`"`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$name = "WSL keepalive ($Distro)"
# Unregistering leaves a running instance's ssh behind, holding a second session; end it by PID.
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='ssh.exe' or Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*$key*" -and $_.CommandLine -like '*sleep infinity*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

# WSL 2 shuts an idle VM / distro down; a runner waiting for jobs looks idle.
$cfg = "C:\Users\$User\.wslconfig"
$lines = if (Test-Path $cfg) { @(Get-Content $cfg) } else { @() }
function Set-Ini([string]$section, [string]$key, [string]$value) {
  $script:lines = @($script:lines | Where-Object { $_ -notmatch "^\s*$key\s*=" })
  $i = [array]::IndexOf(@($script:lines | ForEach-Object { $_.Trim().ToLower() }), "[$section]")
  if ($i -lt 0) { $script:lines += @('', "[$section]", "$key=$value") }
  else { $script:lines = @($script:lines[0..$i]) + "$key=$value" + @($script:lines | Select-Object -Skip ($i + 1)) }
}
Set-Ini 'wsl2' 'vmIdleTimeout' '-1'
Set-Ini 'general' 'instanceIdleTimeout' '-1'
Set-Content -Path $cfg -Value $script:lines -Encoding ascii

# Inside the distro: the watchdog's probe, and Restart=always for the runner unit.
$health = @'
#!/bin/sh
# Prints RUNNER=<state> for the GitHub runner unit and restarts it unless active (wsl-watchdog.ps1).
u=$(systemctl list-units --all --plain --no-legend 'actions.runner.*' | awk '{print $1}' | head -n1)
[ -n "$u" ] || { echo RUNNER=missing; exit 1; }
s=$(systemctl is-active "$u")
case "$s" in
  active|activating|reloading) echo "RUNNER=$s" ;;
  *) systemctl restart "$u"; echo "RUNNER=$s restarted" ;;
esac
'@ -replace "`r", ''
$dropin = "[Unit]`nStartLimitIntervalSec=0`n[Service]`nRestart=always`nRestartSec=15`n"
$b64 = { param($t) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }
$sh = "echo $(& $b64 $health) | base64 -d > /usr/local/sbin/runner-health && chmod 755 /usr/local/sbin/runner-health && " +
  "for u in `$(systemctl list-unit-files --plain --no-legend 'actions.runner.*' | awk '{print `$1}'); do " +
  "mkdir -p /etc/systemd/system/`$u.d && echo $(& $b64 $dropin) | base64 -d > /etc/systemd/system/`$u.d/restart.conf; done && systemctl daemon-reload"
& wsl.exe -d $Distro -u root --exec sh -c $sh
if ($LASTEXITCODE -ne 0) { Write-Warning "Could not install runner-health / the restart drop-in inside $Distro." }

# Watchdog: at startup and every 5 minutes.
Copy-Item -Force "$PSScriptRoot\wsl-watchdog.ps1" "$dir\wsl-watchdog.ps1"
$wname = "WSL watchdog ($Distro)"
$waction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dir\wsl-watchdog.ps1`" -Distro $Distro -User $User -SshPort $SshPort -MinFreeGB $MinFreeGB -CompactBelowGB $CompactBelowGB"
$wboot = New-ScheduledTaskTrigger -AtStartup
$wboot.Delay = 'PT3M'
$wrepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$wsettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName $wname -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $wname -Action $waction -Trigger $wboot, $wrepeat -Settings $wsettings -Principal $principal | Out-Null

Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 8
$running = (& wsl.exe --list --running 2>$null | ForEach-Object { $_ -replace "`0", '' }) -join ' '
Write-Host "Registered '$name' (at startup) and '$wname' (at startup + every 5 min), both as SYSTEM. Running distros: $running"
Write-Host "Watchdog log: $dir\watchdog.log"
