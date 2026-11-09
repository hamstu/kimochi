#!/usr/bin/python3
"""Run a KWin script; out(x) in it prints x here. kwin-js.py 'js code' | file.js"""
import sys, os, dbus, dbus.service, tempfile
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
DBusGMainLoop(set_as_default=True)
code = open(sys.argv[1]).read() if os.path.exists(sys.argv[1]) else sys.argv[1]
bus = dbus.SessionBus(); me = bus.get_unique_name(); loop = GLib.MainLoop()
class Out(dbus.service.Object):
    @dbus.service.method('org.rig.Out', in_signature='s')
    def Print(self, s):
        if s == '@@end': loop.quit()
        else: print(s, flush=True)
Out(bus, '/out')
pre = f'function out(x){{callDBus("{me}","/out","org.rig.Out","Print", typeof x==="string"?x:JSON.stringify(x));}}\n'
f = tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, dir=os.environ['XDG_RUNTIME_DIR'])
end = '' if 'done()' in code else 'out("@@end");'
f.write(pre + 'function done(){out("@@end")}\ntry{\n' + code + '\n}catch(e){out("ERROR: "+e)}\n' + end + '\n'); f.close()
scripting = dbus.Interface(bus.get_object('org.kde.KWin', '/Scripting'), 'org.kde.kwin.Scripting')
name = 'rig' + str(os.getpid())
sid = scripting.loadScript(f.name, name, signature='ss')
dbus.Interface(bus.get_object('org.kde.KWin', f'/Scripting/Script{sid}'), 'org.kde.kwin.Script').run()
GLib.timeout_add(5000, lambda: (print('timeout', file=sys.stderr), loop.quit()))
loop.run()
scripting.unloadScript(name); os.unlink(f.name)
