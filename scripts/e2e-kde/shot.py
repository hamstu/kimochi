#!/usr/bin/python3
"""Screenshot the whole KWin workspace: shot.py out.png [--cursor] [--pixel X Y ...] [--find R G B X Y W H]
--pixel prints a pixel's RGB; --find prints the centre of the area densest in that colour within that rectangle (device
pixels), or "find none"."""
import os, sys, threading, dbus
import gi; gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf, GLib
out = sys.argv[1]
r, w = os.pipe()
chunks = []
want = [None]
def reader():
    with os.fdopen(r, 'rb') as f:
        buf = b''
        while want[0] is None or len(buf) < want[0]:
            c = f.read(65536)
            if not c: break
            buf += c
        chunks.append(buf)
t = threading.Thread(target=reader, daemon=True); t.start()
bus = dbus.SessionBus()
api = dbus.Interface(bus.get_object('org.kde.KWin', '/org/kde/KWin/ScreenShot2'), 'org.kde.KWin.ScreenShot2')
try:
    meta = api.CaptureWorkspace({'include-cursor': '--cursor' in sys.argv, 'native-resolution': True}, dbus.types.UnixFd(w))
    want[0] = int(meta['stride']) * int(meta['height'])
finally:
    os.close(w)
t.join(10)
data = chunks[0] if chunks else b''
if len(data) < want[0]: sys.exit(f'short read: {len(data)} of {want[0]} bytes')
width, height, stride = int(meta['width']), int(meta['height']), int(meta['stride'])
# QImage::Format_ARGB32_Premultiplied / RGB32 are BGRA in memory on little endian.
px = bytearray(width * height * 4)
for y in range(height):
    row = data[y*stride:y*stride+width*4]
    px[y*width*4:(y+1)*width*4] = row
px[0::4], px[2::4] = px[2::4], px[0::4]
GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(bytes(px)), GdkPixbuf.Colorspace.RGB, True, 8, width, height, width*4).savev(out, 'png', [], [])
args = sys.argv[2:]
for i, a in enumerate(args):
    if a == '--pixel':
        x, y = int(args[i + 1]), int(args[i + 2])
        o = (y * width + x) * 4
        print('pixel', x, y, px[o], px[o + 1], px[o + 2])
    if a == '--find':
        # The centre of the 24x24 cell densest in that colour: a window's own picker card shows a
        # large block of its background, while a screen's preview shows it small.
        r, g, b, fx, fy, fw, fh = (int(v) for v in args[i + 1:i + 8])
        cells = {}
        for y in range(max(0, fy), min(height, fy + fh), 2):
            for x in range(max(0, fx), min(width, fx + fw), 2):
                o = (y * width + x) * 4
                if abs(px[o] - r) + abs(px[o + 1] - g) + abs(px[o + 2] - b) < 12:
                    key = (x // 24, y // 24); cells[key] = cells.get(key, 0) + 1
        best = max(cells.items(), key=lambda kv: (kv[1], kv[0][1])) if cells else None
        print('find', (best[0][0] * 24 + 12, best[0][1] * 24 + 12) if best else 'none', best[1] if best else 0)
print(out, width, height)
