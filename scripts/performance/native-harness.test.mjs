import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm, unlink, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { AssociatedProcesses } from './xpc.mjs'
import { SessionLoad } from './session-load.mjs'
import { performancePlugin, smokePlugin } from './vite-plugin.mjs'
import { now } from './core.mjs'

const entry = (role,pid=22) => ({role,pid,startSeconds:100,startMicroseconds:4})
const observation = (view, entries=[entry('web')], unavailable=[]) => ({view,processes:{scope:'instance-associated processes; may be shared',entries,unavailable,notRunning:['web','provisionalWeb','gpu','network'].filter(role=>!entries.some(item=>item.role===role)&&!unavailable.some(item=>item.role===role))}})
const processRow = (pid,startId='100:000004') => ({pid,startId,rssBytes:1024**2,cpuNs:1000000,fdCount:2,associationAgeMs:10,sampleErrors:{identity:0,taskInfo:0,descriptors:0}})
const resources = (associated, monotonicMs=1000) => ({type:'resources',monotonicMs,app:[processRow(11)],development:[],associated,coverage:{complete:true}})

test('associated shared process is deduplicated across roles and actual windows',()=>{
  const value=new AssociatedProcesses('shared')
  const observed=value.update([observation('main',[entry('web'),entry('gpu')]),observation('tray',[entry('web')])])
  assert.equal(observed.identities.length,1);assert.deepEqual(observed.identities[0].views,['main','tray'])
  value.resources(resources([processRow(22)]))
  assert.equal(value.result().measurement.applicationRssMiB.mean,2)
})
test('unknown or expired XPC evidence never creates a zero-memory full sample',()=>{
  const unknown=new AssociatedProcesses('unknown')
  unknown.update([observation('main',[],[{role:'web',reason:'permission denied'}])])
  unknown.resources(resources([]))
  assert.equal(unknown.result().measurement.applicationRssMiB.count,0);assert.equal(unknown.incompleteSamples,1)
  const expired=new AssociatedProcesses('expired');expired.update([observation('main')],now()-3000);expired.resources(resources([processRow(22)]))
  assert.equal(expired.result().measurement.applicationRssMiB.count,0)
})
test('PID reuse, sampler lease failure and absent role evidence remain coverage gaps',()=>{
  const value=new AssociatedProcesses('reused');value.update([observation('main')]);value.resources(resources([processRow(22,'101:000004')]))
  assert.equal(value.incompleteSamples,1)
  value.resources(resources([{...processRow(22),rssBytes:null,sampleErrors:{identity:116}}],2000))
  assert.equal(value.incompleteSamples,2)
  assert.throws(()=>value.update([{view:'main',processes:{...observation('main').processes,notRunning:[]}}]),/omitted/)
})
test('release Vite config emits no performance transforms and flagged nonisolated build is rejected',()=>{
  const previous={flag:process.env.OC_CHAN_PERFORMANCE,instance:process.env.OC_CHAN_DEV_INSTANCE,headless:process.env.OC_CHAN_HEADLESS}
  try{
    delete process.env.OC_CHAN_PERFORMANCE;assert.deepEqual(performancePlugin(),[])
    process.env.OC_CHAN_PERFORMANCE='1';delete process.env.OC_CHAN_DEV_INSTANCE
    assert.throws(()=>performancePlugin(),/isolated headless/)
  }finally{
    for(const [key,value]of[['OC_CHAN_PERFORMANCE',previous.flag],['OC_CHAN_DEV_INSTANCE',previous.instance],['OC_CHAN_HEADLESS',previous.headless]]){if(value===undefined)delete process.env[key];else process.env[key]=value}
  }
})
test('release excludes smoke hooks and explicit smoke builds require an isolated headless instance',()=>{
  const previous={flag:process.env.OC_CHAN_SMOKE,instance:process.env.OC_CHAN_DEV_INSTANCE,headless:process.env.OC_CHAN_HEADLESS}
  const instance=fileURLToPath(new URL('../../.dev-instances/test-smoke',import.meta.url))
  try{
    delete process.env.OC_CHAN_SMOKE
    assert.deepEqual(smokePlugin(),[])
    process.env.OC_CHAN_SMOKE='0'
    assert.deepEqual(smokePlugin(),[])
    process.env.OC_CHAN_SMOKE='1';process.env.OC_CHAN_HEADLESS='1'
    delete process.env.OC_CHAN_DEV_INSTANCE
    assert.throws(()=>smokePlugin(),/isolated headless/)
    process.env.OC_CHAN_DEV_INSTANCE=path.join(os.tmpdir(),'test-smoke')
    assert.throws(()=>smokePlugin(),/isolated headless/)
    process.env.OC_CHAN_DEV_INSTANCE=path.join(instance,'nested')
    assert.throws(()=>smokePlugin(),/isolated headless/)
    process.env.OC_CHAN_DEV_INSTANCE=instance
    delete process.env.OC_CHAN_HEADLESS
    assert.throws(()=>smokePlugin(),/isolated headless/)
    process.env.OC_CHAN_HEADLESS='0'
    assert.throws(()=>smokePlugin(),/isolated headless/)
    process.env.OC_CHAN_HEADLESS='1'
    assert.equal(smokePlugin().length,1)
  }finally{
    for(const [key,value]of[['OC_CHAN_SMOKE',previous.flag],['OC_CHAN_DEV_INSTANCE',previous.instance],['OC_CHAN_HEADLESS',previous.headless]]){if(value===undefined)delete process.env[key];else process.env[key]=value}
  }
})
test('real session writer preserves headers and inode ownership across rotation, rejects replacement symlink',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'oc-perf-load-test-'))
  try{
    const files=Array.from({length:32},(_,i)=>path.join(directory,`${i}.jsonl`))
    const header=JSON.stringify({type:'session',id:'test'})+'\n'
    for(const file of files)await writeFile(file,header,{flag:'wx',mode:0o600})
    const writer=new SessionLoad({agentFiles:files});await writer.initialize();await writer.write(32,1)
    const rows=(await readFile(files[3],'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows[1].data.toolName,'perf_3_1');assert.equal(rows[0].type,'session')
    await writer.rotate();assert.equal(await readFile(files[3],'utf8'),header)
    await unlink(files[0]);await symlink(files[1],files[0]);await assert.rejects(writer.write(32,2))
  }finally{await rm(directory,{recursive:true,force:true})}
})
