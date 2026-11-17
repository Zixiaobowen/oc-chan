import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm, unlink, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SessionLoad } from './session-load.mjs'
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
