import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {load} from './load.mjs'
const {installGnomeOverlay}=await load('gnome-overlay.js')

const source=(await readFile(new URL('../src-tauri/gnome-extension/implementation.js',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'').replace('export default class','class')+'\nKimochiOverlay'
function shellFixture() {
  const signals=[],actors=[]
  const context={Extension:class{},global:{get_window_actors:()=>actors,get_pointer:()=>[20,30,0]},
    GLib:{get_monotonic_time:()=>100,Variant:class{constructor(_type,value){this.value=value}}},
    Clutter:{ModifierType:{BUTTON1_MASK:1,SHIFT_MASK:2,CONTROL_MASK:4,MOD1_MASK:8,SUPER_MASK:16}},
    Main:{overview:{visible:false},sessionMode:{isLocked:false,isGreeter:false},wm:{skipNextEffect(){}},
      layoutManager:{monitors:[{x:0,y:0,width:1000,height:800}]}}}
  const Overlay=vm.runInNewContext(source,context),o=new Overlay()
  o._words=[{}];o._controlVisible=()=>true
  o._bus={emit_signal:(name,value)=>signals.push({name,payload:JSON.parse(value.value[0])})}
  return {o,context,signals,actors}
}
test('shared annotations hide for capture, crop, overview, lock, and an inactive or resized linked source',()=>{
  const {o,context}=shellFixture()
  o._surface={sourceKind:'window',sourceId:'portal:window:1',rect:{x:0,y:0,width:1000,height:800}}
  o._trackedVisible=true
  o._trackedStatus=()=>({sourceId:'portal:window:1',bounds:{x:10,y:20,width:400,height:300}})
  assert.equal(o._surfaceState().visible,true)
  for(const key of ['_suspended','_crop','_pick']) {
    o[key]=true;assert.equal(o._surfaceState().visible,false);o[key]=false
  }
  context.Main.overview.visible=true;assert.equal(o._surfaceState().visible,false);context.Main.overview.visible=false
  context.Main.sessionMode.isLocked=true;assert.equal(o._surfaceState().visible,false);context.Main.sessionMode.isLocked=false
  o._trackedVisible=false;assert.equal(o._surfaceState().visible,false)
  o._trackedVisible=true;o._trackedStatus=()=>null;assert.equal(o._surfaceState().visible,false)
})
test('a shared surface rejects foreign ownership and has no fullscreen input or keyboard grab',()=>{
  const {o}=shellFixture();o._surface={owner:':1.2'}
  const inv={get_sender:()=>':1.3',return_dbus_error(_name,message){this.error=message}}
  o.SurfaceAsync([JSON.stringify({operation:'close'})],inv)
  assert.match(inv.error,/Another client/);assert.equal(o._surface.owner,':1.2')
})
test('surface synchronization only places the leased own window, preserves game focus, and stops repeating unchanged pointer samples',()=>{
  const {o,actors,signals}=shellFixture();let raised=0,moved=0,above=false
  const actor={remove_all_transitions(){},set_scale(){},set_translation(){}}
  const win={get_pid:()=>8,get_title:()=> 'Kimochi · overlay',get_compositor_private:()=>actor,
    get_frame_rect:()=>({x:0,y:0,width:1000,height:800}),is_above:()=>above,is_override_redirect:()=>false,
    make_above(){above=true;raised++},move_resize_frame(){moved++},activate(){assert.fail('passive annotations must never activate')}}
  actors.push({meta_window:{get_pid:()=>99,get_title:()=> 'Kimochi · overlay'}},{meta_window:win})
  o._surface={owner:':1.2',pid:8,sourceKind:'screen',sourceId:'portal:display:1',rect:{x:0,y:0,width:1000,height:800},updated:100}
  for(let i=0;i<100;i++)o._syncSurface()
  assert.equal(o._surface.window,win);assert.equal(actor.visible,true);assert.equal(raised,1);assert.equal(moved,0)
  assert.equal(signals.length,1);assert.equal(signals[0].name,'Pointer');assert.equal(signals[0].payload.over,true)
  o._suspended=true;o._syncSurface();assert.equal(actor.visible,false);assert.equal(signals.at(-1).payload.over,false)
  let hidden=0;actor.hide=()=>hidden++;o._finishSurface();assert.equal(hidden,1);assert.equal(o._surface,null)
})
test('constrained GNOME surface origin agrees with pointer and native input geometry without a placement loop',()=>{
  const {o,actors,signals,context}=shellFixture();let moves=0
  const frame={x:0,y:32,width:1000,height:800}
  const actor={remove_all_transitions(){},set_scale(){},set_translation(){}}
  const win={get_pid:()=>8,get_title:()=> 'Kimochi · overlay',get_compositor_private:()=>actor,
    get_frame_rect:()=>frame,is_above:()=>true,is_override_redirect:()=>false,
    move_resize_frame(){moves++}}
  actors.push({meta_window:win})
  o._surface={owner:':1.2',pid:8,sourceKind:'screen',sourceId:'portal:display:1',rect:{x:0,y:0,width:1000,height:800},updated:100}
  for(let i=0;i<100;i++)o._syncSurface()
  assert.equal(moves,1,'Mutter constraints must not cause 50 placement requests per second')
  assert.equal(signals[0].payload.origin.y,32)
  assert.equal(signals[0].payload.bounds.y,0,'screen capture bounds do not move with the overlay')
  const invocation={get_sender:()=>':1.2',return_value(v){this.rect=JSON.parse(v.value[0])},return_dbus_error(_n,error){assert.fail(error)}}
  context.Gio={DBus:{session:{call_sync:()=>({deep_unpack:()=>[8]})}},DBusCallFlags:{NONE:0}}
  context.GLib.VariantType=class{}
  o.OwnWindowAsync([JSON.stringify({label:'overlay'})],invocation)
  assert.equal(invocation.rect.y,32,'input shape origin agrees with DOM and pointer origin')
  o._surface.rect={x:0,y:0,width:1200,height:800};o._syncSurface()
  assert.equal(moves,2,'a changed monitor allocation is placed once again')
})
test('linked source stays visible beside Kimochi, but hides when covered, inactive or minimized',()=>{
  const {o,context}=shellFixture()
  const rect={x:500,y:100,width:400,height:300}
  const source={get_compositor_private:()=>({get_paint_visibility:()=>true,get_resource_scale:()=>1}),
    get_pid:()=>99,get_stable_sequence:()=>7,get_buffer_rect:()=>rect,showing_on_its_workspace:()=>true,
    get_gtk_application_id:()=>null,get_id:()=>9,get_title:()=> 'Source',minimized:false}
  context.Shell={WindowTracker:{get_default:()=>({get_window_app:()=>null})}}
  context.global.display={focus_window:source}
  o._tracked={window:source,sequence:7,sourceId:'portal:window:1',pid:8}
  assert.equal(o._trackedStatus().visible,true)
  const app={get_pid:()=>8,get_frame_rect:()=>({x:0,y:0,width:450,height:800})}
  context.global.display.focus_window=app;assert.equal(o._trackedStatus().visible,true)
  app.get_frame_rect=()=>({x:600,y:200,width:200,height:200})
  assert.equal(o._trackedStatus().visible,false)
  app.get_pid=()=>99;app.get_frame_rect=()=>({x:0,y:0,width:450,height:800})
  assert.equal(o._trackedStatus().visible,false)
  context.global.display.focus_window=source;source.minimized=true
  assert.equal(o._trackedStatus().visible,false)
})
test('GNOME uses the shared renderer with intact OCR segments, grouping, opacity, and live desktop bounds',async()=>{
  const savedWindow=globalThis.window,savedInterval=globalThis.setInterval
  const calls=[],renders=[]
  const bounds={x:50,y:60,width:500,height:400},monitor={x:0,y:0,width:1000,height:800}
  const annotation={description:'日本語',granularity:'line',segments:[{text:'日本',bbox:[0,0,80,30]},{text:'語',bbox:[80,0,110,30]}],
    boundingPoly:{vertices:[{x:10,y:10},{x:120,y:40}]}}
  const state={geometry:{},info:{source_id:'portal:window:1',source_bounds:bounds,full_width:1000,full_height:800,crop_pixels:[0,0]},
    annotations:[annotation],appliedScanId:1,scanning:false}
  const status={available:true,sharedOverlay:true,monitors:[monitor],tracked:{sourceId:state.info.source_id,bounds,visible:true}}
  globalThis.window={__KIMOCHI_PLATFORM__:{os:'linux'},__TAURI__:{core:{invoke:async(_cmd,{operation,payload})=>{
    calls.push({operation,payload});if(operation==='status')return status;if(operation==='surface')return {rect:monitor};return {}
  }}}}
  globalThis.setInterval=()=>0
  try {
    const renderer={clear(){calls.push({operation:'renderer-clear'})},render:args=>renders.push(args)}
    const bridge=await installGnomeOverlay({},state,()=>true,()=>{}, {renderer,setting:key=>({textOverlayGrouping:true,overlayOpacity:.6})[key]})
    await bridge.update()
    assert.equal(bridge.shared,true);assert.equal(renders[0].annotations[0],annotation)
    assert.deepEqual(renders[0].annotations[0].segments,annotation.segments)
    assert.equal(renders[0].grouping,true);assert.equal(renders[0].opacity,.6);assert.equal(renders[0].bounds,bounds)
    const moved={...bounds,x:80,y:90}
    bridge.pointer({sourceId:state.info.source_id,origin:monitor,bounds:moved,visible:true})
    assert.deepEqual(renders.at(-1).bounds,moved)
    const count=renders.length
    bridge.pointer({sourceId:'portal:window:99',origin:monitor,bounds,visible:true});assert.equal(renders.length,count)
    await bridge.pause();assert.equal(bridge.shared,false)
    assert.ok(calls.some(c=>c.operation==='surface'&&c.payload.operation==='close'))
    status.tracked.bounds={...bounds,width:503};await bridge.update()
    assert.equal(bridge.shared,false,'a resized source cannot reuse stale capture geometry')
  } finally {globalThis.window=savedWindow;globalThis.setInterval=savedInterval}
})

test('GNOME popup transport waits for backend forwarding and relays native dictionary ports exactly once',async()=>{
  const {installGnomePopupTransport}=await load('gnome-popup-transport.js')
  const packets=[],opened=[],messages=[],disconnects=[]
  let receiver,seq=0,backendReady=false,shutdown
  const owner={ports:new Set(),events:{onConnect:{emit:p=>opened.push(p)}}}
  const win={__KIMOCHI_PLATFORM__:{os:'linux'},__kimochiFrameBands:{'popup-host':3000},__kimochiFrameBandSize:1000,
    addEventListener(_name,handler){shutdown=handler},__TAURI__:{
      core:{invoke:async(command,args)=>{
        if(command==='gnome_overlay')return {available:true,sharedOverlay:true,desktopPopup:true}
        if(command==='window_bounds')return {x:10,y:20}
        packets.push(args)
        if(args.payload.kind==='ping'){
          assert.equal(backendReady,true,'backend requests and readiness broadcasts must be enabled before waiting for the host')
          receiver({payload:{from:'popup-host',to:'overlay',seq:++seq,payload:{kind:'pong',id:args.payload.id,ready:true}}})
        }
      }},event:{listen:async(_name,handler)=>{receiver=handler;return()=>{}}}}}
  const hub={select:(_tab,frame)=>frame===0?[owner]:[]}
  const remote=await installGnomePopupTransport(win,hub,()=>{backendReady=true})
  assert.equal(remote.frameId,3000);assert.deepEqual(await remote.offset(),[10,20])
  const port=hub.connectRemote({frameId:3000,name:JSON.stringify({name:'cross-frame-communication-port',otherTabId:1,otherFrameId:0}),owner})
  port.onMessage.addListener(data=>messages.push(data));port.onDisconnect.addListener(()=>disconnects.push(true))
  port.postMessage({type:'invoke',id:1});await new Promise(resolve=>setImmediate(resolve))
  const start=packets.find(p=>p.payload.kind==='port-open')
  assert.equal(start.payload.fromFrameId,0);assert.equal(start.payload.fromWindow,'overlay')
  const packet={from:'popup-host',to:'overlay',seq:++seq,payload:{kind:'port-message',channel:start.payload.channel,message:{type:'ack',id:1}}}
  receiver({payload:packet});receiver({payload:packet});assert.equal(messages.length,1)
  receiver({payload:{...packet,from:'log',seq:++seq}});assert.equal(messages.length,1)
  receiver({payload:{from:'popup-host',to:'overlay',seq:++seq,payload:{kind:'port-open',channel:'reverse',toFrameId:0,fromTabId:55787,fromFrameId:3000}}})
  assert.equal(opened.length,1);assert.equal(JSON.parse(opened[0].name).otherFrameId,3000)
  assert.throws(()=>hub.connectRemote({frameId:1000,name:'{}',owner}),/Unknown remote frame/)
  receiver({payload:{from:'popup-host',to:'overlay',seq:++seq,payload:{kind:'port-close',channel:start.payload.channel}}})
  assert.equal(disconnects.length,1);assert.throws(()=>port.postMessage({}),/Disconnected/)
  shutdown();assert.equal(hub.connectRemote,undefined);assert.equal(owner.ports.size,0)
})
