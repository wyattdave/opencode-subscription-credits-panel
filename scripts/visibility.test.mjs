import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setProviderVisible, visibleProviders } from '../src/visibility.mjs'

const providers = ['codex', 'copilot', 'claude', 'go', 'cursor'].map(id => ({ id }))

test('all providers are visible by default, including new providers', () => {
  assert.deepEqual(visibleProviders(providers, []), providers)
  assert.equal(visibleProviders(providers, ['claude']).some(p => p.id === 'cursor'), true)
})

test('hide/show is idempotent and leaves other choices untouched', () => {
  const original = ['claude']
  const hidden = setProviderVisible(original, 'cursor', false)
  assert.deepEqual(original, ['claude'])
  assert.deepEqual(hidden, ['claude', 'cursor'])
  assert.deepEqual(setProviderVisible(hidden, 'cursor', false), hidden)
  assert.deepEqual(setProviderVisible(hidden, 'cursor', true), ['claude'])
  assert.deepEqual(visibleProviders(providers, hidden).map(p => p.id), ['codex', 'copilot', 'go'])
})

test('visibility survives stored JSON, supports hiding everything and resetting', () => {
  const stored = JSON.parse(JSON.stringify({ hidden: providers.map(p => p.id) }))
  assert.deepEqual(visibleProviders(providers, stored.hidden), [])
  assert.deepEqual(visibleProviders(providers, []), providers)
  assert.deepEqual(visibleProviders(providers, ['unknown-provider']), providers)
})
