<#
Keep a WSL distro (and the GitHub runner's systemd service inside it) running after the
Windows host boots. WSL only runs while something holds a session open, so this registers a
hidden scheduled task that opens one at logon of the given user and never exits.

  powershell -ExecutionPolicy Bypass -File ci\runners\install-wsl-keepalive.ps1 -Distro Ubuntu
#>
param([string]$Distro = 'Ubuntu', [string]$User = $env:USERNAME)
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -u root -- sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
Register-ScheduledTask -TaskName "WSL keepalive ($Distro)" -Action $action -Trigger $trigger -Settings $settings -User $User -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName "WSL keepalive ($Distro)"
Write-Host "Registered and started 'WSL keepalive ($Distro)' (runs at logon of $User)."
