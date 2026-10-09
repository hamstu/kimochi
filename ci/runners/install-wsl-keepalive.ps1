<#
Keep a WSL distro (and the GitHub runner's systemd service inside it) running from boot, with
nobody logged on. WSL only runs while something holds a session open and only inside a user's
session, so this registers a startup task, run as SYSTEM, that opens an SSH session to this
machine's own sshd as the given user (sshd starts at boot) and holds `sleep infinity` inside
the distro through it. A dedicated key, readable by SYSTEM only, authorises that session.

  powershell -ExecutionPolicy Bypass -File ci\runners\install-wsl-keepalive.ps1 -Distro Ubuntu -User hamst -SshPort 2222

Run elevated. The user must be a local administrator (the key is added to
administrators_authorized_keys), and OpenSSH Server must already be installed and running.
#>
param([string]$Distro = 'Ubuntu', [string]$User = $env:USERNAME, [int]$SshPort = 22)
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
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 8
$running = (& wsl.exe --list --running 2>$null | ForEach-Object { $_ -replace "`0", '' }) -join ' '
Write-Host "Registered '$name' (at startup, as SYSTEM). Task: $((Get-ScheduledTask $name).State). Running distros: $running"
