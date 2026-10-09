/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux GNOME runtime. */
import {createController} from './controller.js'
import * as base from './native.js'

if(window.__KIMOCHI_PLATFORM__?.os==='linux') {
  const {core,event}=window.__TAURI__
  const shell=(operation,payload)=>core.invoke('gnome_overlay',{operation,payload})
  const request=payload=>shell('controller',payload)
  const emit=(name,payload)=>event.emit(name,payload)
  const words=document.querySelector('#words')
  let snapshot={},settings={},keep=null,controller,lease=false,opening=false
  const pending=new Map()
  await event.listen('gnome-controller-response',({payload})=>{
    const entry=pending.get(payload.id);if(!entry)return
    pending.delete(payload.id);clearTimeout(entry.timer)
    if(payload.error)entry.reject(new Error(payload.error));else entry.resolve(payload.result)
  })
  const rpc=async(action,args={})=>{
    const id=crypto.randomUUID()
    const promise=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Controller action timed out'))},30000)
      pending.set(id,{resolve,reject,timer})
    })
    await emit('gnome-controller-command',{id,action,...args})
    return promise
  }
  async function refresh() {
    snapshot=await rpc('snapshot');settings=snapshot.settings??{}
    words.replaceChildren()
    // Rebuild only text nodes and native character indices. Dictionary lookup and
    // highlight geometry remain owned by the existing Shell/Yomitan bridge.
    const actors=(await shell('status',null)).actors??[]
    let unit=null,lastOffset=-1
    actors.forEach((actor,index)=>{
      if(!unit||unit.dataset.sentence!==actor.sentence||actor.offset<=lastOffset) {
        unit=document.createElement('div');unit.dataset.ocrWordBox='true';unit.dataset.sentence=actor.sentence
        const text=document.createElement('span');text.className='ocr-word-current';text.textContent=actor.sentence
        unit.append(text);unit.indices=[];words.append(unit)
      }
      const previous=unit.lastActor
      if(previous&&Math.abs(actor.y-previous.y)>Math.abs(actor.x-previous.x))unit.classList.add('ocr-vertical')
      unit.lastActor=actor
      unit.indices.push({offset:actor.offset,index});lastOffset=actor.offset
    })
  }
  async function endLease() {
    clearInterval(keep);keep=null
    if(lease){lease=false;await request({operation:'close'}).catch(()=>{})}
    await core.invoke('controller_nav',{active:false,takeFocus:false})
    await base.panel('controller-host','hide')
  }
  const native={...base,controllerNav:async active=>{
    if(!active)return endLease()
    await request({operation:'open'});lease=true
    await base.panel('controller-host','show_inactive')
    for(let attempt=0;;attempt++) {
      try {await shell('own-window',{label:'controller-host'});break}
      catch(error){if(attempt>=15||!String(error).includes('not mapped yet')){await endLease();throw error}await new Promise(resolve=>setTimeout(resolve,50))}
    }
    await core.invoke('controller_nav',{active:true,takeFocus:false})
    await rpc('hold',{hold:true});await refresh()
    clearInterval(keep);keep=setInterval(()=>void request({operation:'keep'}).catch(()=>void controller.close()),1000)
  }}
  controller=createController({host:document.querySelector('#controller'),words,native,
    status:()=>({...snapshot,origin:{x:0,y:0},area:{x:0,y:0,width:innerWidth,height:innerHeight},center:{x:innerWidth/2,y:innerHeight/2}}),
    run:async id=>{
      if(id==='controls'||id==='ocr-settings'){
        if(id==='ocr-settings')await base.setSetting('settingsActiveTab','ocr')
        await base.panel('log','show')
        if(id==='ocr-settings')await emit('main:show-settings')
        return
      }
      return rpc('action',{name:id==='auto'?'toggleAutoOcr':id})
    },
    scan:async()=>{const result=await rpc('scan');await refresh();return result},
    popupControl:control=>void emit('gnome-controller-popup-control',control),
    redraw:()=>{},quietText:()=>{},charRects:()=>null,nearText:()=>false,
    dictionary:()=> (action,params)=>rpc('dictionary',{apiAction:action,params}),
    popupType:()=> 'builtin',buttons:()=>settings.controllerButtons,
    lookupRange:async range=>{
      const unit=range.startContainer.parentElement.parentElement
      const match=unit.indices.find(entry=>entry.offset>=range.startOffset)
      if(!match)return false
      await request({operation:'lookup',index:match.index});return true
    },lookupTerm:async()=>{},setText:visible=>rpc('text',{visible}),
    dismiss:()=>void emit('gnome-popup-dismiss'),
    log:value=>void core.invoke('report',{value}),
    modeChanged:mode=>{
      void rpc('hold',{hold:mode!=='idle'})
      if(mode!=='idle')void request({operation:'mode',mode}).catch(()=>void controller.close())
    }
  })
  await event.listen('gnome-controller-closed',()=>void controller.close())
  await event.listen('gnome-controller-open',async()=>{
    if(opening||controller.mode!=='idle')return
    opening=true
    try {await refresh();await controller.toggle()}
    catch(error){await endLease();void core.invoke('report',{value:{check:'gnome-controller-open-failed',error:String(error)}})}
    finally{opening=false}
  })
  await event.listen('gnome-controller-toggle',()=>void controller.close())
  window.addEventListener('keydown',e=>{
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape'].includes(e.key))return
    e.preventDefault();void emit('controller-key',{type:'keydown',key:e.key})
  })
}
