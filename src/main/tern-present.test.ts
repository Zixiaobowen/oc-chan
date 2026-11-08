import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)

test('native Tern selection and process identity reject ambiguity and expired processes', {
  skip: process.platform !== 'darwin' ? 'The native Tern helper requires macOS AppKit' : false,
  timeout: 60_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'oc-tern-native-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = await readFile(new URL('./tern-present.swift', import.meta.url), 'utf8')
  // Compile the production selector with inert AppKit candidates. No GUI is
  // launched, focused or enumerated, and no Accessibility permission is needed.
  const checks = `
final class Candidate: NSRunningApplication, @unchecked Sendable {
    private let candidatePID: pid_t
    private let candidatePolicy: NSApplication.ActivationPolicy
    private let candidateTerminated: Bool

    init(_ pid: pid_t, _ policy: NSApplication.ActivationPolicy, terminated: Bool = false) {
        candidatePID = pid
        candidatePolicy = policy
        candidateTerminated = terminated
        super.init()
    }
    override var processIdentifier: pid_t { candidatePID }
    override var activationPolicy: NSApplication.ActivationPolicy { candidatePolicy }
    override var isTerminated: Bool { candidateTerminated }
}

let window = Candidate(41, .regular)
let daemon = Candidate(42, .prohibited)
let cli = Candidate(43, .accessory)
let exited = Candidate(44, .regular, terminated: true)
let scenarios: [String: [NSRunningApplication]] = [
    "background-first": [daemon, window, cli],
    "background-last": [window, cli, daemon],
    "window-last": [cli, daemon, window],
    "terminated-first": [exited, window],
    "terminated-last": [window, exited],
    "empty": [],
    "background-only": [daemon],
    "no-live-window": [cli, exited],
    "ambiguous": [window, daemon, Candidate(45, .regular)],
    "invalid-pid": [Candidate(0, .regular)],
]
var results: [String: [String: Any]] = [:]
for (name, applications) in scenarios {
    do {
        results[name] = ["pid": try uniqueApplication(applications).processIdentifier]
    } catch let error as NavigationError {
        results[name] = ["error": error.rawValue]
    }
}
let ownStart = try processStartTime(getpid())
results["stable-process"] = ["sameStart": try processStartTime(getpid()) == ownStart]
let child = Process()
let input = Pipe()
child.executableURL = URL(fileURLWithPath: "/bin/cat")
child.standardInput = input
child.standardOutput = FileHandle.nullDevice
child.standardError = FileHandle.nullDevice
try child.run()
let childStart = try processStartTime(child.processIdentifier)
results["different-process"] = ["differentStart": childStart != ownStart]
try input.fileHandleForWriting.close()
child.waitUntilExit()
do {
    _ = try processStartTime(child.processIdentifier)
    results["expired-process"] = ["accepted": true]
} catch let error as NavigationError {
    results["expired-process"] = ["error": error.rawValue]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: results))
`
  const main = path.join(directory, 'main.swift')
  const executable = path.join(directory, 'selection-tests')
  await writeFile(main, source + checks)
  await execute('/usr/bin/xcrun', ['swiftc', '-D', 'TERN_NAVIGATION_TESTING', main, '-o', executable], {
    timeout: 30_000, maxBuffer: 256 * 1024,
  })
  const result = await execute(executable, [], { timeout: 10_000, maxBuffer: 256 * 1024 })
  assert.deepEqual(JSON.parse(result.stdout), {
    'background-first': { pid: 41 },
    'background-last': { pid: 41 },
    'window-last': { pid: 41 },
    'terminated-first': { pid: 41 },
    'terminated-last': { pid: 41 },
    empty: { error: 'OC_TERN_UNAVAILABLE' },
    'background-only': { error: 'OC_TERN_UNAVAILABLE' },
    'no-live-window': { error: 'OC_TERN_UNAVAILABLE' },
    ambiguous: { error: 'OC_TERN_AMBIGUOUS' },
    'invalid-pid': { error: 'OC_TERN_IDENTITY' },
    'stable-process': { sameStart: true },
    'different-process': { differentStart: true },
    'expired-process': { error: 'OC_TERN_IDENTITY' },
  })
})
