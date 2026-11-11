#!/usr/bin/python3
"""A stand-in org.freedesktop.login1 on the container's system bus: GNOME Shell refuses to start
without one. One active local session; every power action answers 'na'."""
import dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()
name = dbus.service.BusName('org.freedesktop.login1', bus)
SESSION = '/org/freedesktop/login1/session/rig'
PROPS = 'org.freedesktop.DBus.Properties'

class Session(dbus.service.Object):
    props = {'Id': 'rig', 'Active': True, 'LockedHint': False, 'Remote': False, 'Type': 'wayland',
             'Class': 'user', 'State': 'active', 'Seat': ('seat0', dbus.ObjectPath('/org/freedesktop/login1/seat/seat0')),
             'User': (dbus.UInt32(0), dbus.ObjectPath('/org/freedesktop/login1/user/_0'))}
    @dbus.service.method(PROPS, in_signature='ss', out_signature='v')
    def Get(self, iface, prop): return self.props[prop]
    @dbus.service.method(PROPS, in_signature='s', out_signature='a{sv}')
    def GetAll(self, iface): return self.props
    @dbus.service.method('org.freedesktop.login1.Session', in_signature='b')
    def SetLockedHint(self, locked): self.props['LockedHint'] = bool(locked)
    @dbus.service.signal('org.freedesktop.login1.Session')
    def Lock(self): pass
    @dbus.service.signal('org.freedesktop.login1.Session')
    def Unlock(self): pass

class Manager(dbus.service.Object):
    @dbus.service.method('org.freedesktop.login1.Manager', in_signature='s', out_signature='o')
    def GetSession(self, _): return dbus.ObjectPath(SESSION)
    @dbus.service.method('org.freedesktop.login1.Manager', in_signature='u', out_signature='o')
    def GetSessionByPID(self, _): return dbus.ObjectPath(SESSION)
    @dbus.service.method('org.freedesktop.login1.Manager', in_signature='', out_signature='a(susso)')
    def ListSessions(self): return [('rig', dbus.UInt32(0), 'root', 'seat0', dbus.ObjectPath(SESSION))]
    for verb in ('CanSuspend', 'CanHibernate', 'CanHybridSleep', 'CanSuspendThenHibernate', 'CanPowerOff', 'CanReboot', 'CanRebootToBootLoaderMenu'):
        exec(f"@dbus.service.method('org.freedesktop.login1.Manager', in_signature='', out_signature='s')\ndef {verb}(self): return 'na'")
    @dbus.service.method(PROPS, in_signature='ss', out_signature='v')
    def Get(self, iface, prop): return {'PreparingForSleep': False, 'PreparingForShutdown': False}.get(prop, '')
    @dbus.service.method(PROPS, in_signature='s', out_signature='a{sv}')
    def GetAll(self, iface): return {'PreparingForSleep': False, 'PreparingForShutdown': False}
    @dbus.service.signal('org.freedesktop.login1.Manager', signature='b')
    def PrepareForSleep(self, start): pass

Session(bus, SESSION); Manager(bus, '/org/freedesktop/login1')
GLib.MainLoop().run()
