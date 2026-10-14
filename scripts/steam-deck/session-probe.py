#!/usr/bin/env python3
"""No-build, opt-in Steam-owned GTK app + independent XWayland overlay probe.

No OCR/WebKit, controller grabs, Steam signals, foreign-window/root writes or
system configuration. Touch/mouse routing only; Steam handles app switching.
"""
import argparse
import atexit
import ctypes
import json
import os
from pathlib import Path
import socket
import select
import signal
import sys
import struct
import stat
import subprocess
import threading
import time


def report(event, **fields):
    print(json.dumps({'event': event, 'at': time.time(), **fields}), flush=True)


def endpoint(role):
    return Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / f'kimochi-session-probe-{role}.sock'


def send(role, command):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(1)
        client.connect(str(endpoint(role)))
        client.sendall(command.encode())


def touch_guard(mode):
    """Only temporary touch-mode override, restored independently of GTK."""
    x = ctypes.CDLL('libX11.so.6')
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XInternAtom.restype = ctypes.c_ulong
    x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
    x.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    x.XFlush.argtypes = [ctypes.c_void_p]
    x.XFree.argtypes = [ctypes.c_void_p]
    display = x.XOpenDisplay(None)
    if not display: return
    root = x.XDefaultRootWindow(display)
    atom = x.XInternAtom(display, b'STEAM_TOUCH_CLICK_MODE', 1)
    if not atom: return
    def read():
        actual, count, after = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_ulong()
        fmt, data = ctypes.c_int(), ctypes.c_void_p()
        result = x.XGetWindowProperty(display, root, atom, 0, 1, 0, 6, ctypes.byref(actual), ctypes.byref(fmt), ctypes.byref(count), ctypes.byref(after), ctypes.byref(data))
        try:
            return ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] if result == 0 and count.value == 1 and fmt.value == 32 else None
        finally:
            if data: x.XFree(data)
    def write(value):
        data = ctypes.c_ulong(value)
        x.XChangeProperty(display, root, atom, 6, 32, 0, ctypes.byref(data), 1)
        x.XFlush(display)
    original = read()
    if original is None: return
    def stop(*_): raise SystemExit()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    report('touch-guard-started', original=original, mode=mode)
    try:
        while select.select([0], [], [], 2.5)[0]:
            data = os.read(0, 32)
            if not data or b'R' in data: break
            if b'A' in data:
                current = read()
                if current is not None and current != mode: original = current
                write(mode)
    finally:
        if read() == mode: write(original)
        report('touch-guard-restored', mode=original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=['app', 'overlay', 'touch-guard'])
    parser.add_argument('--seconds', type=int, default=300)
    parser.add_argument('--touch-mode', type=int, choices=[1, 4], default=1)
    parser.add_argument('--touch-watchdog', help='Existing Kimochi AppImage, used only for its independent touch-mode recovery helper')
    args = parser.parse_args()
    if os.environ.get('KIMOCHI_SESSION_PROBE') != '1':
        parser.error('opt in with KIMOCHI_SESSION_PROBE=1')
    if not 10 <= args.seconds <= 900:
        parser.error('--seconds must be 10..900')
    if args.role == 'touch-guard':
        touch_guard(args.touch_mode)
        return
    path = endpoint(args.role)
    if path.exists():
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError('refusing to replace an unowned/non-socket endpoint')
        try:
            send(args.role, 'present' if args.role == 'app' else 'show-interactive')
            return
        except ConnectionRefusedError:
            path.unlink()
    import cairo
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    gi.require_version('GdkX11', '3.0')
    from gi.repository import Gdk, GdkX11, GLib, Gtk
    Gtk.init([])
    window = Gtk.Window(title='Kimochi Session Probe' if args.role == 'app' else 'Kimochi Probe Overlay')
    if not isinstance(window.get_display(), GdkX11.X11Display):
        raise RuntimeError('probe requires X11 GTK backend')
    xlib = ctypes.CDLL('libX11.so.6')
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    xlib.XInternAtom.restype = ctypes.c_ulong
    xlib.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    xlib.XFlush.argtypes = [ctypes.c_void_p]
    display = xlib.XOpenDisplay(None)
    if not display:
        raise RuntimeError('XOpenDisplay failed')
    window.realize()
    xid = window.get_window().get_xid()

    def prop(name, value):
        data = ctypes.c_ulong(value)
        xlib.XChangeProperty(display, xid, xlib.XInternAtom(display, name.encode(), 0), 6, 32, 0, ctypes.byref(data), 1)
        xlib.XFlush(display)

    css = Gtk.CssProvider()
    css.load_from_data(b'button {font-size:24px;padding:18px;} label {font-size:24px;} .probe-overlay {background:transparent;} .probe-card {background:#142236;color:white;border-radius:16px;padding:24px;}')
    Gtk.StyleContext.add_provider_for_screen(window.get_screen(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
    content.get_style_context().add_class('probe-card')
    content.set_border_width(30)
    heading = Gtk.Label(label='Steam-managed Kimochi stub' if args.role == 'app' else 'External overlay stub')
    content.pack_start(heading, False, False, 0)
    status = Gtk.Label(label=f'{args.role} · PID {os.getpid()} · DISPLAY {os.environ.get("DISPLAY")}')
    content.pack_start(status, False, False, 0)

    def request(role, command):
        try:
            send(role, command)
            report('ipc-sent', role=role, command=command)
        except OSError as error:
            if args.role == 'app' and role == 'overlay':
                # Fresh user service: outside Steam's foreground app lifetime.
                launch = ['systemd-run', '--user', '--collect', '--unit=kimochi-session-overlay-probe', '--property=RuntimeMaxSec=90', '--setenv=DISPLAY=:0', '--setenv=GDK_BACKEND=x11', '--setenv=KIMOCHI_SESSION_PROBE=1', '/usr/bin/python3', str(Path(__file__).resolve()), 'overlay', '--seconds', '90']
                if args.touch_watchdog:
                    launch += ['--touch-watchdog', args.touch_watchdog]
                subprocess.run(launch, check=False)
                attempts = 0
                def retry():
                    nonlocal attempts
                    attempts += 1
                    try:
                        send(role, command)
                        status.set_text('Overlay opened; Cancel or its timer dismisses it.')
                        return False
                    except OSError as failure:
                        if attempts < 20:
                            return True
                        status.set_text(str(failure))
                        return False
                GLib.timeout_add(100, retry)
            else:
                status.set_text(str(error))
                report('ipc-failed', role=role, command=command, error=str(error))

    touch = None
    dismiss_timer = None

    def release_touch():
        nonlocal touch
        if touch is not None:
            try:
                touch.stdin.close()
            except OSError:
                pass
            child = touch
            touch = None
            threading.Thread(target=child.wait, daemon=True).start()

    def hide_overlay():
        if args.role == 'overlay':
            release_touch()
            prop('_NET_WM_WINDOW_OPACITY', 0)
            prop('STEAM_INPUT_FOCUS', 0)
            prop('STEAM_OVERLAY', 0)
            window.hide()
            report('overlay-hidden')

    buttons = []

    def button(label, action):
        item = Gtk.Button(label=label)
        buttons.append(item)
        def activate(*_):
            report('button-clicked', label=label)
            action()
        item.connect('clicked', activate)
        content.pack_start(item, False, False, 0)
        return item

    if args.role == 'app':
        window.set_default_size(1280, 800)
        window.add(content)
        appid = os.environ.get('SteamAppId', '')
        if appid.isdigit() and int(appid) > 0:
            prop('STEAM_GAME', int(appid))
        interactive = Gtk.CheckButton(label='Interactive overlay (touch buttons, auto-dismiss after 20 seconds)')
        interactive.set_active(True)
        content.pack_start(interactive, False, False, 0)
        button('Show external overlay', lambda: request('overlay', 'show-interactive' if interactive.get_active() else 'show'))
        content.pack_start(Gtk.Label(label='Use Steam → Switch game to switch apps.\nBoth processes stay alive independently.'), False, False, 0)
        button('Close probe app', Gtk.main_quit)
        window.show_all()
    else:
        window.get_style_context().add_class('probe-overlay')
        window.set_decorated(False)
        window.set_skip_taskbar_hint(True)
        window.set_skip_pager_hint(True)
        window.set_accept_focus(False)
        window.set_focus_on_map(False)
        window.set_app_paintable(True)
        visual = window.get_screen().get_rgba_visual()
        if visual is None:
            raise RuntimeError('RGBA visual unavailable')
        window.unrealize()
        window.set_visual(visual)
        window.realize()
        xid = window.get_window().get_xid()
        window.set_default_size(1280, 800)
        window.move(0, 0)
        align = Gtk.Alignment.new(.5, .5, 0, 0)
        align.add(content)
        window.add(align)
        prop('GAMESCOPE_EXTERNAL_OVERLAY', 1)
        prop('STEAM_OVERLAY', 0)
        prop('STEAM_INPUT_FOCUS', 0)

        def draw(_widget, context):
            context.set_operator(cairo.OPERATOR_SOURCE)
            context.set_source_rgba(0, 0, 0, 0)
            context.paint()
            context.set_operator(cairo.OPERATOR_OVER)
            return False
        window.connect('draw', draw)

        def shape(*_):
            rect = content.get_allocation()
            region = cairo.Region(cairo.RectangleInt(rect.x, rect.y, rect.width, rect.height))
            window.get_window().input_shape_combine_region(region, 0, 0)
            targets = []
            for item in buttons:
                xy = item.translate_coordinates(window, 0, 0)
                size = item.get_allocation()
                targets.append({'label': item.get_label(), 'xy': xy, 'width': size.width, 'height': size.height})
            report('input-shape', rect=[rect.x, rect.y, rect.width, rect.height], buttons=targets, scale=window.get_scale_factor())
        content.connect('size-allocate', shape)
        def back():
            hide_overlay()
            request('app', 'present')
        button('Request Kimochi window (experimental)', back)
        button('Cancel overlay', hide_overlay)
        window.show_all()
        hide_overlay()

    server = socket.socket(socket.AF_UNIX)
    server.bind(str(endpoint(args.role)))
    os.chmod(endpoint(args.role), 0o600)
    server.listen(4)
    atexit.register(lambda: endpoint(args.role).unlink(missing_ok=True))

    def dispatch(command):
        nonlocal touch, dismiss_timer
        report('ipc-received', command=command)
        if args.role == 'app' and command == 'present':
            window.show_all()
            window.present()
        elif args.role == 'overlay' and command in ('show', 'show-interactive'):
            interactive = command == 'show-interactive'
            release_touch()
            window.set_accept_focus(interactive)
            prop('STEAM_OVERLAY', int(interactive))
            prop('STEAM_INPUT_FOCUS', int(interactive))
            prop('_NET_WM_WINDOW_OPACITY', 0xffffffff)
            window.show_all()
            if interactive:
                window.present()
                env = dict(os.environ, GDK_BACKEND='x11', XDG_CURRENT_DESKTOP='gamescope', KIMOCHI_GAMESCOPE_OVERLAY='x11')
                if args.touch_mode == 4 and args.touch_watchdog:
                    guard = [args.touch_watchdog, '--gamescope-input-watchdog', 'touch']
                else:
                    guard = [sys.executable, str(Path(__file__).resolve()), 'touch-guard', '--touch-mode', str(args.touch_mode)]
                touch = subprocess.Popen(guard, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, start_new_session=True)
            if dismiss_timer is not None:
                GLib.source_remove(dismiss_timer)
            remaining = 20
            def countdown():
                nonlocal remaining, dismiss_timer
                remaining -= 1
                status.set_text(f'Overlay closes in {remaining}s · touch buttons' if interactive else f'Passive visual probe · closes in {remaining}s')
                if remaining <= 0:
                    dismiss_timer = None
                    hide_overlay()
                    return False
                return True
            countdown()
            dismiss_timer = GLib.timeout_add_seconds(1, countdown)
            report('overlay-shown', interactive=interactive)
        elif args.role == 'overlay' and command == 'hide':
            hide_overlay()
        elif command == 'quit':
            Gtk.main_quit()
        return False

    def listen():
        while True:
            try:
                client, _ = server.accept()
                with client:
                    _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != os.getuid():
                        continue
                    client.settimeout(1)
                    command = client.recv(64).decode('ascii')
                    GLib.idle_add(dispatch, command)
            except OSError:
                return
    threading.Thread(target=listen, daemon=True).start()
    def touch_heartbeat():
        if touch is not None:
            try:
                touch.stdin.write(b'A')
                touch.stdin.flush()
            except (OSError, ValueError):
                hide_overlay()
        return True
    GLib.timeout_add(500, touch_heartbeat)
    window.connect('delete-event', lambda *_: (Gtk.main_quit(), True)[1])
    window.add_events(Gdk.EventMask.TOUCH_MASK | Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK)
    def pointer(_window, event):
        report('pointer-event', kind=str(event.type), x=event.x, y=event.y)
        return False
    window.connect('button-press-event', pointer)
    window.connect('button-release-event', pointer)
    window.connect('touch-event', pointer)
    window.connect('focus-in-event' , lambda *_: report('focus-in'))
    window.connect('focus-out-event', lambda *_: report('focus-out'))
    GLib.timeout_add_seconds(args.seconds, lambda: (Gtk.main_quit(), False)[1])
    report('started', role=args.role, pid=os.getpid(), xid=xid, display=os.environ.get('DISPLAY'), steamAppId=os.environ.get('SteamAppId'), seconds=args.seconds)
    Gtk.main()
    hide_overlay()
    if args.role == 'app':
        try:
            send('overlay', 'hide')
        except OSError:
            pass
    server.close()
    report('exited', role=args.role)


if __name__ == '__main__':
    main()
