import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const comparisonSettings = Object.freeze({ appearance:'light', language:'zh-CN', textSize:'default', uiFont:'system', codeFont:'system', showDock:false, preventSleep:false })

// Both runners import this exact module and the exact fixture implementations.
// UUIDs, process identities and absolute dates are run-local; topology and relative
// schedule/history ages, file generation, event encoding and mutation seeds match.
export async function comparisonWorkload({ level, mode, scenario, seed }) {
  if (!['startup','idle','daily'].includes(scenario)) return null
  const files = ['../smoke/main-probe.mjs','./fixtures.mjs','./session-load.mjs','./comparison-workload.mjs','./core.mjs']
  const sources = []
  for (const file of files) sources.push({ file, sha256:createHash('sha256').update(await readFile(new URL(file,import.meta.url))).digest('hex') })
  const full = mode === 'baseline', daily = scenario === 'daily'
  return {
    schema:1, scenario, level, mode, seed:String(seed), sources,
    settings:comparisonSettings,
    home:level === 'L0' ? 'new empty isolated HOME' : 'new isolated HOME from shared prepareSmokeFixtures',
    discovery:'production process enumeration and descriptor/session ownership; no discovery replacement',
    sessions:daily ? 32 : 0, fixtureProcesses:daily ? 4 : 0,
    plistFiles:daily ? 1000 : 0, hermesJobs:daily ? 100 : 0, historyRows:daily ? 10000 : 0,
    hostSources:'actual host system directories, launchctl and crontab; read-only; no fixture virtual modules',
    repetitions:scenario === 'startup' ? full ? 10 : 1 : daily ? full ? 5 : 1 : 1,
    warmupSeconds:scenario === 'startup' ? 0 : full ? 120 : 2,
    warmupEventsHz:daily ? 1 : 0, warmupNavigation:false, warmupMutations:false,
    measuredSeconds:daily ? full ? 600 : 8 : scenario === 'idle' ? full ? 60 : 2 : 0,
    visibilityPhases:scenario === 'idle' ? ['main','tray','neither'] : ['main-and-tray'],
    eventHz:daily ? 1 : 0, eventEncoding:'SessionLoad tool_execution_start perf_<index>_<sequence>',
    navigationEverySeconds:daily ? 15 : null, navigation:['agents','schedules','system','overview'],
    historyQuery:'first fixture Hermes job, offset 0, 25 entries, on schedules navigation',
    mutateEverySeconds:daily ? 60 : null, mutatedPlistsPerBatch:daily ? 100 : 0,
    drainSeconds:daily ? 2 : 0,
    systemPlugin:daily ? 'install and refresh after initial interactive milestone, before warmup' : 'not installed',
    viewport:{main:[1280,860],tray:[380,560],scale:'native host backing scale; observed equality required'}
  }
}

export async function alignViewport(view, width, height) {
  let nativeWidth=width, nativeHeight=height
  for(let attempt=0;attempt<3;attempt++) {
    await view.resize(nativeWidth,nativeHeight)
    const actual=await view.evaluate('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})')
    if(!Number.isFinite(actual.width) || !Number.isFinite(actual.height) || !(actual.scale>0)) throw new Error('Invalid measured CSS viewport')
    if(actual.width===width && actual.height===height) return actual
    nativeWidth+=width-actual.width;nativeHeight+=height-actual.height
  }
  throw new Error('Unable to establish requested CSS viewport within three native resizes')
}

export async function observedSettings(view) {
  const keys=Object.keys(comparisonSettings)
  const snapshot=await view.evaluate(`window.desktopSettings.snapshot().then(value=>({settings:Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,value.settings[key]])),resolvedTheme:value.resolvedTheme,resolvedLanguage:value.resolvedLanguage}))`)
  for(const key of keys) if(snapshot.settings[key]!==comparisonSettings[key]) throw new Error('Comparison settings mismatch: '+key)
  return snapshot
}
