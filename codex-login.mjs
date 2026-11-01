import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const ISSUER = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_FILE = join(homedir(), '.codex', 'auth.json')

export function saveCodexTokens(tokens, file = AUTH_FILE) {
  let previous = {}
  try {
    previous = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString())
  const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id
  const auth = {
    ...previous,
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: accountId ?? null,
    },
    last_refresh: new Date().toISOString(),
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = join(dirname(file), `.auth.${randomUUID()}.tmp`)
  writeFileSync(temp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

// Standard Codex browser OAuth with PKCE and a loopback-only callback. The
// verifier, returned authorization code and credentials never cross RPC.
export function createCodexLogin({ request = fetch, persist = saveCodexTokens, now = Date.now, ports = [1455, 1457] } = {}) {
  let session = { status: 'idle' }
  let starting = null

  const view = () => ({
    status: session.status,
    verificationUrl: session.status === 'pending' ? session.authUrl : null,
    expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
    message: session.message ?? null,
  })

  const stop = (attempt) => {
    attempt.controller?.abort()
    clearTimeout(attempt.timer)
    attempt.server?.close()
    attempt.server?.closeIdleConnections()
  }

  const fail = (attempt, message) => {
    if (session !== attempt) return
    stop(attempt)
    session = { status: 'error', message }
  }

  const cancel = () => {
    stop(session)
    session = { status: 'idle' }
    starting = null
    return view()
  }

  const start = async () => {
    if (starting) return starting
    if (session.status === 'pending' && now() < session.expiresAt) return view()
    cancel()
    const attempt = {
      status: 'starting', controller: new AbortController(),
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
    }
    session = attempt
    const operation = (async () => {
      try {
        let bound = false
        for (const port of ports) {
          if (session !== attempt) return view()
          const server = createServer((req, res) => { void callback(attempt, req, res) })
          server.requestTimeout = 20_000
          server.headersTimeout = 10_000
          try {
            await new Promise((resolve, reject) => {
              server.once('error', reject)
              server.listen(port, '127.0.0.1', () => {
                server.removeListener('error', reject)
                resolve()
              })
            })
          } catch (error) {
            server.close()
            if (error.code === 'EADDRINUSE') continue
            throw error
          }
          if (session !== attempt) { server.close(); return view() }
          attempt.server = server
          server.on('error', () => fail(attempt, 'The local sign-in callback stopped. Please retry.'))
          const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`
          const url = new URL(`${ISSUER}/oauth/authorize`)
          url.search = new URLSearchParams({
            response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri,
            scope: 'openid profile email offline_access',
            code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
            code_challenge_method: 'S256', state: attempt.state,
            id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true',
            originator: 'codex_cli_rs',
          }).toString()
          Object.assign(attempt, { status: 'pending', redirectUri, authUrl: url.toString(), expiresAt: now() + 15 * 60_000 })
          attempt.timer = setTimeout(() => fail(attempt, 'Sign-in timed out. Click Sign in with ChatGPT to try again.'), 15 * 60_000)
          attempt.timer.unref()
          bound = true
          break
        }
        if (!bound) fail(attempt, 'Another app is using the ChatGPT sign-in ports. Finish or cancel that sign-in, then retry here.')
      } catch {
        fail(attempt, 'Could not start the local browser sign-in callback. Please retry.')
      }
      return view()
    })()
    starting = operation
    try { return await operation } finally { if (starting === operation) starting = null }
  }

  const reply = (res, status, message) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer', Connection: 'close',
    })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Account usage — ChatGPT</title></head><body><h1>${message}</h1><p>You can close this tab and return to the Account usage panel in OpenCode.</p></body></html>`)
  }

  const callback = async (attempt, req, res) => {
    if (session !== attempt || attempt.status !== 'pending') { reply(res, 410, 'This sign-in is no longer active.'); return }
    if (now() >= attempt.expiresAt) { reply(res, 410, 'Sign-in expired. Please try again.'); fail(attempt, 'Sign-in expired. Please try again.'); return }
    const expectedHost = new URL(attempt.redirectUri).host
    if (req.method !== 'GET' || req.headers.host !== expectedHost || (req.url?.length ?? 0) > 8192) { reply(res, 400, 'Invalid sign-in callback.'); return }
    const url = new URL(req.url, attempt.redirectUri)
    if (url.pathname !== '/auth/callback') { reply(res, 404, 'Not found.'); return }
    const state = Buffer.from(url.searchParams.get('state') ?? '')
    const expected = Buffer.from(attempt.state)
    if (state.length !== expected.length || !timingSafeEqual(state, expected)) { reply(res, 400, 'Invalid sign-in state. Return to the browser sign-in you started.'); return }
    if (url.searchParams.has('error')) { reply(res, 400, 'ChatGPT sign-in was not approved.'); fail(attempt, 'ChatGPT sign-in was not approved. Please retry.'); return }
    const code = url.searchParams.get('code')
    if (!code) { reply(res, 400, 'Missing authorization code.'); return }
    attempt.status = 'exchanging'
    try {
      const response = await request(`${ISSUER}/oauth/token`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: attempt.redirectUri, code, code_verifier: attempt.verifier }).toString(),
        signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(20_000)]),
      })
      if (session !== attempt) { reply(res, 410, 'Sign-in cancelled.'); return }
      const data = response.ok ? await response.json() : null
      if (!response.ok || !['access_token', 'refresh_token', 'id_token'].every((key) => typeof data?.[key] === 'string' && data[key])) {
        reply(res, 400, 'Could not complete ChatGPT sign-in. Please try again.')
        fail(attempt, 'Could not finish ChatGPT sign-in. Please start again.')
        return
      }
      if (session !== attempt) { reply(res, 410, 'Sign-in cancelled.'); return }
      try { persist(data) } catch {
        reply(res, 500, 'Signed in, but credentials could not be saved.')
        fail(attempt, 'Signed in, but could not save Codex credentials locally. Check access to ~/.codex/auth.json and retry.')
        return
      }
      reply(res, 200, 'ChatGPT connected successfully.')
      stop(attempt)
      session = { status: 'complete', message: 'Signed in with ChatGPT.' }
    } catch {
      reply(res, 500, 'ChatGPT sign-in was interrupted. Please try again.')
      fail(attempt, 'ChatGPT sign-in was interrupted. Please start again.')
    }
  }

  const status = async () => {
    if (session.expiresAt && now() >= session.expiresAt) fail(session, 'Sign-in timed out. Click Sign in with ChatGPT to try again.')
    const result = view()
    // Keep the public state simple while the server completes the token exchange.
    if (result.status === 'exchanging') result.status = 'pending'
    return result
  }

  return { start, status, cancel }
}
