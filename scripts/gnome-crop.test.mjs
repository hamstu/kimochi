import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {selectGnomeCrop} from '../ui/gnome-crop.js'
const source=(await readFile(new URL('../src-tauri/gnome-extension/implementation.js',import.meta.url),'utf8'))
 .replace(/^import .*;\n/gm,'').replace('export default class','class')+'\nKimochiOverlay'
function fixture() {
 const signals=[],monitors=[{x:0,y:0,width:1000,height:800}],shell={display:{focus_window:null},stage:{set_key_focus(){}}}
 const Overlay=vm.runInNewContext(source,{Extension:class{},Main:{layoutManager:{monitors},sessionMode:{}},global:shell,
  Clutter:{AnimationMode:{EASE_OUT_QUAD:1}},Gio:{bus_unwatch_name(){}},GLib:{Variant:class{constructor(type,args){this.args=args}}}})
 const o=new Overlay();o._cropPaint=()=>{};o._words=[];o._group={};o._hideButton={};o._controlVisible=()=>false
 o._bus={emit_signal:(name,v)=>signals.push({name,payload:JSON.parse(v.args[0])})}
 o._crop={id:'test',owner:':1.2',width:2000,height:1600,monitor:monitors[0],rect:null}
 return {o,signals,monitors}
}
test('GNOME crop clamps drags and converts reverse selection to capture pixels',()=>{
 const {o,signals}=fixture();o._cropBegin(900,700);o._cropMove(-100,-100);o._finishCrop(true)
 assert.equal(o._crop,null)
 assert.deepEqual(JSON.parse(JSON.stringify(signals[0].payload.crop)),{x:0,y:0,width:1800,height:1400,reference_width:2000,reference_height:1600})
})
test('GNOME crop moves within its monitor and resizes across opposite edges',()=>{
 const {o}=fixture();o._crop.rect={x:100,y:100,width:200,height:200};o._cropBegin(200,200);o._cropMove(2000,2000)
 assert.deepEqual(JSON.parse(JSON.stringify(o._crop.rect)),{x:800,y:600,width:200,height:200})
 o._cropBegin(800,600);o._cropMove(900,700)
 assert.deepEqual(JSON.parse(JSON.stringify(o._crop.rect)),{x:900,y:700,width:100,height:100})
})
test('GNOME crop cancel releases actors and emits exactly one empty result',()=>{
 const {o,signals}=fixture();let destroyed=0;o._cropGroup={destroy(){destroyed++}};o._finishCrop(false);o._finishCrop(false)
 assert.equal(destroyed,1);assert.equal(signals.length,1);assert.equal(signals[0].payload.crop,null)
})
test('foreign crop owners cannot cancel another client selection',()=>{
 const {o}=fixture();const inv={get_sender:()=>':1.3',return_dbus_error(_name,msg){this.error=msg}}
 o.CropAsync([JSON.stringify({operation:'cancel',id:'test'})],inv)
 assert.match(inv.error,/Another client/);assert.ok(o._crop)
})
test('frontend crop registers its result listener before starting and always releases lease',async()=>{
 const calls=[];let listener
 const prior=globalThis.window;globalThis.window={__TAURI__:{event:{emit:async()=>calls.push('open')}}}
 const native={panel:async(_label,action)=>calls.push(action),listen:async(_name,fn)=>{listener=fn;calls.push('listen');return()=>calls.push('stop')},
  invoke:async(_name,{payload})=>{calls.push(payload.operation);if(payload.operation==='start')listener({payload:{id:payload.id,crop:{x:10,y:20,width:30,height:40}}})}}
 const crop=await selectGnomeCrop(native,{sourceId:'portal:display:1',frame:{width:100,height:100},quick:true})
 globalThis.window=prior
 assert.equal(crop.width,30);assert.deepEqual(calls,['listen','start','show_inactive','open','stop','cancel','hide'])
})

test('window matching rejects ties, excludes own windows and uses a real title only to resolve exact-sized candidates',()=>{
 const actors=[]
 const Overlay=vm.runInNewContext(source,{Extension:class{},global:{get_window_actors:()=>actors}})
 const o=new Overlay()
 const win=(title,pid=2,width=400,height=300,scale=1)=>({get_pid:()=>pid,get_title:()=>title,get_buffer_rect:()=>({width,height}),get_compositor_private:()=>({get_resource_scale:()=>scale})})
 const first=win('Book'),second=win('Game'),own=win('Kimochi',1)
 actors.push({meta_window:first},{meta_window:own})
 assert.equal(o._matchWindow({width:400,height:300,name:'Shared window'},1),first)
 actors.push({meta_window:second})
 assert.equal(o._matchWindow({width:400,height:300,name:'Shared window'},1),null)
 assert.equal(o._matchWindow({width:400,height:300,name:'Game'},1),second)
 assert.equal(o._matchWindow({width:401,height:700,name:'Game'},1),null)
 actors.push({meta_window:win('Game')})
 assert.equal(o._matchWindow({width:400,height:300,name:'Game'},1),null)
})
test('GNOME window bounds and annotations follow only the linked source, hiding stale-sized frames',()=>{
 const {o}=fixture();let rect={x:10,y:20,width:400,height:300}
 o._sourceKind='window';o._sourceId='portal:window:64';o._referenceBounds={...rect};o._baseWords=[{x:40,y:60}];o._words=[{x:40,y:60}]
 let position;o._group={get_child_at_index:()=>({set_position:(x,y)=>{position=[x,y]}})}
 o._trackedStatus=()=>({sourceId:'portal:window:64',bounds:rect,visible:true})
 rect={...rect,x:70,y:80};o._followTracked()
 assert.deepEqual(position,[100,120]);assert.equal(o._trackedVisible,true)
 rect={...rect,width:500};o._followTracked();assert.equal(o._trackedVisible,false)
})

test('linked window crop rejects a same-aspect frame from a differently sized window',()=>{
 const {o}=fixture();o._crop=null;o._tracked={owner:':1.2',window:{showing_on_its_workspace:()=>true,minimized:false,activate(){}}}
 o._trackedStatus=()=>({sourceId:'portal:window:64',bounds:{x:100,y:100,width:400,height:300},scale:1,visible:true})
 const invocation={get_sender:()=>':1.2',return_dbus_error(_name,message){this.error=message}}
 o.CropAsync([JSON.stringify({operation:'start',id:'different-frame',sourceId:'portal:window:64',width:800,height:600,label:'Save'})],invocation)
 assert.match(invocation.error,/dimensions disagree/)
 assert.equal(o._crop,null)
})


test('shared crop editor validates desktop bounds and converts through the same capture contract',()=>{
 const {o,signals}=fixture();o._crop.webview=true;o._crop.area={x:100,y:80,width:400,height:300};o._crop.width=800;o._crop.height=600
 const inv={get_sender:()=>':1.2',return_dbus_error(_n,message){this.error=message},return_value(){}}
 o.CropAsync([JSON.stringify({operation:'complete',id:'test',rect:{x:50,y:80,width:200,height:100}})],inv)
 assert.match(inv.error,/outside/);assert.ok(o._crop)
 o.CropAsync([JSON.stringify({operation:'complete',id:'test',rect:{x:150,y:100,width:200,height:100}})],inv)
 assert.equal(o._crop,null)
 assert.deepEqual(JSON.parse(JSON.stringify(signals[0].payload.crop)),{x:100,y:40,width:400,height:200,reference_width:800,reference_height:600})
})


test('fullscreen transparency workaround touches only an active own shared crop actor',()=>{
 const {o}=fixture();let faded=0
 const background={reactive:true,opacity:255,get_n_children:()=>0,get_background_color:()=>({red:0,green:0,blue:0,alpha:255})}
 const surface={reactive:true,opacity:255,get_n_children:()=>1,get_background_color:()=>({red:0,green:0,blue:0,alpha:0})}
 const actor={opacity:255,get_children:()=>[background,surface],ease({opacity}){this.opacity=opacity;faded++},get_transition:()=>null}
 o._transparentCrop();assert.equal(background.opacity,255)
 o._crop.webview=true;o._crop.window={get_compositor_private:()=>actor}
 o._transparentCrop();assert.equal(background.opacity,0);assert.equal(surface.opacity,255);assert.equal(actor.opacity,254)
 actor.opacity=255;o._transparentCrop();assert.equal(actor.opacity,254);assert.equal(faded,1)
})
