// Run the separately prepared, provenance-reviewed detached baseline first.
// Neither this script nor its children write to the original source workspace.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { EvidenceLog, readLines } from './core.mjs'
const exec=promisify(execFile),args={ '--mode':'smoke','--scenario':'daily','--seed':'20261104' }
for(let i=2;i<process.argv.length;i+=2) { assert(['--baseline-root','--baseline-commit','--candidate-root','--out','--mode','--scenario','--seed'].includes(process.argv[i]) && process.argv[i+1]); args[process.argv[i]]=process.argv[i+1] }
assert(args['--baseline-root'] && args['--out'] && /^[a-f0-9]{40}$/.test(args['--baseline-commit']??''))
assert(['startup','idle','daily'].includes(args['--scenario']), 'Sequential baseline comparison requires an aligned startup/idle/daily scenario')
const baseline=await realpath(args['--baseline-root']),candidate=await realpath(args['--candidate-root']??fileURLToPath(new URL('../..',import.meta.url)))
const output=path.resolve(args['--out'])
assert(baseline!==candidate && !baseline.startsWith(candidate+path.sep),'Baseline must be an external frozen worktree')
const git=async (params,cwd=baseline)=>(await exec('git',params,{cwd,timeout:30000,maxBuffer:8*1024*1024})).stdout
assert.equal((await git(['rev-parse','HEAD'])).trim(),args['--baseline-commit'],'Reviewed baseline commit changed')
assert.equal((await git(['branch','--show-current'])).trim(),'','Baseline must be a separately prepared detached worktree')
const generatedDirectories = ['node_modules', '.dev-instances', 'out', 'release', 'docs/rust-migration/evidence']
const sourcePathspec = ['.', ...generatedDirectories.map(directory => `:(top,exclude)${directory}`)]
async function provenance(root) {
  const names=[...new Set((await git(['ls-files','--cached','--others','--exclude-standard','-z','--',...sourcePathspec],root)).split('\0').filter(Boolean))].sort(),files=[]
  assert(names.length<=8192)
  for(const name of names) {
    assert(!path.isAbsolute(name) && !name.split(path.sep).includes('..'))
    const target=path.join(root,name)
    if(target.startsWith(output+path.sep))continue
    let stat
    try{stat=await lstat(target)}catch(error){if(error.code==='ENOENT'){files.push({path:name,deleted:true});continue}throw error}
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size<=32*1024*1024)
    files.push({path:name,bytes:stat.size,sha256:createHash('sha256').update(await readFile(target)).digest('hex')})
  }
  return {root,commit:(await git(['rev-parse','HEAD'],root)).trim(),status:await git(['status','--porcelain'],root),generatedDirectories,files,digest:createHash('sha256').update(JSON.stringify(files)).digest('hex')}
}
const frozen=await provenance(baseline),candidateFrozen=await provenance(candidate);await mkdir(output,{mode:0o700})
const log=new EvidenceLog(path.join(output,'launcher'),{maxBytes:8*1024*1024});await log.initialize()
let active,failure
const interrupt=()=>{failure??=new Error('Sequential comparison interrupted');active?.kill('SIGTERM')}
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.once(signal,interrupt)
const runs=[]
try{
  for(const [label,cwd]of[['baseline',baseline],['candidate',candidate]]){
    if(failure)throw failure
    assert.equal((await provenance(baseline)).digest,frozen.digest,'Baseline source changed before a comparison stage')
    assert.equal((await provenance(candidate)).digest,candidateFrozen.digest,'Candidate/shared fixture source changed before a comparison stage')
    const out=path.join(output,label),startedAt=new Date().toISOString()
    const child=active=spawn(process.execPath,['scripts/performance/run.mjs','--mode',args['--mode'],'--scenario',args['--scenario'],'--seed',args['--seed'],'--sampler','user','--out',out],{cwd,env:{...process.env,OC_CHAN_HEADLESS:'1',OC_CHAN_COMPARE_CANDIDATE:candidate},stdio:['ignore','pipe','pipe']})
    const fail=error=>{failure??=error;child.kill('SIGTERM')}
    readLines(child.stdout,line=>{void log.append([label,'stdout',line]).catch(fail)},fail)
    readLines(child.stderr,line=>{void log.append([label,'stderr',line]).catch(fail)},fail)
    const completion=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))})
    active=null;if(failure)throw failure
    assert.equal(completion.code,0,`${label} failed; candidate will not overlap or start after a failed baseline`)
    const report=JSON.parse(await readFile(path.join(out,'result.json'),'utf8'));assert.equal(report.complete,true)
    runs.push({label,root:cwd,startedAt,finishedAt:new Date().toISOString(),result:report})
  }
  assert.equal((await provenance(baseline)).digest,frozen.digest,'Baseline source changed during comparison')
  assert.equal((await provenance(candidate)).digest,candidateFrozen.digest,'Candidate/shared fixture source changed during comparison')
  const first=runs[0].result,second=runs[1].result
  assert.equal(first.schema,4,'Baseline must use the same native GPUI measurement contract')
  assert.equal(second.schema,4)
  assert.equal(first.renderer,'gpui');assert.equal(second.renderer,'gpui')
  assert.equal(first.host.arch,second.host.arch);assert.equal(first.host.memoryBytes,second.host.memoryBytes)
  for(const key of ['mode','scenario','seed','sampler'])assert.equal(first.options[key],second.options[key])
  assert.deepEqual(first.scope,second.scope,'Measurement coverage differs')
  assert.equal(first.runs.length,second.runs.length,'Repetition count differs')
  const alignedRuns=first.runs.map((before,index)=>{
    const after=second.runs[index]
    assert.equal(before.scenario,after.scenario)
    assert.equal(before.navigationCommands,after.navigationCommands,'Actual navigation workload differs')
    assert.deepEqual(before.workload,after.workload,'Actual session writes, bytes, rotations or schedule mutations differ')
    assert.deepEqual(before.native,after.native,'Actual native viewport or visibility differs')
    return {index,scenario:before.scenario,navigationCommands:before.navigationCommands,workload:before.workload}
  })
  const report={schema:3,host:{hostname:os.hostname(),arch:process.arch},order:['baseline','candidate'],baselineProvenance:frozen,candidateProvenance:candidateFrozen,alignedRuns,
    configuredLoad:{mode:args['--mode'],scenario:args['--scenario'],seed:args['--seed']},runs,
    comparison:{scope:'Observed native GPUI host and descendants only; actual host source activity can differ between runs. Missing resource fields and CPU intervals remain explicit. No automatic performance improvement claim.',historicalFiguresUsed:false}}
  await writeFile(path.join(output,'comparison.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600})
}finally{await log.close();for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.off(signal,interrupt)}
console.log(`Sequential comparison: ${output}`)
