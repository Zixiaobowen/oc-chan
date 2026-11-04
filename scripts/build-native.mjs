import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/main/tern-present.swift', import.meta.url))
const output = fileURLToPath(new URL('../resources/tern-navigation/present-window', import.meta.url))
execFileSync('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', output], { stdio: 'inherit' })
