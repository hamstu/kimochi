# CPU time (ms) of the processes called $Name and every descendant (WebView2, OCR workers):
# "<pid> <name>[:<--type>] <ms>" per line, the type being a WebView2 process's role.
param([string]$Name)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine
$set = @(Get-Process $Name -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (-not $set.Count) { exit 0 }
$grow = $true
while ($grow) {
  $grow = $false
  foreach ($p in $all) {
    if ($set -contains $p.ParentProcessId -and -not ($set -contains $p.ProcessId)) { $set += $p.ProcessId; $grow = $true }
  }
}
foreach ($id in $set) {
  $pr = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($pr) {
    $cmd = ($all | Where-Object { $_.ProcessId -eq $id }).CommandLine
    $type = ""
    if ($cmd -match "--type=([a-z-]+)") { $type = ":" + $Matches[1] }
    "$id $($pr.ProcessName)$type $([math]::Round($pr.TotalProcessorTime.TotalMilliseconds))"
  }
}
