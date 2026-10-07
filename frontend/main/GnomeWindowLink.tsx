import {useEffect, useState} from 'react'
import {invoke} from '@tauri-apps/api/core'
import {listen} from '@tauri-apps/api/event'
import {ConfirmDialog} from '@kit'
import {useCapabilities} from '../bridge/capabilities'

const REQUEST_LINK='kimochi-link-window'

/** Automatic pairing is silent; ambiguous portal windows need one explicit choice. */
export function GnomeWindowLink({sourceId}: {sourceId?: string}): React.JSX.Element | null {
  const caps=useCapabilities()
  const [open,setOpen]=useState(false)
  const [error,setError]=useState(false)
  const eligible=window.__KIMOCHI_PLATFORM__?.os === 'linux' && caps.session?.backend === 'wayland' && caps.session.compositor === 'GNOME' && caps.overlay.passive && Boolean(sourceId?.startsWith('portal:window:'))
  useEffect(()=>{
    if(!eligible||!sourceId)return
    let alive=true
    const request=(): void=>{setError(false);setOpen(true)}
    window.addEventListener(REQUEST_LINK,request)
    const match=async (): Promise<void>=>{
      try {
        for(let attempt=0;attempt<3&&alive;attempt++) {
          const frame=await invoke<{width:number;height:number}|null>('source_hover_preview',{sourceId})
          if(!alive)return
          if(frame){
            const linked=await invoke<unknown>('gnome_overlay',{operation:'track',payload:{operation:'match',sourceId,width:frame.width,height:frame.height}})
            if(alive&&!linked)setOpen(true)
            return
          }
          await new Promise(resolve=>setTimeout(resolve,250))
        }
        if(alive)setOpen(true)
      } catch { if(alive)setOpen(true) }
    }
    void match()
    const stop=listen<{sourceId:string;linked:boolean}>('gnome-track-result',({payload})=>{
      if(alive&&payload.sourceId===sourceId&&payload.linked)setOpen(false)
    })
    return ()=>{alive=false;window.removeEventListener(REQUEST_LINK,request);void stop.then(fn=>fn())}
  },[sourceId,eligible])
  if(!eligible)return null
  const link=async (): Promise<void>=>{
    setOpen(false)
    // Let the dialog release focus before the native picker snapshots it.
    await new Promise(resolve=>setTimeout(resolve,150))
    try{await invoke('gnome_overlay',{operation:'track',payload:{operation:'choose',sourceId}})}
    catch{setError(true);setOpen(true)}
  }
  return <ConfirmDialog open={open} onOpenChange={setOpen}
    title="Choose the shared window"
    description={error?'Window selection could not start. Please try again.':'To place the overlay, click OK, then click the same window you selected for sharing. You only need to do this for the current share.'}
    confirmLabel="OK" onConfirm={()=>void link()} />
}
