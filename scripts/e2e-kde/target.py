#!/usr/bin/python3
"""A game-like window with Japanese dialogue: target.py [W H] [title].
Native Wayland, or XWayland with GDK_BACKEND=x11. Prints one JSON line per layout with each
line's rectangle relative to the window's client area, for the harness's assertions, and a
`click N` line for each button press it receives (whether a click reached the game)."""
import json, sys, gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib
W, H = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (960, 540)
title = sys.argv[3] if len(sys.argv) > 3 else 'Rig Game'
LINES = ['今日はとても良い天気ですね。', '一緒に図書館へ行きませんか？']
css = b"""
window { background: #1d2333; }
.line { color: #ffffff; font-family: 'Noto Sans CJK JP'; font-size: 40px; }
.box { background: rgba(0,0,0,0.6); border: 3px solid #e0c080; border-radius: 12px; padding: 24px; }
"""
provider = Gtk.CssProvider(); provider.load_from_data(css)
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
window = Gtk.Window(title=title); window.set_default_size(W, H)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL); box.set_valign(Gtk.Align.END); box.set_margin_bottom(40)
box.set_margin_start(40); box.set_margin_end(40); box.get_style_context().add_class('box')
labels = []
for text in LINES:
    label = Gtk.Label(label=text, xalign=0); label.get_style_context().add_class('line')
    box.pack_start(label, False, False, 6); labels.append(label)
last = [None]
def report(*_):
    lines = []
    for label in labels:
        layout = label.get_layout(); ink, logical = layout.get_pixel_extents()
        # Layout offsets are in the parent GdkWindow's coordinates (the allocation included).
        ox, oy = label.get_layout_offsets(); a = label.get_allocation()
        x, y = label.translate_coordinates(window, ox - a.x + ink.x, oy - a.y + ink.y)
        lines.append({'text': label.get_text(), 'x': x, 'y': y, 'width': ink.width, 'height': ink.height})
    out = json.dumps({'title': title, 'client': [window.get_allocated_width(), window.get_allocated_height()], 'lines': lines}, ensure_ascii=False)
    if out != last[0]:
        last[0] = out; print(out, flush=True)
window.connect('size-allocate', lambda *a: GLib.idle_add(report))
clicks = [0]
def clicked(_, event):
    clicks[0] += 1; print(f'click {clicks[0]} {round(event.x)} {round(event.y)}', flush=True)
window.add_events(Gdk.EventMask.BUTTON_PRESS_MASK); window.connect('button-press-event', clicked)
window.add(box); window.connect('destroy', Gtk.main_quit); window.show_all(); Gtk.main()
