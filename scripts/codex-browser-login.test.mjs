import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCodexLogin, saveCodexTokens } from '../codex-login.mjs'

const idToken = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.signature`
const tokens = { access_token: 'private-access', refresh_token: 'private-refresh', id_token: idToken }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })
const callbackUrl = (start, values = {}) => {
  const auth = new URL(start.verificationUrl)
  const url = new URL(auth.searchParams.get('redirect_uri'))
  url.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'private-code', ...values }).toString()
  return url
}

test('normal browser OAuth completes with PKCE and does not return secrets', async () => {
  let saved
  let calls = 0
  let form
  const login = createCodexLogin({ ports: [0], persist: (value) => { saved = value }, request: async (url, options) => {
    calls++
    assert.equal(url, 'https://auth.openai.com/oauth/token')
    form = new URLSearchParams(options.body)
    return response(tokens)
  } })
  try {
    const start = await login.start()
    assert.equal(start.status, 'pending')
    const auth = new URL(start.verificationUrl)
    assert.equal(auth.pathname, '/oauth/authorize')
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(auth.searchParams.get('response_type'), 'code')
    assert.equal(calls, 0)
    const result = await fetch(callbackUrl(start))
    assert.equal(result.status, 200)
    assert.match(await result.text(), /connected successfully/)
    assert.deepEqual(saved, tokens)
    assert.equal(form.get('redirect_uri'), auth.searchParams.get('redirect_uri'))
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'))
    const complete = await login.status()
    assert.equal(complete.status, 'complete')
    assert.doesNotMatch(JSON.stringify([start, complete]), /private-|access_token|refresh_token|id_token"|code_verifier/)
  } finally { login.cancel() }
})

test('invalid state is rejected without token exchange or killing valid sign-in', async () => {
  let calls = 0
  const login = createCodexLogin({ ports: [0], request: async () => { calls++; return response(tokens) } })
  try {
    const start = await login.start()
    const result = await fetch(callbackUrl(start, { state: 'wrong' }))
    assert.equal(result.status, 400)
    assert.equal(calls, 0)
    assert.equal((await login.status()).status, 'pending')
  } finally { login.cancel() }
})

test('cancel while exchanging prevents persistence', async () => {
  let release
  let began
  const ready = new Promise((resolve) => { began = resolve })
  let saved = false
  const login = createCodexLogin({ ports: [0], persist: () => { saved = true }, request: async () => {
    began()
    return new Promise((resolve) => { release = resolve })
  } })
  const start = await login.start()
  const browser = fetch(callbackUrl(start))
  await ready
  login.cancel()
  release(response(tokens))
  assert.equal((await browser).status, 410)
  assert.equal((await login.status()).status, 'idle')
  assert.equal(saved, false)
})

test('timeout closes callback and clears authorization URL', async () => {
  let time = 0
  const login = createCodexLogin({ ports: [0], now: () => time })
  await login.start()
  time = 900_000
  const result = await login.status()
  assert.equal(result.status, 'error')
  assert.match(result.message, /timed out/)
  assert.equal(result.verificationUrl, null)
})

test('provider denial is sanitized', async () => {
  const login = createCodexLogin({ ports: [0] })
  try {
    const start = await login.start()
    const result = await fetch(callbackUrl(start, { error: 'access_denied', error_description: 'private-access' }))
    assert.equal(result.status, 400)
    assert.doesNotMatch(await result.text(), /private-access/)
    assert.doesNotMatch(JSON.stringify(await login.status()), /private-access/)
    assert.equal((await login.status()).status, 'error')
  } finally { login.cancel() }
})

test('failed credential save never reports success', async () => {
  const login = createCodexLogin({ ports: [0], request: async () => response(tokens), persist: () => { throw Error('private-refresh') } })
  try {
    const start = await login.start()
    const result = await fetch(callbackUrl(start))
    assert.equal(result.status, 500)
    assert.match((await login.status()).message, /could not save/)
    assert.doesNotMatch(JSON.stringify(await login.status()), /private-refresh/)
  } finally { login.cancel() }
})

test('concurrent starts share one callback and token exchange failure is sanitized', async () => {
  const login = createCodexLogin({ ports: [0], request: async () => { throw Error('private-access') } })
  try {
    const [a, b] = await Promise.all([login.start(), login.start()])
    assert.equal(a.verificationUrl, b.verificationUrl)
    const result = await fetch(callbackUrl(a))
    assert.equal(result.status, 500)
    assert.doesNotMatch(JSON.stringify(await login.status()), /private-access/)
  } finally { login.cancel() }
})

test('occupied port is not interrupted and fallback port is used', async () => {
  const occupied = createServer()
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
  const login = createCodexLogin({ ports: [occupied.address().port, 0] })
  try {
    const start = await login.start()
    assert.equal(start.status, 'pending')
    const callback = new URL(new URL(start.verificationUrl).searchParams.get('redirect_uri'))
    assert.notEqual(Number(callback.port), occupied.address().port)
    assert.equal(occupied.listening, true)
  } finally { login.cancel(); await new Promise((resolve) => occupied.close(resolve)) }
})

test('writes compatible Codex auth atomically, preserving unrelated fields', () => {
  const dir = mkdtempSync('C:/Users/dwyat/AppData/Local/Temp/opencode/credits-login-test-')
  try {
    const file = join(dir, 'auth.json')
    writeFileSync(file, JSON.stringify({ extra: 'keep', tokens: { account_id: 'old' } }))
    saveCodexTokens(tokens, file)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.extra, 'keep')
    assert.equal(saved.tokens.account_id, 'account')
    assert.equal(saved.tokens.access_token, tokens.access_token)
    assert.equal(saved.auth_mode, 'chatgpt')
    assert.equal(saved.OPENAI_API_KEY, null)
    assert.ok(saved.last_refresh)
  } finally { rmSync(dir, { recursive: true }) }
})
