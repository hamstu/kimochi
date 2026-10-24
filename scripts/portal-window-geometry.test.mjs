import {test} from 'node:test'
import assert from 'node:assert/strict'
import {portalWindowBounds, portalCropArea} from '../ui/portal-window-geometry.js'
const bounds = {x:100,y:40,width:900,height:600}
const info = {source_id:'portal:window:7',source_bounds:bounds,scale_factor:4/3,full_width:1200,full_height:800}
test('only a compositor-linked portal window can use native placement',()=>{
 assert.equal(portalWindowBounds(info),bounds)
 assert.equal(portalWindowBounds({...info,source_bounds:null},bounds),null)
 assert.equal(portalWindowBounds({...info,source_id:'portal:display:7'}),null)
})
test('moves follow the linked window; stale buffers after resize hide annotations',()=>{
 const moved={...bounds,x:430,y:80}
 assert.equal(portalWindowBounds(info,moved),moved)
 assert.equal(portalWindowBounds(info,{...moved,width:1000}),null)
 assert.equal(portalWindowBounds({...info,scale_factor:NaN}),null)
})
test('native crop stays within the visible output including negative window origins',()=>{
 assert.deepEqual(portalCropArea({x:-100,y:50,width:900,height:600},{width:800,height:500}),{x:0,y:50,width:800,height:450})
 assert.equal(portalCropArea({x:900,y:0,width:100,height:100},{width:800,height:500}),null)
})
