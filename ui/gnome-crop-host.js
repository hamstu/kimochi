/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux GNOME runtime. */
import {RegionSelect} from './region-select.js'

if (window.__KIMOCHI_PLATFORM__?.os === 'linux') {
  const {core,event}=window.__TAURI__
  const request=payload=>core.invoke('gnome_overlay',{operation:'crop',payload})
  let active=null
  await event.listen('gnome-crop-result',({payload})=>{
    if(active?.id===payload.id)active.selector.cancel()
  })
  await event.listen('gnome-crop-open',async ({payload})=>{
    if(active?.id===payload.id)return
    active?.selector.cancel()
    let selector
    try {
      const c=await request({operation:'editor',id:payload.id})
      const local=r=>r&&({...r,x:r.x-c.monitor.x,y:r.y-c.monitor.y})
      selector=new RegionSelect({container:document.body,confirmLabel:c.label,theme:c.theme,
        area:local(c.area),initial:local(c.initial)})
      active={id:c.id,selector}
      const running=selector.start({bounds:c.monitor})
      for(let attempt=0;;attempt++) {
        try {await core.invoke('gnome_overlay',{operation:'own-window',payload:{label:'crop-host'}});break}
        catch(error) {
          if(attempt>=15||!String(error).includes('not mapped yet'))throw error
          await new Promise(resolve=>setTimeout(resolve,50))
        }
      }
      const result=await running
      await request({operation:'complete',id:c.id,rect:result?.desktop??null}).catch(()=>{})
    } catch(error) {
      await request({operation:'cancel',id:payload.id}).catch(()=>{})
      void core.invoke('report',{value:{check:'gnome-shared-crop',error:String(error)}})
    } finally {
      selector?.destroy()
      if(active?.id===payload.id)active=null
      await core.invoke('panel',{label:'crop-host',action:'hide'}).catch(()=>{})
    }
  })
}
