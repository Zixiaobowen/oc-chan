import { execFile } from 'node:child_process'
import { constants, lstatSync, unlinkSync, rmdirSync } from 'node:fs'
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const moduleRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const ownerName = 'owner.json'
const nodeExecutable = await realpath(process.execPath)
const protectedApplication = '/Applications/OC Chan.app'
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const limits = { releaseDepth: 5, releaseNodes: 4096, candidates: 32, instances: 64, treeNodes: 30000, treeDepth: 32 }
let registeredOwnerHandle

function requireThat(value, message) { if (!value) throw new Error(message) }
function inside(parent, child) { return child.startsWith(`${parent}${path.sep}`) }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode }
async function command(file, args, cwd = moduleRoot) {
  const { stdout } = await execute(file, args, {
    cwd, encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
  })
  return stdout.trimEnd()
}
async function maybeStat(filename) {
  try { return await lstat(filename) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
function cleanAbsolute(filename) {
  requireThat(typeof filename === 'string' && path.isAbsolute(filename) && !/[\0\r\n]/.test(filename), '路径必须是无控制字符的绝对路径')
  const normalized = path.resolve(filename)
  requireThat(normalized === filename.replace(/\/$/, ''), `拒绝非规范路径：${filename}`)
  return normalized
}
async function realDirectory(directory) {
  cleanAbsolute(directory)
  let current = path.parse(directory).root
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = await lstat(current)
    requireThat(info.isDirectory() && !info.isSymbolicLink(), `目录或祖先是符号链接／非目录：${current}`)
  }
  return lstat(directory)
}
async function workspace(root) {
  root = cleanAbsolute(root)
  await realDirectory(root)
  await realDirectory(moduleRoot)
  const common = async directory => (await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], directory)).trim()
  const reference = await realpath(await common(moduleRoot))
  requireThat(await realpath(await common(root)) === reference, `工作区不属于本仓库：${root}`)
  const records = (await command('git', ['worktree', 'list', '--porcelain', '-z'], moduleRoot)).split('\0')
  requireThat(records.length <= 4096, 'Git 工作区列表超出预算')
  requireThat(records.includes(`worktree ${root}`), `工作区未登记：${root}`)
  requireThat((await command('git', ['rev-parse', '--show-toplevel'], root)).trim() === root, `不是工作区根目录：${root}`)
  return root
}
async function boundedFile(filename, maximum) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    requireThat(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= maximum, `文件身份或字节预算不符：${filename}`)
    const buffer = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    requireThat(offset === before.size && same(before, after) && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `文件读取时发生变化：${filename}`)
    return { bytes: buffer.subarray(0, offset), info: before }
  } finally { await handle.close() }
}
async function bundle(application) {
  requireThat(path.basename(application) === 'OC Chan.app' && application !== protectedApplication, `拒绝非临时 OC Chan 应用：${application}`)
  const info = await realDirectory(application)
  const contents = path.join(application, 'Contents')
  await realDirectory(contents)
  const plist = path.join(contents, 'Info.plist')
  const identity = await boundedFile(plist, 64 * 1024)
  const readKey = key => command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
  requireThat(await readKey('CFBundleIdentifier') === 'local.oc-chan.desktop', `应用 bundle 身份不符：${application}`)
  requireThat(await readKey('CFBundleExecutable') === 'OC Chan', `应用 executable 身份不符：${application}`)
  await realDirectory(path.join(contents, 'MacOS'))
  const executable = path.join(contents, 'MacOS', 'OC Chan')
  const file = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW)
  let executableInfo
  try {
    executableInfo = await file.stat()
    requireThat(executableInfo.isFile() && executableInfo.nlink === 1 && (executableInfo.mode & 0o111) !== 0 && executableInfo.size >= 4, `应用 executable 不是独立可执行文件：${executable}`)
    const magic = Buffer.alloc(4)
    const result = await file.read(magic, 0, 4, 0)
    requireThat(result.bytesRead === 4 && ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex')), `应用 executable 不是 Mach-O：${executable}`)
  } finally { await file.close() }
  const after = await lstat(plist)
  requireThat(same(identity.info, after) && identity.info.mtimeMs === after.mtimeMs && identity.info.ctimeMs === after.ctimeMs, `应用身份读取期间变化：${application}`)
  return { application, info, plist: identity.bytes.toString('base64'), executableInfo }
}
async function releaseApplications(root) {
  const directory = path.join(root, 'release')
  if (!await maybeStat(directory)) return []
  await realDirectory(directory)
  const applications = []
  let nodes = 0
  async function visit(current, depth) {
    requireThat(depth <= limits.releaseDepth, `release 扫描深度超出预算：${current}`)
    const stream = await opendir(current)
    for await (const entry of stream) {
      requireThat(++nodes <= limits.releaseNodes, 'release 扫描节点超出预算')
      const filename = path.join(current, entry.name)
      requireThat(!entry.isSymbolicLink(), `release 中存在符号链接，拒绝清理：${filename}`)
      if (!entry.isDirectory()) continue
      if (entry.name.endsWith('.app')) {
        if (entry.name !== 'OC Chan.app') continue
        requireThat(applications.length < limits.candidates, 'release 应用候选数量超出预算')
        applications.push(await bundle(filename))
      } else {
        requireThat(!['node_modules', '.git', 'src'].includes(entry.name), `release 内包含受保护目录：${filename}`)
        await visit(filename, depth + 1)
      }
    }
  }
  await visit(directory, 0)
  return applications
}
async function processIdentity(pid, root) {
  requireThat(Number.isSafeInteger(pid) && pid > 1, '无效 launcher PID')
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return null
    throw error
  }
  let output
  try { output = await command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], root) } catch (error) {
    try { process.kill(pid, 0) } catch (probe) { if (probe.code === 'ESRCH') return null; throw probe }
    throw error
  }
  const match = output.match(/^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)
  requireThat(match && output.length < 16384, `无法读取 PID ${pid} 启动身份`)
  let cwd, executable
  try {
    if (process.platform === 'darwin') {
      const rows = (await command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd,txt', '-Ffn'], root)).split('\n')
      let field
      const workingDirectories = [], executables = []
      for (const row of rows) {
        if (row.startsWith('f')) field = row.slice(1)
        if (row.startsWith('n') && field === 'cwd') workingDirectories.push(row.slice(1))
        if (row.startsWith('n') && field === 'txt') executables.push(row.slice(1))
      }
      requireThat(workingDirectories.length === 1 && executables.includes(nodeExecutable), `无法确认 PID ${pid} 的 Node executable／工作目录`)
      cwd = workingDirectories[0]
      executable = nodeExecutable
    } else {
      cwd = await readlink(`/proc/${pid}/cwd`)
      executable = await readlink(`/proc/${pid}/exe`)
      requireThat(executable === nodeExecutable, `PID ${pid} 不是同一 Node executable`)
    }
  } catch (error) {
    try { process.kill(pid, 0) } catch (probe) { if (probe.code === 'ESRCH') return null; throw probe }
    throw error
  }
  return { started: match[1].replace(/\s+/g, ' '), command: match[2], cwd, executable }
}
function launcherCommand(value, root) {
  // ps prints unquoted arguments. Accept only the launcher's two documented flags;
  // never accept an arbitrary command merely because it mentions develop.mjs.
  if (typeof value !== 'string') return false
  const scripts = ['scripts/develop.mjs', path.join(root, 'scripts/develop.mjs')]
  return [process.execPath, nodeExecutable, 'node'].some(executable => scripts.some(script => {
    const prefix = `${executable} ${script}`
    if (value === prefix) return true
    if (!value.startsWith(`${prefix} `)) return false
    const flags = value.slice(prefix.length + 1).split(' ')
    return flags.length <= 2 && new Set(flags).size === flags.length && flags.every(flag => ['--window', '--inspect'].includes(flag))
  }))
}
function instancePath(root, instance) {
  cleanAbsolute(instance)
  requireThat(path.dirname(instance) === path.join(root, '.dev-instances') && /^instance-[A-Za-z0-9_-]{1,80}$/.test(path.basename(instance)), `实例路径越界：${instance}`)
}
async function assertOwnerHeld(pid, filename, root) {
  if (process.platform === 'darwin') {
    const rows = (await command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Fpn', '--', filename], root)).split('\n')
    requireThat(rows.includes(`p${pid}`) && rows.includes(`n${filename}`), `launcher 未持有本实例 owner 文件：${filename}`)
    return
  }
  let count = 0, found = false
  for await (const entry of await opendir(`/proc/${pid}/fd`)) {
    requireThat(++count <= 4096, 'launcher 文件描述符超出预算')
    if (await readlink(`/proc/${pid}/fd/${entry.name}`) === filename) found = true
  }
  requireThat(found, `launcher 未持有本实例 owner 文件：${filename}`)
}
export async function registerDevelopmentInstance({ root, instance }) {
  requireThat(!registeredOwnerHandle, '一个 launcher 只能登记一个开发实例')
  root = await workspace(root)
  instancePath(root, instance)
  await realDirectory(instance)
  requireThat(path.resolve(process.argv[1] ?? '') === path.join(root, 'scripts/develop.mjs') && await realpath(process.cwd()) === root, '仅开发 launcher 自身可以登记 owner')
  const identity = await processIdentity(process.pid, root)
  requireThat(identity && identity.cwd === root && launcherCommand(identity.command, root), '开发 launcher 命令／工作目录不符')
  const owner = { schema: 1, root, instance, launcherPID: process.pid, identity }
  const serialized = `${JSON.stringify(owner)}\n`
  requireThat(Buffer.byteLength(serialized) <= 4096, '实例 owner 超出 4 KiB 预算')
  const handle = await open(path.join(instance, ownerName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(serialized) } catch (error) { await handle.close(); throw error }
  // Keep this descriptor until process exit: an owner JSON naming another live
  // launcher cannot authorize SIGTERM unless that launcher holds this exact file.
  registeredOwnerHandle = handle
  return owner
}
async function ownedInstance(root, instance) {
  instancePath(root, instance)
  const info = await realDirectory(instance)
  const file = await boundedFile(path.join(instance, ownerName), 4096)
  const owner = JSON.parse(file.bytes.toString('utf8'))
  requireThat(owner.schema === 1 && owner.root === root && owner.instance === instance && Number.isSafeInteger(owner.launcherPID) && owner.launcherPID > 1 && owner.identity && typeof owner.identity.started === 'string' && owner.identity.started.length > 0 && owner.identity.cwd === root && owner.identity.executable === nodeExecutable && launcherCommand(owner.identity.command, root), `实例 owner 身份不符：${instance}`)
  requireThat(file.info.uid === process.getuid() && (file.info.mode & 0o077) === 0, `实例 owner 权限不符：${instance}`)
  const current = await processIdentity(owner.launcherPID, root)
  requireThat(!current || JSON.stringify(current) === JSON.stringify(owner.identity), `实例 PID 已复用或 owner 身份不符：${instance}`)
  if (current) await assertOwnerHeld(owner.launcherPID, path.join(instance, ownerName), root)
  return { instance, info, owner, ownerBytes: file.bytes.toString('base64'), running: Boolean(current) }
}
async function instances(root) {
  const directory = path.join(root, '.dev-instances')
  if (!await maybeStat(directory)) return []
  await realDirectory(directory)
  const result = []
  let entries = 0
  for await (const entry of await opendir(directory)) {
    requireThat(++entries <= limits.instances, '开发实例数量超出预算')
    requireThat(entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('instance-'), `未知开发实例条目，拒绝清理：${entry.name}`)
    result.push(await ownedInstance(root, path.join(directory, entry.name)))
  }
  return result
}
async function assertInactive(directory, root) {
  const commands = await command('/bin/ps', ['-ww', '-axo', 'pid=,command='], root)
  const rows = commands.split('\n')
  requireThat(rows.length <= 32768, '进程枚举超出预算')
  requireThat(!rows.some(row => row.includes(`${directory}/`) || row.trimEnd().endsWith(directory)), `仍有运行进程引用目录，保留：${directory}`)
  if (process.platform === 'darwin') {
    const files = (await command('/usr/sbin/lsof', ['-nP', '-d', 'txt,cwd', '-Fpn'], root)).split('\n')
    requireThat(files.length <= 65536, '进程文件枚举超出预算')
    requireThat(!files.some(row => row.startsWith('n') && (row.slice(1) === directory || inside(directory, row.slice(1)))), `仍有来自 bundle／实例的运行进程，保留：${directory}`)
  }
}
async function inventory(directory, kind) {
  const entries = []
  async function visit(filename, depth) {
    requireThat(depth <= limits.treeDepth && entries.length < limits.treeNodes, `待清理目录遍历超出预算：${directory}`)
    const info = await lstat(filename)
    if (kind === 'instance' && filename !== directory) {
      const name = path.basename(filename)
      requireThat(!['node_modules', '.git', 'src', 'logs', 'evidence'].includes(name) && !/\.(?:log|zip|dmg)$/i.test(name), `实例包含源码、证据或受保护文件，保留：${filename}`)
    }
    requireThat(info.isDirectory() || info.isFile() || info.isSymbolicLink(), `待清理目录包含特殊文件：${filename}`)
    // Chromium instance locks can point outside the instance. They are leaf
    // entries only: inventory never follows them and deletion uses unlink.
    if (info.isSymbolicLink() && kind === 'application') {
      const target = path.resolve(path.dirname(filename), await readlink(filename))
      requireThat(inside(directory, target), `待清理目录含越界符号链接：${filename}`)
    }
    entries.push({ filename, info })
    if (info.isDirectory()) for await (const entry of await opendir(filename)) await visit(path.join(filename, entry.name), depth + 1)
  }
  await visit(directory, 0)
  return entries
}
function checkAncestors(filename) {
  let current = path.dirname(filename)
  while (true) {
    const info = lstatSync(current)
    requireThat(info.isDirectory() && !info.isSymbolicLink(), `删除前祖先目录变化：${current}`)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
function removeInventory(entries) {
  // No recursive rm: delete only the bounded, inspected entries, rechecking each
  // ancestor and inode. Newly created entries cause rmdir to fail and remain.
  for (const { filename, info } of entries.toReversed()) {
    checkAncestors(filename)
    const current = lstatSync(filename)
    requireThat(same(info, current) && (info.isDirectory() || info.size === current.size && info.mtimeMs === current.mtimeMs && info.ctimeMs === current.ctimeMs), `删除前目录项身份发生变化：${filename}`)
    if (info.isDirectory()) rmdirSync(filename)
    else unlinkSync(filename)
  }
}
async function unregisterApplication(application, root) {
  try {
    await command(lsregister, ['-u', application], root)
    return 'unregistered'
  } catch (error) {
    // kLSApplicationNotFoundErr means this exact path has no registration.
    // NSWorkspace's installed-app list omits registered temporary bundles.
    if (error.code === 1 && error.stdout === '' &&
      error.stderr?.trim() === `failed to scan ${application}: -10814\n from spotlight`) return 'not-registered'
    throw error
  }
}
async function removeApplication(root, expected) {
  await workspace(root)
  const current = await bundle(expected.application)
  requireThat(same(current.info, expected.info) && current.plist === expected.plist && same(current.executableInfo, expected.executableInfo), `删除前应用身份变化：${expected.application}`)
  const entries = await inventory(expected.application, 'application')
  await assertInactive(expected.application, root)
  requireThat(process.platform === 'darwin', '应用清理仅支持 macOS')
  const registration = await unregisterApplication(expected.application, root)
  await assertInactive(expected.application, root)
  const final = await bundle(expected.application)
  requireThat(same(final.info, current.info) && final.plist === current.plist && same(final.executableInfo, current.executableInfo), `注销期间应用身份发生变化：${expected.application}`)
  removeInventory(entries)
  return registration
}
export async function cleanupBuildApplication({ root, application }) {
  root = await workspace(root)
  application = cleanAbsolute(application)
  requireThat(inside(path.join(root, 'release'), application) && application !== protectedApplication, `应用路径不在工作区 release 内：${application}`)
  const parents = path.relative(path.join(root, 'release'), path.dirname(application)).split(path.sep).filter(Boolean)
  requireThat(parents.length <= limits.releaseDepth && parents.every(name => !name.endsWith('.app') && !['node_modules', '.git', 'src'].includes(name)), `应用父目录越界或超出深度预算：${application}`)
  await realDirectory(path.dirname(application))
  const candidate = await bundle(application)
  const registration = await removeApplication(root, candidate)
  return { application, removed: true, registration }
}
async function removeInstance(root, expected) {
  await workspace(root)
  const current = await ownedInstance(root, expected.instance)
  requireThat(same(current.info, expected.info) && current.ownerBytes === expected.ownerBytes, `清理前实例 owner 发生变化：${expected.instance}`)
  if (current.running) {
    requireThat(current.owner.launcherPID !== process.pid, '拒绝停止当前清理进程')
    // A second read immediately before SIGTERM narrows PID reuse / owner races.
    const identity = await processIdentity(current.owner.launcherPID, root)
    requireThat(identity && JSON.stringify(identity) === JSON.stringify(current.owner.identity), '发信号前 launcher 身份发生变化')
    await assertOwnerHeld(current.owner.launcherPID, path.join(expected.instance, ownerName), root)
    process.kill(current.owner.launcherPID, 'SIGTERM')
    const deadline = Date.now() + 20000
    while (true) {
      const waiting = await processIdentity(current.owner.launcherPID, root)
      if (!waiting) break
      requireThat(JSON.stringify(waiting) === JSON.stringify(current.owner.identity), `等待退出期间 PID 身份变化，保留实例：${expected.instance}`)
      requireThat(Date.now() < deadline, `launcher 退出超时，保留实例：${expected.instance}`)
      await delay(100)
    }
  }
  if (!await maybeStat(expected.instance)) return
  const after = await ownedInstance(root, expected.instance)
  requireThat(!after.running && same(after.info, expected.info) && after.ownerBytes === expected.ownerBytes, `退出后实例身份变化：${expected.instance}`)
  const entries = await inventory(expected.instance, 'instance')
  await assertInactive(expected.instance, root)
  const final = await ownedInstance(root, expected.instance)
  requireThat(!final.running && same(final.info, expected.info) && final.ownerBytes === expected.ownerBytes, `删除前实例身份变化：${expected.instance}`)
  removeInventory(entries)
}
export async function cleanupLocalWorktree({ root, apply = false }) {
  requireThat(typeof apply === 'boolean', 'apply 必须是布尔值')
  root = await workspace(root)
  const applications = await releaseApplications(root)
  const owned = await instances(root)
  // Preflight every candidate before any signal, LaunchServices change or deletion.
  for (const candidate of applications) {
    await inventory(candidate.application, 'application')
    await assertInactive(candidate.application, root)
  }
  for (const candidate of owned) {
    if (!candidate.running) {
      await inventory(candidate.instance, 'instance')
      await assertInactive(candidate.instance, root)
    }
  }
  const report = {
    root, apply,
    applications: applications.map(candidate => ({ application: candidate.application, removed: false })),
    instances: owned.map(candidate => ({ instance: candidate.instance, launcherPID: candidate.owner.launcherPID, running: candidate.running, removed: false }))
  }
  if (apply) {
    for (let index = 0; index < owned.length; index++) {
      await removeInstance(root, owned[index])
      report.instances[index].removed = true
    }
    for (let index = 0; index < applications.length; index++) {
      report.applications[index].registration = await removeApplication(root, applications[index])
      report.applications[index].removed = true
    }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  Promise.resolve().then(() => {
    requireThat(args.length === 0 || args.length === 1 && args[0] === '--apply', '用法：node scripts/local-app-lifecycle.mjs [--apply]')
    return cleanupLocalWorktree({ root: moduleRoot, apply: args[0] === '--apply' })
  }).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error('[oc-chan] 本地应用清理失败：', error)
    process.exitCode = 1
  })
}
