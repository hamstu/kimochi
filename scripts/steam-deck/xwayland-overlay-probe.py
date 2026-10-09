#!/usr/bin/env python3
"""Bounded passive Gamescope XWayland overlay; touches only its own X window.

Requires existing GTK3/PyGObject/Cairo and libX11. No Steam property changes,
input grabs, layer-shell, WebKit, persistent configuration, or saved pixels.
"""
import ctypes
import json
import os
import time

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkX11", "3.0")
from gi.repository import Gdk, GdkX11, GLib, Gtk  # noqa: E402


def report(event, **fields):
    print(json.dumps({"event": event, "time": time.time(), **fields}), flush=True)


def main():
    if os.environ.get("KIMOCHI_ALLOW_XWAYLAND_PROBE") != "1":
        raise RuntimeError("Requires KIMOCHI_ALLOW_XWAYLAND_PROBE=1")
    cycles = int(os.environ.get("KIMOCHI_XWAYLAND_CYCLES", "3"))
    duration = int(os.environ.get("KIMOCHI_XWAYLAND_VISIBLE_SECONDS", "2"))
    if not 1 <= cycles <= 10 or not 1 <= duration <= 25:
        raise RuntimeError("Cycles must be 1..10; visible seconds 1..25")
    Gtk.init([])
    window = Gtk.Window()
    if not isinstance(window.get_display(), GdkX11.X11Display):
        raise RuntimeError("Requires GDK_BACKEND=x11 and a working DISPLAY")
    xlib = ctypes.CDLL("libX11.so.6")
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    xlib.XInternAtom.restype = ctypes.c_ulong
    xlib.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                                  ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int,
                                  ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    xlib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = xlib.XOpenDisplay(None)
    if not display:
        raise RuntimeError("XOpenDisplay returned NULL")
    window.set_title("Kimochi passive XWayland probe")
    window.set_decorated(False)
    window.set_accept_focus(False)
    window.set_focus_on_map(False)
    window.set_skip_taskbar_hint(True)
    window.set_skip_pager_hint(True)
    window.set_app_paintable(True)
    visual = window.get_screen().get_rgba_visual()
    if visual is None:
        raise RuntimeError("No RGBA visual")
    window.set_visual(visual)
    window.set_default_size(1280, 800)
    window.move(0, 0)
    completed = 0
    webkit = os.environ.get("KIMOCHI_XWAYLAND_WEBKIT") == "1"
    destroy_mapped = os.environ.get("KIMOCHI_XWAYLAND_DESTROY_MAPPED") == "1"
    if webkit:
        gi.require_version("WebKit2", "4.1")
        from gi.repository import WebKit2
        view = WebKit2.WebView()
        transparent = Gdk.RGBA()
        transparent.parse("rgba(0,0,0,0)")
        view.set_background_color(transparent)
        window.add(view)

        def loaded(_view, event):
            if event == WebKit2.LoadEvent.FINISHED:
                report("webkit-loaded", uri=view.get_uri())

        view.connect("load-changed", loaded)
        view.load_html("""<!doctype html><style>
            html,body{margin:0;background:transparent}
            #marker{position:absolute;left:0;top:0;width:240px;height:48px;
            background:rgb(37,99,235);color:white;font:20px sans-serif}
            </style><div id="marker">日本語 WebKit probe</div>""", "about:blank")

    def realized(_widget):
        native = window.get_window()
        xid = GdkX11.X11Window.get_xid(native)
        atom = xlib.XInternAtom(display, b"GAMESCOPE_EXTERNAL_OVERLAY", 0)
        cardinal = xlib.XInternAtom(display, b"CARDINAL", 0)
        value = ctypes.c_ulong(1)
        xlib.XChangeProperty(display, xid, atom, cardinal, 32, 0,
                            ctypes.byref(value), 1)
        xlib.XSync(display, 0)
        native.input_shape_combine_region(cairo.Region(), 0, 0)
        report("realized", xid=xid, pointer="empty-region", keyboard="no-focus",
               property="GAMESCOPE_EXTERNAL_OVERLAY=1")

    def draw(_widget, context):
        context.set_operator(cairo.OPERATOR_SOURCE)
        context.set_source_rgba(0, 0, 0, 0)
        context.paint()
        context.set_source_rgba(37 / 255, 99 / 255, 235 / 255, 1)
        context.rectangle(0, 0, 240, 48)
        context.fill()
        return True

    def show():
        window.show_all()
        window.queue_draw()
        report("shown", cycle=completed + 1)
        GLib.timeout_add(700, measure)
        GLib.timeout_add(duration * 1000, destroy if destroy_mapped else hide)
        return False

    def measure():
        # Read our own drawable into memory; no screenshot or frame file.
        if window.get_visible():
            pixels = Gdk.pixbuf_get_from_window(window.get_window(), 0, 0, 240, 48)
            if pixels:
                data = pixels.get_pixels()
                channels = pixels.get_n_channels()
                stride = pixels.get_rowstride()
                count = sum(data[y * stride + x * channels:
                                 y * stride + x * channels + 3] == b"\x25\x63\xeb"
                            for y in range(pixels.get_height())
                            for x in range(pixels.get_width()))
                report("drawable-marker", markerPixels=count, pixelsSaved=False)
        return False

    def hide():
        nonlocal completed
        window.hide()
        window.get_display().sync()
        completed += 1
        report("hidden", cycle=completed)
        GLib.timeout_add(500, show if completed < cycles else destroy)
        return False

    def destroy():
        report("destroy-requested", mapped=window.get_visible())
        window.destroy()
        window.get_display().sync()
        report("destroyed")
        GLib.timeout_add(500, Gtk.main_quit)
        return False

    window.connect("realize", realized)
    if not webkit:
        window.connect("draw", draw)
    window.connect("size-allocate", lambda _widget, size:
                   report("size", width=size.width, height=size.height))
    show()
    Gtk.main()
    xlib.XCloseDisplay(display)
    report("completed", cycles=completed)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report("failed", error=str(error))
        raise SystemExit(1)
