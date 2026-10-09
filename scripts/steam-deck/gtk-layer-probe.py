#!/usr/bin/env python3
"""Test the application's GTK layer lifecycle without WebKit or app dependencies.

Use the home-extracted GtkLayerShell typelib/library through GI_TYPELIB_PATH and
LD_LIBRARY_PATH. No system install or input grabs. May reproduce Gamescope crash.
"""
import json
import ctypes
import os
import time

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
from gi.repository import Gdk, GLib, Gtk, GtkLayerShell  # noqa: E402


def report(event, **fields):
    print(json.dumps({"event": event, "time": time.time(), **fields}), flush=True)


def main():
    if os.environ.get("KIMOCHI_ALLOW_LAYER_PROBE") != "1":
        raise RuntimeError("Intentional Gamescope lifecycle test requires KIMOCHI_ALLOW_LAYER_PROBE=1")
    Gtk.init([])
    if not GtkLayerShell.is_supported():
        raise RuntimeError("GTK layer-shell is not supported by this display")
    window = Gtk.Window()
    window.set_title("Kimochi passive GTK probe")
    window.set_decorated(False)
    window.set_accept_focus(False)
    window.set_focus_on_map(False)
    window.set_app_paintable(True)
    visual = window.get_screen().get_rgba_visual()
    if visual:
        window.set_visual(visual)
    GtkLayerShell.init_for_window(window)
    GtkLayerShell.set_namespace(window, "kimochi-gtk-probe")
    GtkLayerShell.set_layer(window, GtkLayerShell.Layer.OVERLAY)
    GtkLayerShell.set_keyboard_mode(window, GtkLayerShell.KeyboardMode.NONE)
    GtkLayerShell.set_exclusive_zone(window, 0)
    for edge in (GtkLayerShell.Edge.TOP, GtkLayerShell.Edge.RIGHT,
                 GtkLayerShell.Edge.BOTTOM, GtkLayerShell.Edge.LEFT):
        GtkLayerShell.set_anchor(window, edge, True)

    def draw(_widget, context):
        context.set_operator(cairo.OPERATOR_SOURCE)
        context.set_source_rgba(0, 0, 0, 0)
        context.paint()
        context.set_source_rgba(37 / 255, 99 / 255, 235 / 255, 1)
        context.rectangle(0, 0, 240, 48)
        context.fill()
        return True

    def realized(_widget):
        window.get_window().input_shape_combine_region(cairo.Region(), 0, 0)
        report("realized", pointer="empty-region", keyboard="none")

    window.connect("draw", draw)
    window.connect("realize", realized)
    window.connect("size-allocate", lambda _window, size:
                   report("size", width=size.width, height=size.height))
    cycles = int(os.environ.get("KIMOCHI_GTK_CYCLES", "1"))
    visible_seconds = int(os.environ.get("KIMOCHI_GTK_VISIBLE_SECONDS", "10"))
    if not 1 <= cycles <= 10 or not 1 <= visible_seconds <= 15:
        raise RuntimeError("Cycles must be 1..10 and visible seconds 1..15")
    completed_cycles = 0

    def show():
        window.show_all()
        window.queue_draw()
        report("shown", cycle=completed_cycles + 1)
        GLib.timeout_add(visible_seconds * 1000, hide)
        return False

    def after_hide():
        nonlocal completed_cycles
        completed_cycles += 1
        if completed_cycles < cycles:
            GLib.timeout_add(1000, show)
        else:
            GLib.timeout_add(3000, destroy)

    def destroy():
        report("destroy-requested")
        window.destroy()
        GLib.timeout_add(3000, Gtk.main_quit)
        return False

    def hide():
        report("hide-requested")
        if os.environ.get("KIMOCHI_GTK_PREUNMAP") == "1":
            capsule = ctypes.pythonapi.PyCapsule_GetPointer
            capsule.argtypes = [ctypes.py_object, ctypes.c_char_p]
            capsule.restype = ctypes.c_void_p
            native_window = window.get_window()
            native_window.freeze_updates()
            gdk = ctypes.CDLL("libgdk-3.so.0")
            gdk.gdk_wayland_window_get_wl_surface.argtypes = [ctypes.c_void_p]
            gdk.gdk_wayland_window_get_wl_surface.restype = ctypes.c_void_p
            surface = gdk.gdk_wayland_window_get_wl_surface(
                capsule(native_window.__gpointer__, None))
            wayland = ctypes.CDLL("libwayland-client.so.0")
            wayland.wl_proxy_get_version.argtypes = [ctypes.c_void_p]
            wayland.wl_proxy_get_version.restype = ctypes.c_uint
            wayland.wl_proxy_marshal_flags.argtypes = [
                ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p,
                ctypes.c_uint, ctypes.c_uint]
            wayland.wl_proxy_marshal_flags.restype = ctypes.c_void_p
            version = wayland.wl_proxy_get_version(surface)
            wayland.wl_proxy_marshal_flags(surface, 1, None, version, 0,
                                           ctypes.c_void_p(), ctypes.c_int(0), ctypes.c_int(0))
            wayland.wl_proxy_marshal_flags(surface, 6, None, version, 0)
            window.get_display().flush()
            report("preunmapped")

            def finish_hide():
                window.hide()
                native_window.thaw_updates()
                report("hidden")
                after_hide()
                return False

            GLib.timeout_add(250, finish_hide)
            return False
        window.hide()
        after_hide()
        return False

    show()
    Gtk.main()
    report("completed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report("failed", error=str(error))
        raise SystemExit(1)
