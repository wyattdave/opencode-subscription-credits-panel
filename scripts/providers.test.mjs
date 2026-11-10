import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { usedText } from '../src/usage-text.mjs'

const directory = mkdtempSync(join(tmpdir(), 'credits-providers-'))
const previousDb = process.env.OPENCODE_DB
process.env.OPENCODE_DB = join(directory, 'test.db')
const db = new DatabaseSync(process.env.OPENCODE_DB)
db.exec('CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)')
db.prepare('INSERT INTO credential VALUES (?, ?, 1, 1)').run('opencode', JSON.stringify({
  type: 'oauth', access: 'test-secret', metadata: { orgID: 'test-workspace', email: 'test@example.com' },
}))
db.close()
const { copilotWindow, goWindows, getSnapshot, __clearCache } = await import('../providers.mjs')
after(() => {
  if (previousDb === undefined) delete process.env.OPENCODE_DB
  else process.env.OPENCODE_DB = previousDb
  rmSync(directory, { recursive: true, force: true })
})

test('Copilot shows both percentage and request count', () => {
  const window = copilotWindow('premium_interactions', { entitlement: 300, remaining: 225 }, null)
  assert.equal(window.usedPercent, 25)
  assert.equal(usedText(window), '25% used · 75 used')
})

test('Copilot accepts percentage-only and credits-used snapshots', () => {
  assert.equal(copilotWindow('chat', { percent_remaining: 60 }, null).usedPercent, 40)
  assert.equal(copilotWindow('chat', { entitlement: 100, credits_used: 35 }, null).usedPercent, 35)
  assert.equal(copilotWindow('chat', { entitlement: 0, remaining: 0 }, null).usedPercent, null)
  assert.equal(usedText(copilotWindow('chat', { unlimited: true }, null)), '')
  assert.equal(usedText({ usedPercent: null, detail: '75 used' }), '75 used')
})

const meter = { status: 'ok', percent: 25, resetsAt: '2026-12-01T00:00:00Z' }
const usage = { rolling: meter, weekly: { ...meter, percent: 50 }, monthly: { ...meter, percent: 75 } }

test('Go normalizes its three allowance windows and reset times', () => {
  const windows = goWindows(usage)
  assert.deepEqual(windows.map(w => w.usedPercent), [25, 50, 75])
  assert.deepEqual(windows.map(w => w.remainingPercent), [75, 50, 25])
  assert.equal(windows[0].resetAt, '2026-12-01T00:00:00.000Z')
  assert.equal(goWindows({ rolling: { ...meter, percent: 120, status: 'rate-limited' } })[0].usedPercent, 100)
  assert.equal(goWindows({ rolling: { ...meter, percent: '25' } }).length, 0)
  assert.equal(goWindows({ rolling: { ...meter, resetsAt: 'invalid' } }).length, 0)
})

test('Go fetch authenticates to the official endpoint and only returns normalized data', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage')
    assert.equal(options.headers.Authorization, 'Bearer test-secret')
    assert.equal(options.headers['x-opencode-org-id'], 'test-workspace')
    assert.equal(options.redirect, 'error')
    return Response.json({ usage, secret: 'test-secret' })
  })
  __clearCache()
  const snapshot = await getSnapshot({ provider: 'go', force: true })
  const provider = snapshot.providers.find(p => p.id === 'go')
  assert.equal(provider.status, 'ok')
  assert.equal(provider.windows.length, 3)
  assert.equal(JSON.stringify(snapshot).includes('test-secret'), false)
})

for (const [status, body, expected] of [
  [401, {}, 'expired'], [403, {}, 'unavailable'], [500, {}, 'error'],
  [200, {}, 'error'], [200, { usage: { rolling: meter } }, 'error'],
]) test(`Go handles HTTP ${status} and incomplete data safely (${expected})`, async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status }))
  __clearCache()
  const snapshot = await getSnapshot({ provider: 'go', force: true })
  const provider = snapshot.providers.find(p => p.id === 'go')
  assert.equal(provider.status, expected)
  assert.deepEqual(provider.windows, [])
})
