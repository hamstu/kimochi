import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'

const source=(await readFile(new URL('../src-tauri/gnome-extension/extension.js',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'').replace('export default class','class')
  .replace('await import(moduleFile.get_uri())','await importImplementation(moduleFile.get_uri())')+'\nKimochiLoader'
function fixture() {
  const imports=[],events=[]
  let current='a'.repeat(64)
  const dir={get_child(name){return {load_contents:()=>[true,new TextEncoder().encode(name==='previous-revision'?'b'.repeat(64):current)],
    query_exists:()=>true,get_uri:()=>name}}}
  const Loader=vm.runInNewContext(source,{TextDecoder,Extension:class{constructor(){this.dir=dir;this.metadata={}}},
    console:{error:message=>events.push(String(message))},importImplementation:uri=>new Promise((resolve,reject)=>imports.push({uri,resolve,reject}))})
  const loader=new Loader()
  const implementation=name=>class{enable(){events.push(`enable:${name}`)}disable(){events.push(`disable:${name}`)}}
  return {loader,imports,events,implementation,select:revision=>{current=revision}}
}
test('disabling while an implementation imports cannot resurrect the extension',async()=>{
  const f=fixture(),pending=f.loader.enable()
  f.loader.disable();f.imports[0].resolve({default:f.implementation('old')})
  await pending
  assert.deepEqual(f.events,[])
})
test('a stale import cannot replace a newer enabled implementation',async()=>{
  const f=fixture(),first=f.loader.enable()
  f.loader.disable();f.select('c'.repeat(64));const second=f.loader.enable()
  f.imports[1].resolve({default:f.implementation('new')});await second
  f.imports[0].resolve({default:f.implementation('old')});await first
  f.loader.disable()
  assert.deepEqual(f.events,['enable:new','disable:new'])
})
test('startup failure cleans the partial implementation and loads the safe fallback',async()=>{
  const f=fixture(),pending=f.loader.enable()
  f.imports[0].resolve({default:class{enable(){throw Error('failed startup')}disable(){f.events.push('cleanup')}}})
  for(let n=0;n<6&&f.imports.length<2;n++)await Promise.resolve()
  assert.equal(f.imports.length,2)
  assert.match(f.imports[1].uri,/b{64}/)
  f.imports[1].resolve({default:f.implementation('fallback')});await pending
  assert.equal(f.events[0],'cleanup');assert.ok(f.events.includes('enable:fallback'))
  f.loader.disable();assert.equal(f.events.at(-1),'disable:fallback')
})
