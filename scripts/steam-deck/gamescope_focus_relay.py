"""Experimental ICCCM focus handoff for Wine under Gamescope.

No focus selection, root writes, grabs, Steam signals, or Wine injection. Sends
WM_TAKE_FOCUS once per validated ownership transition, only to Wine windows
which advertise it. All Xlib calls must run on the same thread as construction.
"""
import ctypes as c
import os
import re
import select
import time


class Property(c.Structure):
    _fields_ = [('type', c.c_int), ('serial', c.c_ulong), ('send', c.c_int),
                ('display', c.c_void_p), ('window', c.c_ulong),
                ('atom', c.c_ulong), ('time', c.c_ulong), ('state', c.c_int)]


class Client(c.Structure):
    _fields_ = [('type', c.c_int), ('serial', c.c_ulong), ('send', c.c_int),
                ('display', c.c_void_p), ('window', c.c_ulong),
                ('message', c.c_ulong), ('format', c.c_int),
                ('data', c.c_long * 5)]


class Event(c.Union):
    _fields_ = [('property', Property), ('client', Client), ('pad', c.c_long * 24)]


def eligible_target(app, graphics, keyboard, mouse, window_app, wine, protocol, excluded):
    """Fail closed on incomplete metadata; never select or activate another app."""
    return (bool(app) and app not in excluded and app == graphics == window_app
            and bool(re.fullmatch(r':[0-9]+', keyboard or ''))
            and keyboard == mouse and wine and protocol)


class Transition:
    def __init__(self):
        self.last = None

    def changed(self, target):
        if target == self.last:
            return False
        self.last = target
        return target is not None


class FocusRelay:
    def __init__(self, report, excluded=(0, 769, 2999444207)):
        self.report = report
        self.excluded = set(excluded)
        self.transition = Transition()
        self.x = c.CDLL('libX11.so.6')
        P, U, I = c.c_void_p, c.c_ulong, c.c_int
        signatures = [
            ('XOpenDisplay', [c.c_char_p], P),
            ('XDefaultRootWindow', [P], U),
            ('XInternAtom', [P, c.c_char_p, I], U),
            ('XGetWindowProperty', [P,U,U,c.c_long,c.c_long,I,U,c.POINTER(U),c.POINTER(I),c.POINTER(U),c.POINTER(U),c.POINTER(P)], I),
            ('XFree', [P], I),
            ('XGetInputFocus', [P,c.POINTER(U),c.POINTER(I)], I),
            ('XQueryTree', [P,U,c.POINTER(U),c.POINTER(U),c.POINTER(c.POINTER(U)),c.POINTER(c.c_uint)], I),
            ('XCreateSimpleWindow', [P,U,I,I,c.c_uint,c.c_uint,c.c_uint,U,U], U),
            ('XSelectInput', [P,U,c.c_long], I),
            ('XChangeProperty', [P,U,U,U,I,I,P,I], I),
            ('XPending', [P], I),
            ('XConnectionNumber', [P], I),
            ('XNextEvent', [P,c.POINTER(Event)], I),
            ('XSendEvent', [P,U,I,c.c_long,c.POINTER(Event)], I),
            ('XFlush', [P], I),
            ('XCloseDisplay', [P], I),
            ('XSetErrorHandler', [P], P),
        ]
        for name, args, result in signatures:
            function = getattr(self.x, name)
            function.argtypes, function.restype = args, result
        # A target can close between querying and sending. This separate Xlib
        # connection must not terminate the GTK process on a normal BadWindow.
        self.error_handler = c.CFUNCTYPE(I, P, P)(lambda *_: 0)
        self.old_error_handler = self.x.XSetErrorHandler(self.error_handler)
        self.connections = {}
        self.helpers = {}
        self.atoms = {}
        try:
            self.root_display = self.connection(':0')
            self.root = self.x.XDefaultRootWindow(self.root_display)
        except Exception:
            self.close()
            raise

    def connection(self, name):
        if name not in self.connections:
            display = self.x.XOpenDisplay(name.encode())
            if not display:
                raise RuntimeError('XOpenDisplay failed for ' + name)
            self.connections[name] = display
        return self.connections[name]

    def atom(self, display, name):
        key = (display, name)
        if key not in self.atoms:
            self.atoms[key] = self.x.XInternAtom(display, name.encode(), 0)
        return self.atoms[key]

    def values(self, display, window, name):
        actual, count, after = c.c_ulong(), c.c_ulong(), c.c_ulong()
        fmt, data = c.c_int(), c.c_void_p()
        result = self.x.XGetWindowProperty(display, window, self.atom(display,name),
                    0, 64, 0, 0, c.byref(actual), c.byref(fmt), c.byref(count),
                    c.byref(after), c.byref(data))
        try:
            if result or fmt.value != 32 or not data:
                return []
            return list(c.cast(data, c.POINTER(c.c_ulong))[:count.value])
        finally:
            if data: self.x.XFree(data)

    def scalar(self, display, window, name):
        values = self.values(display, window, name)
        return values[0] if values else None

    def display_name(self, name):
        values = self.values(self.root_display, self.root, name)
        raw = b''.join((value & 0xffffffff).to_bytes(4, 'little') for value in values)
        return raw.split(b'\0',1)[0].decode('ascii',errors='replace')

    def target(self):
        d, root = self.root_display, self.root
        app = self.scalar(d,root,'GAMESCOPE_FOCUSED_APP')
        graphics = self.scalar(d,root,'GAMESCOPE_FOCUSED_APP_GFX')
        keyboard = self.display_name('GAMESCOPE_KEYBOARD_FOCUS_DISPLAY')
        mouse = self.display_name('GAMESCOPE_MOUSE_FOCUS_DISPLAY')
        if not app or app in self.excluded or app != graphics or keyboard != mouse or not re.fullmatch(r':[0-9]+',keyboard):
            return None
        display = self.connection(keyboard)
        window, revert = c.c_ulong(), c.c_int()
        self.x.XGetInputFocus(display,c.byref(window),c.byref(revert))
        window = window.value
        for _ in range(16):
            if window in (0,1,self.x.XDefaultRootWindow(display)): return None
            window_app = self.scalar(display,window,'STEAM_GAME')
            if window_app is not None:
                wine = self.scalar(display,window,'_WINE_HWND_STYLE') is not None
                protocols = self.values(display,window,'WM_PROTOCOLS')
                if eligible_target(app,graphics,keyboard,mouse,window_app,wine,
                                   self.atom(display,'WM_TAKE_FOCUS') in protocols,self.excluded):
                    return (app, keyboard, window)
                return None
            parent, tree_root, children, count = c.c_ulong(), c.c_ulong(), c.POINTER(c.c_ulong)(), c.c_uint()
            ok = self.x.XQueryTree(display,window,c.byref(tree_root),c.byref(parent),c.byref(children),c.byref(count))
            if children: self.x.XFree(children)
            if not ok or parent.value == window: return None
            window = parent.value
        return None

    def server_time(self, display):
        if display not in self.helpers:
            window = self.x.XCreateSimpleWindow(display,self.x.XDefaultRootWindow(display),0,0,1,1,0,0,0)
            self.x.XSelectInput(display,window,1<<22)
            self.helpers[display] = window
        window = self.helpers[display]
        atom = self.atom(display,'KIMOCHI_PROBE_SERVER_TIME')
        value = c.c_ubyte(1)
        self.x.XChangeProperty(display,window,atom,19,8,0,c.byref(value),1)
        self.x.XFlush(display)
        deadline = time.monotonic()+.2
        while time.monotonic() < deadline:
            if self.x.XPending(display):
                event = Event()
                self.x.XNextEvent(display,c.byref(event))
                if event.property.type == 28 and event.property.window == window and event.property.atom == atom:
                    return event.property.time
            else:
                select.select([self.x.XConnectionNumber(display)],[],[],.01)
        raise RuntimeError('X server timestamp timed out')

    def tick(self):
        target = self.target()
        if not self.transition.changed(target): return True
        app, name, window = target
        display = self.connection(name)
        timestamp = self.server_time(display)
        # Revalidate after getting a timestamp; Steam/QAM may have taken focus.
        if self.target() != target:
            self.transition.last = None
            return True
        event = Event()
        event.client.type = 33
        event.client.display = display
        event.client.window = window
        event.client.message = self.atom(display,'WM_PROTOCOLS')
        event.client.format = 32
        event.client.data[0] = self.atom(display,'WM_TAKE_FOCUS')
        event.client.data[1] = timestamp
        sent = self.x.XSendEvent(display,window,0,0,c.byref(event))
        self.x.XFlush(display)
        self.report('wine-focus-handoff',app=app,display=name,window=window,timestamp=timestamp,sent=bool(sent))
        return True

    def close(self):
        for display in self.connections.values(): self.x.XCloseDisplay(display)
        self.connections.clear()
        self.x.XSetErrorHandler(self.old_error_handler)


def main():
    import json
    import signal
    import sys
    if os.environ.get('KIMOCHI_SESSION_PROBE') != '1':
        raise SystemExit('requires KIMOCHI_SESSION_PROBE=1')
    def report(event, **fields):
        print(json.dumps({'event':event,'at':time.time(),**fields}),flush=True)
    running = True
    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    relay = FocusRelay(report)
    heartbeat = time.monotonic()
    try:
        while running and time.monotonic()-heartbeat < 2.5:
            if select.select([sys.stdin],[],[],.1)[0]:
                data = os.read(0,32)
                if not data: break
                if b'A' in data: heartbeat = time.monotonic()
            try:
                relay.tick()
            except (OSError, RuntimeError) as error:
                report('wine-focus-handoff-error',error=str(error))
    finally:
        relay.close()


if __name__ == '__main__':
    main()
