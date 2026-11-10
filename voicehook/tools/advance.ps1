# Advances a VN by clicking (or a key), and logs each advance as a text line in lines.jsonl,
# the shape vh-classify reads ({"uid","text","ts","appeared"}): the line appears on the click,
# which stands in for the text hook's timing in unattended tests.
#   advance.ps1 <pid|name> <lines.jsonl> <count> [x y | key] [-Gap ms]
param([string]$Target, [string]$Out, [int]$Count, [string]$A = '480', [string]$B = '250', [int]$Gap = 4500)
$drive = Join-Path $PSScriptRoot 'drive.ps1'
for ($i = 0; $i -lt $Count; $i++) {
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($A -match '^\d+$') { & $drive click $Target $A $B } else { & $drive key $Target $A }
    $uid = 'click{0:d3}' -f $i
    ('{{"uid":"{0}","text":"(advance {1})","ts":{2},"appeared":{2}}}' -f $uid, $i, $t) | Add-Content -Encoding utf8 $Out
    Start-Sleep -Milliseconds $Gap
}
