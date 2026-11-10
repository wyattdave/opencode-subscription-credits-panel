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
const { copilotWindow, goWindows, cursorSession, cursorWindows, readCursorState, getSnapshot, __clearCache } = await import('../providers.mjs')
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

function cursorToken(overrides = {}) {
  const payload = { sub: 'auth0|user_test', exp: Math.floor(Date.now() / 1000) + 3600, email: 'cursor@example.com', ...overrides }
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test_signature`
}

function cursorEnv(t, value) {
  const previous = process.env.CURSOR_SESSION_TOKEN
  process.env.CURSOR_SESSION_TOKEN = value
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_SESSION_TOKEN
    else process.env.CURSOR_SESSION_TOKEN = previous
  })
}

const summary = {
  membershipType: 'pro', billingCycleEnd: '2026-12-01T00:00:00Z',
  individualUsage: {
    plan: { used: 500, limit: 2000, totalPercentUsed: 25, autoPercentUsed: 0.36, apiPercentUsed: 50 },
    onDemand: { used: 100, limit: 1000 },
  },
}

test('Cursor session derivation validates identity and rejects header injection/encrypted tokens', () => {
  const token = cursorToken()
  assert.equal(cursorSession(token).cookie, `WorkosCursorSessionToken=${encodeURIComponent(`user_test::${token}`)}`)
  assert.deepEqual(cursorSession(`user_test%3A%3A${token}`), cursorSession(token))
  for (const invalid of ['', 'cursor-safe-storage:v1:encrypted', `${token}\r\nX-Evil: yes`, `other-user::${token}`, cursorToken({ sub: 'bad;user' }), cursorToken({ exp: null })]) {
    assert.equal(cursorSession(invalid), null)
  }
})

test('Cursor reads app text and UTF-16 blob tokens without modifying the database', async () => {
  const file = join(directory, 'state.vscdb')
  const state = new DatabaseSync(file)
  state.exec('CREATE TABLE ItemTable (key TEXT, value BLOB)')
  const token = cursorToken()
  state.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', token)
  assert.equal(await readCursorState(file), token)
  state.prepare('UPDATE ItemTable SET value = ?').run(Buffer.from(token, 'utf16le'))
  assert.equal(await readCursorState(file), token)
  assert.equal(state.prepare('SELECT count(*) AS n FROM ItemTable').get().n, 1)
  state.close()
  assert.equal(await readCursorState(join(directory, 'missing.db')), null)
})

test('Cursor normalizes percentages (including fractions), cents, on-demand and reset dates', () => {
  const windows = cursorWindows(summary)
  assert.deepEqual(windows.map(w => w.usedPercent), [25, 0.36, 50, 10])
  assert.equal(windows[0].detail, '$5.00 of $20.00 used')
  assert.equal(windows[0].resetAt, '2026-12-01T00:00:00.000Z')
  assert.equal(cursorWindows({ individualUsage: { plan: { used: 500, limit: 2000 } } })[0].usedPercent, 25)
  assert.equal(cursorWindows({ individualUsage: { overall: { used: 500, limit: 1000 } } })[0].usedPercent, 50)
  assert.equal(cursorWindows({ teamUsage: { pooled: { used: 250, limit: 1000 } } })[0].label, 'Shared team allowance')
  assert.deepEqual(cursorWindows({ individualUsage: { plan: { used: 0, limit: 0 } } }), [])
  assert.deepEqual(cursorWindows(null), [])
})

test('Cursor fetch uses only cursor.com, normalizes data and never returns credentials', async (t) => {
  const token = cursorToken()
  cursorEnv(t, token)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://cursor.com/api/usage-summary')
    assert.equal(options.headers.Cookie, cursorSession(token).cookie)
    assert.equal(options.redirect, 'error')
    return Response.json({ ...summary, secret: token })
  })
  __clearCache()
  const snapshot = await getSnapshot({ provider: 'cursor', force: true })
  const cursor = snapshot.providers.find(p => p.id === 'cursor')
  assert.equal(cursor.status, 'ok')
  assert.equal(cursor.plan, 'Cursor pro')
  assert.equal(cursor.note, 'On-demand spend this cycle: $1.00')
  assert.equal(JSON.stringify(snapshot).includes(token), false)
})

test('Cursor expired/invalid explicit sessions never make network calls or fall back', async (t) => {
  cursorEnv(t, '')
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not send expired credentials') })
  for (const [token, expected] of [[cursorToken({ exp: 1 }), 'expired'], ['invalid', 'signin'], ['', 'signin']]) {
    process.env.CURSOR_SESSION_TOKEN = token
    __clearCache()
    const snapshot = await getSnapshot({ provider: 'cursor', force: true })
    assert.equal(snapshot.providers.find(p => p.id === 'cursor').status, expected)
  }
})

for (const [status, body, expected] of [
  [401, {}, 'expired'], [403, {}, 'expired'], [500, {}, 'error'], [200, {}, 'unavailable'],
]) test(`Cursor handles HTTP ${status} (${expected})`, async (t) => {
  cursorEnv(t, cursorToken())
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status }))
  __clearCache()
  const snapshot = await getSnapshot({ provider: 'cursor', force: true })
  assert.equal(snapshot.providers.find(p => p.id === 'cursor').status, expected)
})

test('Cursor network failures are sanitized', async (t) => {
  cursorEnv(t, cursorToken())
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret-cookie-should-not-escape') })
  __clearCache()
  const snapshot = await getSnapshot({ provider: 'cursor', force: true })
  assert.equal(snapshot.providers.find(p => p.id === 'cursor').status, 'error')
  assert.equal(JSON.stringify(snapshot).includes('secret-cookie'), false)
})
