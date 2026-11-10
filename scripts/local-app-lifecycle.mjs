import { execFile } from 'node:child_process'
import { constants, lstatSync, openSync, fstatSync, closeSync, unlinkSync, rmdirSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, opendir, readlink, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { compileLocalProcessTool, nativeProcess } from './local-install-readiness.mjs'

const execute = promisify(execFile)
const moduleRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const ownerName = 'owner.json'
const nodeExecutable = await realpath(process.execPath)
const protectedApplication = '/Applications/OC Chan.app'
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const limits = { releaseDepth: 9, releaseNodes: 4096, candidates: 32, instances: 64, treeNodes: 30000, treeDepth: 64 }
let registeredOwnerHandle, registeredOwner, registeredClaimHandle, registeredClaimIdentity, registeredStopped = false, identityToolPromise
async function identityTool() {
  if (!identityToolPromise) identityToolPromise = (async () => {
    const output = path.join(moduleRoot, 'out'); await mkdir(output, { recursive: true, mode: 0o700 }); await realDirectory(output)
    const directory = await mkdtemp(path.join(output, 'process-owner-'))
    return compileLocalProcessTool(moduleRoot, directory)
  })()
  return identityToolPromise
}

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
  requireThat(await readKey('CFBundleExecutable') === 'oc-chan', `应用 executable 身份不符：${application}`)
  await realDirectory(path.join(contents, 'MacOS'))
  const executable = path.join(contents, 'MacOS', 'oc-chan')
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
      if (entry.name === 'source-snapshot') continue
      if (current === path.join(root, 'release/tauri') && entry.name === 'cargo') {
        const application = path.join(filename, 'aarch64-apple-darwin/release/bundle/macos/OC Chan.app')
        if (await maybeStat(application)) { requireThat(applications.length < limits.candidates, 'release 应用候选数量超出预算'); applications.push(await bundle(application)) }
        continue
      }
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
  requireThat(process.platform === 'darwin', '精确开发实例归属需要macOS libproc')
  requireThat(Number.isSafeInteger(pid) && pid > 1, '无效 launcher PID')
  const value = await nativeProcess(await identityTool(), 'inspect', pid)
  if (!value.process) return null
  const { birth_seconds, birth_fraction, executable } = value.process, cwd = value.cwd
  requireThat(Number.isSafeInteger(birth_seconds) && birth_seconds > 0 && Number.isSafeInteger(birth_fraction) && birth_fraction >= 0 && birth_fraction < 1000000 && executable === nodeExecutable, `PID ${pid} 不是同一 Node executable／精确出生身份`)
  let output
  try { output = await command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], root) }
  catch (error) { try { process.kill(pid, 0) } catch (probe) { if (probe.code === 'ESRCH') return null; throw probe }; throw error }
  requireThat(output.length > 0 && output.length < 16384, `无法读取 PID ${pid} 命令`)
  return { birth_seconds, birth_fraction, command: output.trim(), cwd, executable }
}
function launcherCommand(value, root, instance) {
  if (typeof value !== 'string') return false
  const scripts = ['scripts/develop.mjs', path.join(root, 'scripts/develop.mjs')]
  const allowed = new Set(['', '--window', '--no-cleanup', '--window --no-cleanup', '--no-cleanup --window'])
  if (instance) {
    const resume = `--resume-instance ${instance}`
    for (const flags of [[resume], [resume, '--window'], [resume, '--no-cleanup'], [resume, '--no-cleanup', '--window']]) {
      const permutations = values => values.length ? values.flatMap((value, index) => permutations(values.filter((_, at) => at !== index)).map(rest => [value, ...rest])) : [[]]
      for (const order of permutations(flags)) allowed.add(order.join(' '))
    }
  }
  return [process.execPath, nodeExecutable, 'node'].some(executable => scripts.some(script => {
    const prefix = `${executable} ${script}`
    return value === prefix || value.startsWith(`${prefix} `) && allowed.has(value.slice(prefix.length + 1))
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
export async function registerDevelopmentInstance({ root, instance, resume = false }) {
  requireThat(!registeredOwnerHandle && typeof resume === 'boolean', '一个 launcher 只能登记一个开发实例')
  root = await workspace(root); instancePath(root, instance)
  const directoryInfo = await realDirectory(instance)
  requireThat(directoryInfo.uid === process.getuid() && !(directoryInfo.mode & 0o077), '开发实例必须是当前用户的私有目录')
  requireThat(path.resolve(process.argv[1] ?? '') === path.join(root, 'scripts/develop.mjs') && await realpath(process.cwd()) === root, '仅开发 launcher 自身可以登记 owner')
  const identity = await processIdentity(process.pid, root)
  requireThat(identity && identity.cwd === root && launcherCommand(identity.command, root, instance), '开发 launcher 命令／工作目录不符')
  requireThat(resume === process.argv.includes('--resume-instance'), 'resume选项与真实launcher命令不符')
  const owner = { schema: 2, root, instance, launcherPID: process.pid, identity }, serialized = `${JSON.stringify(owner)}\n`
  requireThat(Buffer.byteLength(serialized) <= 4096, '实例 owner 超出4KiB预算')
  const claimPath = path.join(instance, '.resume-claim'), claim = await open(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const claimInfo = await claim.stat(); let handle
  try {
    await claim.writeFile(serialized); await claim.sync()
    let previous
    if (resume) {
      previous = await ownedInstance(root, instance, true)
      requireThat(!previous.running, '旧launcher仍运行，拒绝resume')
      const stopped = await boundedFile(path.join(instance, 'stopped.json'), 8192), evidence = JSON.parse(stopped.bytes.toString('utf8'))
      requireThat(stopped.info.uid === process.getuid() && !(stopped.info.mode & 0o077) && evidence.schema === 1 && JSON.stringify(evidence.owner) === JSON.stringify(previous.owner) && Number.isSafeInteger(evidence.stopped_at_ms), '缺少与旧owner精确匹配的真实排空证据，保留实例')
      await assertInactive(instance, root, process.pid)
    }
    const filename = path.join(instance, resume ? `.owner-next-${process.pid}` : ownerName)
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(serialized); await handle.sync()
    if (resume) {
      const latest = await boundedFile(path.join(instance, ownerName), 4096)
      requireThat(latest.bytes.toString('base64') === previous.ownerBytes && same(await lstat(instance), directoryInfo), 'claim期间旧owner／实例身份发生变化')
      requireThat(!await processIdentity(previous.owner.launcherPID, root), '旧launcher身份重新出现，拒绝替换owner')
      await rename(filename, path.join(instance, ownerName))
    }
    const fd = await open(instance, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await fd.sync() } finally { await fd.close() }
    registeredOwnerHandle = handle; registeredOwner = owner; registeredClaimHandle = claim; registeredClaimIdentity = claimInfo; registeredStopped = false
    return owner
  } catch (error) {
    const errors = [error]
    for (const descriptor of [handle, claim]) if (descriptor) { try { await descriptor.close() } catch (failure) { errors.push(failure) } }
    try { requireThat(same(await lstat(claimPath), claimInfo), '注册失败时claim身份改变，保留现场'); await unlink(claimPath) } catch (failure) { errors.push(failure) }
    throw errors.length === 1 ? error : new AggregateError(errors, 'Development registration and claim cleanup failed')
  }
}
export async function markDevelopmentInstanceStopped({ root, instance }) {
  root = await workspace(root); instancePath(root, instance)
  requireThat(registeredOwnerHandle && registeredClaimHandle && registeredOwner.root === root && registeredOwner.instance === instance, '只能标记本launcher持有的实例')
  requireThat(JSON.stringify(await processIdentity(process.pid, root)) === JSON.stringify(registeredOwner.identity), '标记排空前launcher身份变化')
  await assertOwnerHeld(process.pid, path.join(instance, ownerName), root)
  await assertInactive(instance, root, process.pid)
  const temporary = path.join(instance, `.stopped-next-${process.pid}`), handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(`${JSON.stringify({ schema: 1, owner: registeredOwner, stopped_at_ms: Date.now() })}\n`); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path.join(instance, 'stopped.json'))
  const directory = await open(instance, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
  const claimPath = path.join(instance, '.resume-claim')
  requireThat(same(await lstat(claimPath), registeredClaimIdentity), '排空后claim身份变化，拒绝释放')
  await unlink(claimPath); await registeredClaimHandle.close(); registeredClaimHandle = undefined
  registeredStopped = true
}
async function ownedInstance(root, instance, allowClaim = false) {
  instancePath(root, instance)
  const info = await realDirectory(instance)
  const file = await boundedFile(path.join(instance, ownerName), 4096)
  const owner = JSON.parse(file.bytes.toString('utf8'))
  requireThat(info.uid === process.getuid() && !(info.mode & 0o077), `实例目录权限不符：${instance}`)
  requireThat(owner.schema === 2 && owner.root === root && owner.instance === instance && Number.isSafeInteger(owner.launcherPID) && owner.launcherPID > 1 && owner.identity && Number.isSafeInteger(owner.identity.birth_seconds) && owner.identity.birth_seconds > 0 && Number.isSafeInteger(owner.identity.birth_fraction) && owner.identity.birth_fraction >= 0 && owner.identity.birth_fraction < 1000000 && owner.identity.cwd === root && owner.identity.executable === nodeExecutable && launcherCommand(owner.identity.command, root, instance), `实例 owner 身份不符：${instance}`)
  requireThat(file.info.uid === process.getuid() && (file.info.mode & 0o077) === 0, `实例 owner 权限不符：${instance}`)
  const current = await processIdentity(owner.launcherPID, root)
  requireThat(!current || JSON.stringify(current) === JSON.stringify(owner.identity), `实例 PID 已复用或 owner 身份不符：${instance}`)
  if (current) await assertOwnerHeld(owner.launcherPID, path.join(instance, ownerName), root)
  let claimed = false
  if (!allowClaim && await maybeStat(path.join(instance, '.resume-claim'))) {
    const claim = await boundedFile(path.join(instance, '.resume-claim'), 4096), holder = JSON.parse(claim.bytes.toString('utf8'))
    requireThat(claim.info.uid === process.getuid() && !(claim.info.mode & 0o077) && JSON.stringify(holder) === JSON.stringify(owner), '实例claim身份不符，拒绝清理')
    if (current) { await assertOwnerHeld(owner.launcherPID, path.join(instance, '.resume-claim'), root); claimed = true }
  }
  return { instance, info, owner, ownerBytes: file.bytes.toString('base64'), running: Boolean(current), claimed }
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
async function assertInactive(directory, root, excludePID) {
  const commands = await command('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,command='], root)
  const rows = commands.split('\n'); requireThat(rows.length <= 32768, '进程枚举超出预算')
  const processes = rows.map(row => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row)).filter(Boolean)
  const excluded = new Set()
  if (excludePID !== undefined) {
    requireThat(excludePID === process.pid, '只能排除当前launcher及其真实祖先进程')
    const parents = new Map(processes.map(row => [Number(row[1]), Number(row[2])]))
    let pid = excludePID
    while (pid > 1) { requireThat(!excluded.has(pid) && excluded.size < 64 && parents.has(pid), 'launcher父进程链不完整'); excluded.add(pid); pid = parents.get(pid) }
  }
  requireThat(!processes.some(row => !excluded.has(Number(row[1])) && (row[3].includes(`${directory}/`) || row[3].includes(`${directory} `) || row[3].endsWith(directory))), `仍有运行进程引用目录，保留：${directory}`)
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
    // Private instance symlinks are leaf entries. Never follow a link during
    // inventory or deletion, including system-managed WebKit state links.
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
function unchangedMetadata(a, b) {
  return same(a, b) && a.uid === b.uid && a.gid === b.gid && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink
}
function checkAncestors(filename, inspected) {
  let current = path.dirname(filename)
  while (true) {
    const info = lstatSync(current), expected = inspected.get(current)
    requireThat(info.isDirectory() && !info.isSymbolicLink() && (!expected || same(expected, info) && expected.uid === info.uid && expected.gid === info.gid), `删除前祖先目录变化：${current}`)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
function removeInventory(entries) {
  const inspected = new Map(entries.map(({ filename, info }) => [filename, info])), inodes = new Map()
  // Validate the complete snapshot before the first unlink. Reading directories
  // changes atime only; ctime/nlink changes here cannot come from our cleanup.
  for (const { filename, info } of entries) {
    checkAncestors(filename, inspected)
    requireThat(unchangedMetadata(info, lstatSync(filename)), `删除前目录项身份发生变化：${filename}`)
    if (!info.isFile()) continue
    const key = `${info.dev}:${info.ino}`, inode = inodes.get(key)
    if (inode) {
      requireThat(unchangedMetadata(inode.info, info), `遍历期间硬链接身份发生变化：${filename}`)
      inode.remaining++
    } else inodes.set(key, { info, remaining: 1 })
  }
  for (const inode of inodes.values()) requireThat(inode.remaining <= inode.info.nlink, '硬链接数量与遍历身份不符')
  // No recursive rm: every path and ancestor keeps its inspected inode/type.
  // Parent directory timestamps change as children are removed. Rust incremental
  // files also share inodes: unlinking one alias changes every alias's ctime/nlink.
  for (const { filename, info } of entries.toReversed()) {
    checkAncestors(filename, inspected)
    const current = lstatSync(filename), inode = info.isFile() ? inodes.get(`${info.dev}:${info.ino}`) : undefined
    requireThat(info.isDirectory()
      ? same(info, current) && info.uid === current.uid && info.gid === current.gid
      : unchangedMetadata(inode?.info ?? info, current), `删除前目录项身份发生变化：${filename}`)
    if (info.isDirectory()) { rmdirSync(filename); continue }
    if (!inode || inode.remaining === 1) { unlinkSync(filename); continue }
    // Pin the inode across our unlink, accepting only its single link decrement.
    // The resulting ctime becomes the exact baseline for the next inspected alias;
    // arbitrary later metadata changes still fail instead of being ignored.
    const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      requireThat(unchangedMetadata(current, fstatSync(descriptor)), `打开硬链接时身份发生变化：${filename}`)
      unlinkSync(filename)
      const after = fstatSync(descriptor)
      requireThat(same(current, after) && current.uid === after.uid && current.gid === after.gid && current.size === after.size && current.mtimeMs === after.mtimeMs && after.nlink === current.nlink - 1 && after.ctimeMs >= current.ctimeMs, `删除硬链接时身份发生变化：${filename}`)
      inode.info = after; inode.remaining--
    } finally { closeSync(descriptor) }
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
  requireThat(parents.length <= limits.releaseDepth && parents.every(name => !name.endsWith('.app') && !['node_modules', '.git', 'src', 'source-snapshot'].includes(name)), `应用父目录越界或超出深度预算：${application}`)
  await realDirectory(path.dirname(application))
  const candidate = await bundle(application)
  const registration = await removeApplication(root, candidate)
  return { application, removed: true, registration }
}
async function removeInstance(root, expected) {
  await workspace(root)
  const current = await ownedInstance(root, expected.instance)
  requireThat(!current.claimed, '实例仍被活跃独占claim持有，拒绝清理')
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
  const stopped = await boundedFile(path.join(expected.instance, 'stopped.json'), 8192), evidence = JSON.parse(stopped.bytes.toString('utf8'))
  requireThat(stopped.info.uid === process.getuid() && !(stopped.info.mode & 0o077) && evidence.schema === 1 && JSON.stringify(evidence.owner) === JSON.stringify(after.owner) && Number.isSafeInteger(evidence.stopped_at_ms), '清理前缺少与owner匹配的真实排空证据，保留实例')
  const entries = await inventory(expected.instance, 'instance')
  await assertInactive(expected.instance, root)
  const final = await ownedInstance(root, expected.instance)
  requireThat(!final.running && same(final.info, expected.info) && final.ownerBytes === expected.ownerBytes, `删除前实例身份变化：${expected.instance}`)
  removeInventory(entries)
}
export async function cleanupStoppedDevelopmentInstance({ root, instance }) {
  root = await workspace(root); instancePath(root, instance)
  requireThat(registeredStopped && registeredOwnerHandle && !registeredClaimHandle && registeredOwner.root === root && registeredOwner.instance === instance && registeredOwner.launcherPID === process.pid, '仅允许已真实mark且仍持有owner的当前launcher清理自身')
  const candidate = await ownedInstance(root, instance)
  requireThat(candidate.running && !candidate.claimed && JSON.stringify(candidate.owner) === JSON.stringify(registeredOwner), '当前launcher owner／claim身份变化')
  const stopped = await boundedFile(path.join(instance, 'stopped.json'), 8192), evidence = JSON.parse(stopped.bytes.toString('utf8'))
  requireThat(stopped.info.uid === process.getuid() && !(stopped.info.mode & 0o077) && evidence.schema === 1 && JSON.stringify(evidence.owner) === JSON.stringify(registeredOwner), '当前launcher缺少匹配的stopped证据')
  const entries = await inventory(instance, 'instance')
  await assertInactive(instance, root, process.pid)
  const final = await ownedInstance(root, instance)
  requireThat(final.running && !final.claimed && same(final.info, candidate.info) && final.ownerBytes === candidate.ownerBytes, '自清理前实例身份变化')
  removeInventory(entries)
  await registeredOwnerHandle.close(); registeredOwnerHandle = undefined
  return { instance, removed: true }
}
export async function cleanupDevelopmentInstance({ root, instance }) {
  root = await workspace(root); const candidate = await ownedInstance(root, instance)
  requireThat(!candidate.running, '单实例清理拒绝仍运行的launcher')
  await assertInactive(instance, root); await removeInstance(root, candidate)
  return { instance, removed: true }
}
export async function cleanupLocalWorktree({ root, apply = false }) {
  requireThat(typeof apply === 'boolean', 'apply 必须是布尔值')
  root = await workspace(root)
  const applications = await releaseApplications(root)
  const owned = await instances(root)
  requireThat(!apply || owned.every(candidate => !candidate.claimed), '实例仍被活跃独占claim持有，拒绝清理')
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
