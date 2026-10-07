import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
const source=(await readFile(new URL('../src-tauri/gnome-extension/implementation.js',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'').replace('export default class','class')+'\nKimochiOverlay'
function fixture(){
  const calls=[],signals=[],display={focus_window:null,grab_accelerator:()=>17,ungrab_accelerator:id=>calls.push(['release',id])}
  const Overlay=vm.runInNewContext(source,{Extension:class{},global:{display},
    Meta:{KeyBindingFlags:{IGNORE_AUTOREPEAT:1}},Shell:{ActionMode:{NORMAL:1,NONE:0}},
    Main:{wm:{allowKeybinding:(name,mode)=>calls.push([name,mode])}},
    Gio:{BusNameWatcherFlags:{NONE:0},DBus:{session:{}},bus_watch_name_on_connection:()=>1,bus_unwatch_name:id=>calls.push(['unwatch',id])},
    GLib:{get_monotonic_time:()=>1,Variant:class{constructor(_type,args){this.args=args}}}})
  const overlay=new Overlay();overlay._shortcuts=new Map();overlay._bus={emit_signal:(name,value)=>signals.push({name,args:value.args})}
  const invocation={get_sender:()=>':1.2',return_value(value){this.reply=JSON.parse(value.args[0])},return_dbus_error(_name,message){this.error=message}}
  return {overlay,invocation,display,calls,signals}
}
test('GNOME shortcuts reject foreign owners without releasing the existing grabs',()=>{
  const f=fixture();f.overlay._shortcutOwner=':1.3';f.overlay._shortcuts.set(1,'triggerScan')
  f.overlay.ShortcutsAsync([JSON.stringify({bindings:[]})],f.invocation)
  assert.match(f.invocation.error,/Another client/);assert.equal(f.overlay._shortcuts.size,1);assert.equal(f.calls.length,0)
})
test('GNOME shortcut conflict is reported and does not enable the rejected binding',()=>{
  const f=fixture();f.display.grab_accelerator=()=>0
  f.overlay.ShortcutsAsync([JSON.stringify({bindings:[{name:'triggerScan',accelerator:'<Control>8'}]})],f.invocation)
  assert.equal(f.invocation.reply.registered.length,0);assert.equal(f.invocation.reply.failed[0].name,'triggerScan');assert.equal(f.overlay._shortcuts.size,0)
})
test('GNOME shortcut cleanup releases every native grab and normal-mode allowance',()=>{
  const f=fixture();f.overlay._shortcuts.set(17,'triggerScan');f.overlay._shortcutWatch=1;f.overlay._clearShortcuts()
  assert.deepEqual(f.calls,[['unwatch',1],['release',17],['external-grab-17',0]]);assert.equal(f.overlay._shortcuts.size,0)
})
test('controller cleanup hides only its leased own actor and preserves a deliberate focus switch',()=>{
  const f=fixture();let hidden=0,restored=0
  const own={get_compositor_private:()=>({hide:()=>hidden++})},previous={get_compositor_private:()=>({}),activate:()=>restored++}
  f.overlay._controller={window:own,previousFocus:previous};f.display.focus_window={};f.overlay._finishController();f.overlay._finishController()
  assert.equal(hidden,1);assert.equal(restored,0);assert.equal(f.signals.length,1);assert.equal(f.signals[0].args[0],'controllerClosed')
})
test('foreign clients cannot inject a controller lookup or close its lease',()=>{
  const f=fixture();f.overlay._controller={owner:':1.3'}
  f.overlay.ControllerAsync([JSON.stringify({operation:'lookup',index:0})],f.invocation)
  assert.match(f.invocation.error,/Another client/);assert.equal(f.signals.length,0);assert.ok(f.overlay._controller)
})

test('OCR suppression rejects an open controller lease instead of capturing its transient UI',()=>{
  const f=fixture();f.overlay._controller={owner:':1.2'}
  f.overlay.SuspendAsync([true],f.invocation)
  assert.match(f.invocation.error,/Close controller navigation/)
})
