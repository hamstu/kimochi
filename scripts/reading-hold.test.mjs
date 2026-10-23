import test from 'node:test'
import assert from 'node:assert/strict'
import {load} from './load.mjs'
const {ReadingHold}=await load('reading-hold.ts')
const rect={x:10,y:20,width:100,height:30}
test('reading stays held until the text AND the entire popup chain have been left',()=>{
 const hold=new ReadingHold()
 assert.equal(hold.update({x:0,y:0},[rect],false),false)
 assert.equal(hold.update({x:15,y:25},[rect],false),true)
 assert.equal(hold.update({x:200,y:200},[rect],true),true)
 assert.equal(hold.update({x:15,y:25},[rect],false),true,'closing popup over the source text keeps it stable')
 assert.equal(hold.update({x:200,y:200},[rect],false),false)
})
test('stationary text hover survives styling changes, and leaving or reset releases its anchor',()=>{
 const hold=new ReadingHold()
 assert.equal(hold.update({x:15,y:25},[rect],false),true)
 assert.equal(hold.update({x:15,y:25},[],false),true)
 assert.equal(hold.update({x:200,y:200},[],false),false)
 assert.equal(hold.update({x:15,y:25},[rect],false),true)
 hold.reset()
 assert.equal(hold.update({x:15,y:25},[],false),false)
 assert.equal(hold.update(null,[],true),true,'popup alone protects a lookup')
 assert.equal(hold.update(null,[],false),false)
})
