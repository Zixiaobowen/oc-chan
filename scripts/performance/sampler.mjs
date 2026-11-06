import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { finished } from 'node:stream/promises'

const handshakeLimit = 4096
const authorizationTimeout = 120000
const exitTimeout = 5000

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child) {
  if (exited(child) || !child.pid) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve() }
    const timer = setTimeout(() => {
      child.off('exit', done)
      reject(new Error(`Sampler process ${child.pid} did not exit within ${exitTimeout}ms`))
    }, exitTimeout)
    child.once('exit', done)
  })
}

function ready(stream, validate, signal) {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0)
    const finish = (error, identity) => {
      stream.off('readable', consume)
      stream.off('end', ended)
      stream.off('error', failed)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(identity)
    }
    const ended = () => finish(new Error('Sampler closed before its ready handshake'))
    const failed = error => finish(error)
    const aborted = () => finish(signal.reason)
    const consume = () => {
      let chunk
      while ((chunk = stream.read()) !== null) {
        const newline = chunk.indexOf(10)
        const length = newline < 0 ? chunk.length : newline
        if (pending.length + length > handshakeLimit) return finish(new Error('Sampler handshake exceeded 4 KiB'))
        pending = Buffer.concat([pending, chunk.subarray(0, length)])
        if (newline < 0) continue
        try {
          const identity = JSON.parse(pending.toString('utf8'))
          validate(identity)
          if (newline + 1 < chunk.length) stream.unshift(chunk.subarray(newline + 1))
          finish(null, identity)
        } catch (error) { finish(error) }
        return
      }
    }
    stream.on('readable', consume)
    stream.once('end', ended)
    stream.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else consume()
  })
}

// Arguments are AppleScript argv values; quoted form performs shell quoting once.
const authorizationScript = `on run argv
  set commandText to "exec " & quoted form of (item 1 of argv) & " --connect " & quoted form of (item 2 of argv) & " " & quoted form of (item 3 of argv) & " " & quoted form of (item 4 of argv)
  with timeout of 172800 seconds
    do shell script commandText with administrator privileges
  end timeout
end run`

export async function startSampler(binary, { privilege, signal } = {}) {
  if (!['user', 'admin'].includes(privilege)) throw new Error('Sampler privilege must explicitly be user or admin')
  if (process.platform !== 'darwin') throw new Error('The process sampler requires macOS')
  if (process.getuid() === 0 || process.geteuid() === 0) throw new Error('The measurement runner must run as an ordinary user')
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || /[\0\r\n]/.test(binary)) throw new Error('Sampler binary must be an absolute executable path')
  signal?.throwIfAborted()

  const startup = new AbortController()
  let child, socket, server, directory, input, output, errors, identity, disposal, cleanup
  let firstFailure, returned = false, stopping = false
  const nonce = privilege === 'admin' ? randomBytes(32).toString('hex') : null
  const timer = setTimeout(() => startup.abort(new Error(`Sampler ${privilege} startup timed out`)), privilege === 'admin' ? authorizationTimeout : 10000)
  const onProcessExit = () => {
    // Only this invocation's private directory; the OS closes the socket on exit.
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
  process.once('exit', onProcessExit)

  const cleanupFiles = () => {
    cleanup ??= (async () => {
      if (server?.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
      if (directory) await rm(directory, { recursive: true, force: true })
      process.off('exit', onProcessExit)
      signal?.removeEventListener('abort', onAbort)
    })()
    return cleanup
  }
  const dispose = () => {
    disposal ??= (async () => {
      stopping = true
      clearTimeout(timer)
      const failures = []
      if (!firstFailure) {
        output?.resume()
        if (input?.writable && !input.destroyed && child && !exited(child)) input.end('stop\n')
      } else if (socket) socket.destroy()
      else input?.destroy()
      if (child && !exited(child)) {
        try { await waitForExit(child) }
        catch (error) {
          failures.push(error)
          child.kill('SIGTERM')
          try { await waitForExit(child) }
          catch (failure) {
            failures.push(failure)
            child.kill('SIGKILL')
            try { await waitForExit(child) } catch (lastFailure) { failures.push(lastFailure) }
          }
        }
      }
      if (!firstFailure && output && !output.destroyed) {
        try {
          await finished(output, { readable: true, writable: false, cleanup: true, signal: AbortSignal.timeout(exitTimeout) })
        } catch (error) { failures.push(error) }
      }
      socket?.destroy()
      if (!socket) input?.destroy()
      try { await cleanupFiles() } catch (error) { failures.push(error) }
      if (firstFailure) failures.unshift(firstFailure)
      if (child && exited(child) && (child.exitCode !== 0 || child.signalCode))
        failures.push(new Error(`Sampler process failed: ${child.signalCode ?? child.exitCode}`))
      if (failures.length) throw new AggregateError(failures, failures.map(String).join('; '))
    })()
    return disposal
  }
  const fail = error => {
    firstFailure ??= error
    if (!startup.signal.aborted) startup.abort(error)
    if (returned && !stopping) {
      // The stream consumer and dispose both receive asynchronous transport errors.
      output?.destroy(error)
      void dispose().catch(failure => { firstFailure = failure })
    }
  }
  const onAbort = () => {
    fail(signal.reason instanceof Error ? signal.reason : new Error('Sampler cancelled'))
    socket?.destroy()
    if (child && !exited(child)) child.kill('SIGTERM')
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let connection
    if (privilege === 'admin') {
      // Keep the Unix path below macOS's 104-byte sockaddr_un limit.
      directory = await mkdtemp('/tmp/oc-chan-sampler-')
      await chmod(directory, 0o700)
      startup.signal.throwIfAborted()
      server = net.createServer()
      server.maxConnections = 1
      server.on('error', fail)
      connection = new Promise((resolve, reject) => {
        const aborted = () => { server.off('connection', connected); reject(startup.signal.reason) }
        const connected = stream => {
          startup.signal.removeEventListener('abort', aborted)
          socket = stream
          socket.on('error', fail)
          resolve(stream)
        }
        server.once('connection', connected)
        startup.signal.addEventListener('abort', aborted, { once: true })
      })
      // Observe early cancellation while listen/chmod is still pending.
      connection.catch(() => {})
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', listening); reject(error) }
        const listening = () => { server.off('error', failed); resolve() }
        server.once('error', failed)
        server.once('listening', listening)
        server.listen(path.join(directory, 'sampler.sock'))
      })
      await chmod(path.join(directory, 'sampler.sock'), 0o600)
      startup.signal.throwIfAborted()
      child = spawn('/usr/bin/osascript', ['-e', authorizationScript, binary, path.join(directory, 'sampler.sock'), String(process.pid), nonce], { stdio: ['ignore', 'pipe', 'pipe'] })
    } else {
      child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      input = child.stdin
      output = child.stdout
      input.on('error', fail)
      output.on('error', fail)
    }
    errors = child.stderr
    errors.on('error', fail)
    child.once('error', fail)
    child.once('exit', (code, signalCode) => {
      if (!returned || (!stopping && (code !== 0 || signalCode)))
        fail(new Error(`Sampler process exited: ${signalCode ?? code}`))
    })
    const stderr = () => {
      const chunk = errors.read()
      if (!chunk) return
      if (chunk.length > handshakeLimit) fail(new Error('Sampler startup diagnostics exceeded 4 KiB'))
      else fail(new Error(chunk.toString('utf8').trim() || 'Sampler startup failed'))
    }
    errors.on('readable', stderr)
    try {
      if (connection) {
        input = output = await connection
        // No second peer is accepted, even after the authenticated peer disconnects.
        server.close()
      }
      identity = await ready(output, value => {
        if (!value || value.type !== 'sampler-ready' || !Number.isSafeInteger(value.pid) || value.pid <= 1 ||
            value.ownerPid !== process.pid || value.ownerUid !== process.getuid() || value.nonce !== nonce ||
            value.effectiveUid !== (privilege === 'admin' ? 0 : process.geteuid()) ||
            (privilege === 'user' && value.pid !== child.pid)) throw new Error('Sampler ready identity does not match the requested privilege and owner')
      }, startup.signal)
      identity = { pid: identity.pid, effectiveUid: identity.effectiveUid, ownerPid: identity.ownerPid, ownerUid: identity.ownerUid }
    } finally {
      errors.off('readable', stderr)
    }
    startup.signal.throwIfAborted()
    clearTimeout(timer)
    returned = true
    // close follows delivery of all readable bytes; preserve final resource rows.
    output.once('close', () => {
      void cleanupFiles().catch(fail)
    })
    child.once('close', () => {
      if (!socket) void cleanupFiles().catch(fail)
    })
    return { process: child, input, output, errors, identity, dispose }
  } catch (error) {
    firstFailure ??= error
    if (!startup.signal.aborted) startup.abort(error)
    socket?.destroy()
    if (child && !exited(child)) child.kill('SIGTERM')
    try { await dispose() } catch (failure) { throw failure }
    throw error
  }
}
