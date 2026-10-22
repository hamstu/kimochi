/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Linux GNOME runtime bridge. */
/** Connect the overlay's existing Yomitan backend to the same native PopupFactory
 * used by the Log. Only JSON CrossFrameAPI ports cross native windows; the
 * original PopupProxy/Display and DOM scanner remain responsible for the UI. */
export async function installGnomePopupTransport(win, hub, backendReady = () => {}) {
  if (win.__KIMOCHI_PLATFORM__?.os !== 'linux') return null
  const tauri=win.__TAURI__
  const status=await tauri.core.invoke('gnome_overlay',{operation:'status',payload:null})
  if (!status.available || !status.sharedOverlay || !status.desktopPopup) return null
  backendReady()
  const ports=new Map(),waiters=new Map(),seen=new Map()
  let sequence=0
  const event=()=>{
    const listeners=new Set()
    return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),
      hasListener:f=>listeners.has(f),emit:(...args)=>{for(const f of listeners)f(...args)}}
  }
  const relay=(target,payload)=>tauri.core.invoke('ext_relay',{target,payload})
  function port({channel,name,target,owner,sender,ready=Promise.resolve()}) {
    let closed=false
    const onMessage=event(),onDisconnect=event()
    const finish=()=>{if(closed)return;closed=true;ports.delete(channel);owner.ports.delete(p);onDisconnect.emit(p)}
    const p={name,sender,onMessage,onDisconnect,
      postMessage(message){
        if(closed)throw Error('Disconnected port')
        void ready.then(()=>relay(target,{kind:'port-message',channel,message})).catch(()=>p.disconnect())
      },
      disconnect(){if(closed)return;finish();void relay(target,{kind:'port-close',channel}).catch(()=>{})},
      remoteClosed:finish}
    ports.set(channel,p);owner.ports.add(p)
    return p
  }
  const stop=await tauri.event.listen('ext-relay:overlay',({payload:packet})=>{
    if(packet?.to!=='overlay'||packet.from!=='popup-host')return
    if(typeof packet.seq==='number') {
      if(packet.seq<=(seen.get(packet.from)??-1))return
      seen.set(packet.from,packet.seq)
    }
    const data=packet.payload
    if(data?.kind==='pong'){waiters.get(data.id)?.(data.ready);return}
    if(data?.kind==='port-open'){
      if(ports.has(data.channel))return
      const owner=hub.select(1,data.toFrameId)[0];if(!owner)return
      const p=port({channel:data.channel,target:packet.from,owner,
        name:JSON.stringify({name:'cross-frame-communication-port',otherTabId:data.fromTabId,otherFrameId:data.fromFrameId}),
        sender:{frameId:data.fromFrameId,tab:{id:data.fromTabId}}})
      owner.events.onConnect.emit(p)
    }else if(data?.kind==='port-message')ports.get(data.channel)?.onMessage.emit(data.message,ports.get(data.channel))
    else if(data?.kind==='port-close')ports.get(data.channel)?.remoteClosed()
  })
  hub.connectRemote=({frameId,name,owner})=>{
    const base=win.__kimochiFrameBands?.['popup-host']
    if(!Number.isInteger(base)||frameId<base||frameId>=base+win.__kimochiFrameBandSize)throw Error(`Unknown remote frame ${frameId}`)
    const source=JSON.parse(name)
    if(source.name!=='cross-frame-communication-port')throw Error('Only dictionary cross-frame ports may cross windows')
    const channel=`gnome-overlay:${++sequence}`
    const ready=relay('popup-host',{kind:'port-open',channel,toFrameId:frameId,
      fromTabId:source.otherTabId??1,fromFrameId:source.otherFrameId,fromWindow:'overlay'})
    return port({channel,name,target:'popup-host',owner,sender:{frameId,tab:{id:null}},ready})
  }
  win.addEventListener('pagehide',()=>{
    stop();for(const p of [...ports.values()])p.disconnect();delete hub.connectRemote
  },{once:true})
  // Starting with a local fallback would cache it for the entire session. Wait
  // for the real native host, with the same bounded readiness check as panels.
  const end=Date.now()+30000
  while(Date.now()<end){
    const id=`gnome-popup:${++sequence}`
    const ready=new Promise(resolve=>{waiters.set(id,resolve);setTimeout(()=>resolve(false),250)})
    await relay('popup-host',{kind:'ping',id})
    const ok=await ready;waiters.delete(id)
    if(ok)return {frameId:win.__kimochiFrameBands['popup-host'],offset:async()=>{
      const bounds=await tauri.core.invoke('window_bounds');return [bounds.x,bounds.y]
    }}
  }
  throw Error('GNOME dictionary popup host did not become ready within 30 seconds')
}
