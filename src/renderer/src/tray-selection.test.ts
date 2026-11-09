import assert from 'node:assert/strict'
import test from 'node:test'
import { isTrayPanelSelected, parseTraySelection, updateTraySelection } from './plugins/tray-selection'

const allPanels = ['overview', 'cpu', 'memory', 'disk', 'network']

test('unchecking overview while system is unloaded preserves system defaults across persistence and reload', () => {
  let selection = parseTraySelection(null)
  const loadedPanels = ['overview']
  assert.deepEqual(loadedPanels.filter(id => isTrayPanelSelected(selection, id)), ['overview'])
  selection = updateTraySelection(selection, 'overview', false)
  assert.deepEqual(loadedPanels.filter(id => isTrayPanelSelected(selection, id)), [])
  selection = parseTraySelection(JSON.stringify(selection))
  assert.deepEqual(allPanels.filter(id => isTrayPanelSelected(selection, id)), ['cpu', 'memory', 'disk', 'network'])
  assert.equal(isTrayPanelSelected(selection, 'second-plugin.metric'), true)
})

test('explicit exclusions survive plugin unload and unrelated checkbox edits, and can be re-enabled', () => {
  let selection = updateTraySelection(parseTraySelection(null), 'cpu', false)
  selection = updateTraySelection(selection, 'overview', false)
  selection = parseTraySelection(JSON.stringify(selection))
  assert.deepEqual(allPanels.filter(id => isTrayPanelSelected(selection, id)), ['memory', 'disk', 'network'])
  selection = updateTraySelection(selection, 'overview', true)
  assert.equal(isTrayPanelSelected(selection, 'cpu'), false)
  selection = updateTraySelection(selection, 'cpu', true)
  assert.deepEqual(allPanels.filter(id => isTrayPanelSelected(selection, id)), allPanels)
  assert.strictEqual(updateTraySelection(selection, 'cpu', true), selection)
})

test('explicitly unchecking every panel survives reload without becoming the default selection', () => {
  let selection = parseTraySelection(null)
  for (const id of allPanels) selection = updateTraySelection(selection, id, false)
  selection = parseTraySelection(JSON.stringify(selection))
  assert.deepEqual(allPanels.filter(id => isTrayPanelSelected(selection, id)), [])
  assert.deepEqual(parseTraySelection(null), { excluded: [] })
})

test('tray preference rejects obsolete arrays, malformed and unbounded persisted values', () => {
  const invalidExcluded = [null, [null], [1], ['cpu', 'cpu'], [''], ['invalid panel'], ['x'.repeat(129)], Array.from({ length: 65 }, (_, index) => `panel-${index}`)]
  for (const input of ['{', '{}', '[]', '["cpu"]', '{"excluded":[],"extra":true}', ' '.repeat(8193), ...invalidExcluded.map(excluded => JSON.stringify({ excluded }))]) {
    assert.throws(() => parseTraySelection(input))
  }
  const full = parseTraySelection(JSON.stringify({ excluded: Array.from({ length: 64 }, (_, index) => `panel-${index}`) }))
  assert.throws(() => updateTraySelection(full, 'new-panel', false), /too large/)
  assert.throws(() => updateTraySelection(full, 'invalid panel', true), /Invalid tray panel/)
  assert.equal(updateTraySelection(full, 'panel-0', true).excluded.length, 63)
})
