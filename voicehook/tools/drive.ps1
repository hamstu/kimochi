# Drives a game window for unattended tests: screenshot, click, keys.
#   drive.ps1 shot  <pid|name> <out.png>        screenshot of the window (client area)
#   drive.ps1 click <pid|name> <x> <y>          left click, coords in the 960-wide screenshot space
#   drive.ps1 key   <pid|name> <key> [count] [ms]  key presses: enter, space, esc, ctrl, up, down, left, right, pgdn, f, or a letter
#   drive.ps1 hold  <pid|name> <key> <ms>       hold a key (e.g. ctrl to skip)
#   drive.ps1 fit   <pid|name> [width]          move to top-left, resize (16:9 outer)
#   drive.ps1 wins  [name]                      list top-level windows with their pid and size
param([string]$cmd, [string]$target, [string]$a, [string]$b, [string]$c)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class VhDrive {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint c, uint t);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static List<IntPtr> Windows(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if ((pid == 0 || p == pid) && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static void Key(byte vk, bool down) {
    uint f = down ? 0u : 2u;
    if (vk >= 0x21 && vk <= 0x2E) f |= 1; // extended keys (arrows, pgup/pgdn, ins/del, home/end)
    keybd_event(vk, (byte)MapVirtualKey(vk, 0), f, UIntPtr.Zero);
  }
}
'@
[void][VhDrive]::SetProcessDPIAware()

function Find-Window([string]$t) {
    $pids = if ($t -match '^\d+$') { @([int]$t) } else { @(Get-Process -Name ($t -replace '\.exe$', '') -ErrorAction SilentlyContinue | ForEach-Object Id) }
    foreach ($p in $pids) {
        $best = $null; $area = 0
        foreach ($h in [VhDrive]::Windows([uint32]$p)) {
            $r = New-Object VhDrive+RECT; [void][VhDrive]::GetClientRect($h, [ref]$r)
            $s = ($r.R - $r.L) * ($r.B - $r.T)
            if ($s -gt $area) { $area = $s; $best = $h }
        }
        if ($best) { return $best }
    }
    throw "no visible window for $t"
}

function Client([IntPtr]$h) {
    $r = New-Object VhDrive+RECT; [void][VhDrive]::GetClientRect($h, [ref]$r)
    $p = New-Object VhDrive+POINT; [void][VhDrive]::ClientToScreen($h, [ref]$p)
    @{ X = $p.X; Y = $p.Y; W = $r.R - $r.L; H = $r.B - $r.T }
}

function Focus([IntPtr]$h) {
    # A tap of Alt lifts the foreground lock, so SetForegroundWindow works from a console.
    [VhDrive]::Key(0x12, $true); [VhDrive]::Key(0x12, $false)
    [void][VhDrive]::ShowWindow($h, 9); [void][VhDrive]::SetForegroundWindow($h); Start-Sleep -Milliseconds 200
}

$vk = @{ enter = 0x0D; space = 0x20; esc = 0x1B; ctrl = 0x11; up = 0x26; down = 0x28; left = 0x25; right = 0x27; pgdn = 0x22; pgup = 0x21; tab = 0x09; shift = 0x10; alt = 0x12; f1 = 0x70; f5 = 0x74 }
function VK([string]$k) { if ($vk.ContainsKey($k)) { [byte]$vk[$k] } elseif ($k.Length -eq 1) { [byte][char]$k.ToUpper() } else { throw "unknown key $k" } }

switch ($cmd) {
    'wins' {
        foreach ($h in [VhDrive]::Windows(0)) {
            $t = [VhDrive]::Title($h); if (-not $t) { continue }
            $p = 0; [void][VhDrive]::GetWindowThreadProcessId($h, [ref]$p)
            $w = Client $h
            if ($target -and $t -notmatch $target -and (Get-Process -Id $p).ProcessName -notmatch $target) { continue }
            '{0,7} {1,-24} {2}x{3} at {4},{5}  {6}' -f $p, (Get-Process -Id $p).ProcessName, $w.W, $w.H, $w.X, $w.Y, $t
        }
    }
    'shot' {
        $h = Find-Window $target; Focus $h; $w = Client $h
        $bmp = New-Object System.Drawing.Bitmap($w.W, $w.H)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($w.X, $w.Y, 0, 0, $bmp.Size)
        # Saved 960 px wide; `click` takes coordinates in that same space.
        $sw = 960; $sh = [int]($w.H * $sw / $w.W)
        $small = New-Object System.Drawing.Bitmap($bmp, $sw, $sh)
        $small.Save($a, [System.Drawing.Imaging.ImageFormat]::Png); $small.Dispose(); $g.Dispose(); $bmp.Dispose()
        "$($w.W)x$($w.H) saved as ${sw}x$sh -> $a"
    }
    'click' {
        $h = Find-Window $target; Focus $h; $w = Client $h
        $k = $w.W / 960.0; [void][VhDrive]::SetCursorPos($w.X + [int]([int]$a * $k), $w.Y + [int]([int]$b * $k)); Start-Sleep -Milliseconds 80
        [VhDrive]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
        [VhDrive]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    }
    'key' {
        $h = Find-Window $target; Focus $h
        $n = if ($b) { [int]$b } else { 1 }; $gap = if ($c) { [int]$c } else { 300 }
        for ($i = 0; $i -lt $n; $i++) {
            [VhDrive]::Key((VK $a), $true); Start-Sleep -Milliseconds 60; [VhDrive]::Key((VK $a), $false)
            if ($i -lt $n - 1) { Start-Sleep -Milliseconds $gap }
        }
    }
    'fit' {
        # Moves the window to the top-left at a given outer width (default 1800 px), keeping 16:9.
        $h = Find-Window $target; $ow = if ($a) { [int]$a } else { 1800 }
        [void][VhDrive]::MoveWindow($h, 0, 0, $ow, [int]($ow * 9 / 16) + 60, $true); $w = Client $h; "$($w.W)x$($w.H)"
    }
    'hold' {
        $h = Find-Window $target; Focus $h
        [VhDrive]::Key((VK $a), $true); Start-Sleep -Milliseconds ([int]$b); [VhDrive]::Key((VK $a), $false)
    }
    default { Get-Content $PSCommandPath -TotalCount 7 | Select-Object -Skip 1 }
}
