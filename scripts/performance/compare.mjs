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
  assert.equal(first.host.arch,second.host.arch);assert.equal(first.host.memoryBytes,second.host.memoryBytes)
  assert.equal(first.seed??first.options.seed,second.options.seed);assert.equal(first.mode??first.options.mode,second.options.mode)
  assert.equal(first.scenario??first.options.scenario,second.options.scenario)
  assert.equal(first.runs.length,second.runs.length,'Repetition count differs')
  const candidateFiles=new Map(candidateFrozen.files.map(file=>[file.path,file.sha256]))
  const alignedRuns=[]
  for(let index=0;index<first.runs.length;index++) {
    const before=first.runs[index],after=second.runs[index]
    assert(before.workload && after.workload,'Missing shared workload contract')
    assert.deepEqual(before.viewport,after.viewport,'Actual CSS viewport or devicePixelRatio differs')
    assert.deepEqual(before.settingsObserved,after.settingsObserved,'Observed theme/language/settings input differs')
    assert.deepEqual(before.workloadExecuted,after.workloadExecuted,'Actual fixture writes/navigation/history/mutation load differs')
    assert.deepEqual(before.workload,after.workload,'Fixture generation or workload configuration differs')
    for(const source of before.workload.sources) assert.equal(source.sha256,candidateFiles.get(path.posix.normalize('scripts/performance/'+source.file)),'Shared fixture implementation differs from frozen candidate')
    assert.equal(before.counters.expected,after.counters.expected,'Actual measured event workload differs')
    if(args['--scenario']==='daily') {
      assert.deepEqual(before.fixtureDiscovery,{sessions:32,processes:4})
      assert.deepEqual(after.fixtureDiscovery,before.fixtureDiscovery)
      assert.equal(before.counters.expected,before.workload.measuredSeconds*32,'Requested event workload was not achieved')
    }
    alignedRuns.push({index,workload:before.workload,fixtureDiscovery:before.fixtureDiscovery,expectedEvents:before.counters.expected})
  }
  const report={schema:2,host:{hostname:os.hostname(),arch:process.arch},order:['baseline','candidate'],baselineProvenance:frozen,candidateProvenance:candidateFrozen,alignedRuns,
    configuredLoad:{mode:args['--mode'],scenario:args['--scenario'],seed:args['--seed']},runs,
    comparison:{totalApplicationCpuRss:'no exclusive-cost improvement claim: compare native descendants and separate birth-verified associated-process samples, explicit coverage gaps and potentially shared XPC cost',
      workloadEquivalence:'Same frozen fixture/session-writer/mutation implementation, seed, real process discovery, isolated HOME, cadence, viewport and measured expected counts are asserted. PID/UUID/absolute dates differ per run; actual host source churn remains observable. Startup build pipelines, CDP versus WK input/driver overhead, watch availability and process attribution coverage differ; no automatic improvement claim.',historicalFiguresUsed:false}}
  await writeFile(path.join(output,'comparison.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600})
}finally{await log.close();for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.off(signal,interrupt)}
console.log(`Sequential comparison: ${output}`)
