import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const HOME = homedir()
const FETCH_TIMEOUT_MS = 12_000
const CACHE_TTL_MS = 60_000
const EXPIRY_BUFFER_MS = 5 * 60_000
const DAY_MS = 24 * 60 * 60_000

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_REFRESH_URL = 'https://auth.openai.com/oauth/token'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

const COPILOT_USAGE_URL = 'https://api.github.com/copilot_internal/user'

const CODEX_AUTH_FILE = join(HOME, '.codex', 'auth.json')
const CLAUDE_CREDENTIALS_FILE = join(HOME, '.claude', '.credentials.json')
const COPILOT_HOSTS_FILES = [
  join(HOME, '.config', 'github-copilot', 'hosts.json'),
  join(process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'), 'github-copilot', 'hosts.json'),
]

const DB_CANDIDATES = [
  process.env.OPENCODE_DB,
  join(HOME, '.local', 'share', 'opencode', 'opencode.db'),
  process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db') : null,
].filter(Boolean)

const PROVIDER_NAMES = {
  codex: 'ChatGPT / Codex',
  copilot: 'GitHub Copilot',
  claude: 'Claude Code',
}

const PROVIDER_ORDER = ['codex', 'copilot', 'claude']

let cache = null
let inflight = null

// ---------------------------------------------------------------------------
// Small utilities

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value) {
  const num = asNumber(value)
  return num === null ? null : Math.max(0, Math.min(100, num))
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    // APIs mix seconds and milliseconds here.
    const ms = value > 10_000_000_000 ? value : value * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function decodeJwt(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null
  try {
    const payload = token.split('.')[1]
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function writeAtomic(file, contents) {
  const temp = join(dirname(file), `.${file.split(/[\\/]/).pop()}.${process.pid}.tmp`)
  writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, file)
}

async function fetchResponse(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    let body = null
    let text = ''
    try {
      text = await response.text()
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { ok: response.ok, status: response.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

async function readDbCredential(integrationId) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return null
  }
  for (const file of DB_CANDIDATES) {
    if (!existsSync(file)) continue
    let db = null
    try {
      db = new DatabaseSync(file, { readOnly: true })
      const row = db
        .prepare(
          'select value, time_updated from credential where integration_id = ? and active = 1 order by time_updated desc limit 1',
        )
        .get(integrationId)
      if (!row?.value) continue
      const parsed = JSON.parse(row.value)
      return {
        ...parsed,
        updatedAt: row.time_updated ? new Date(row.time_updated).toISOString() : null,
      }
    } catch {
      continue
    } finally {
      try {
        db?.close()
      } catch {
        // ignore
      }
    }
  }
  return null
}

function baseProvider(id, overrides = {}) {
  return {
    id,
    name: PROVIDER_NAMES[id],
    status: 'error',
    plan: null,
    account: null,
    source: null,
    windows: [],
    note: null,
    message: null,
    command: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function providerError(id, error) {
  return baseProvider(id, {
    status: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
}

// ---------------------------------------------------------------------------
// ChatGPT / Codex

function codexIdentity(accessToken, idToken) {
  for (const token of [idToken, accessToken]) {
    const jwt = decodeJwt(token)
    if (!jwt) continue
    const auth = jwt['https://api.openai.com/auth'] ?? {}
    const profile = jwt['https://api.openai.com/profile'] ?? {}
    const email = profile.email ?? jwt.email ?? null
    const plan = auth.chatgpt_plan_type ?? auth.plan_type ?? null
    const accountId = auth.chatgpt_account_id ?? null
    if (email || plan || accountId) {
      return {
        email,
        plan,
        accountId,
        expiresAt: typeof jwt.exp === 'number' ? jwt.exp * 1000 : null,
      }
    }
  }
  return { email: null, plan: null, accountId: null, expiresAt: null }
}

function readCodexFile() {
  try {
    const raw = JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf8'))
    const tokens = raw.tokens ?? {}
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) return null
    const identity = codexIdentity(tokens.access_token, tokens.id_token)
    return {
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
      accountId: typeof tokens.account_id === 'string' ? tokens.account_id : identity.accountId,
      idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
      email: identity.email,
      plan: identity.plan,
      expiresAt: identity.expiresAt ?? 0,
      source: 'Codex CLI',
      raw,
      wroteBack: true,
    }
  } catch {
    return null
  }
}

function writeCodexFile(creds, tokens) {
  try {
    const raw = creds.raw ?? {}
    raw.tokens = { ...(raw.tokens ?? {}), ...tokens }
    raw.last_refresh = new Date().toISOString()
    writeAtomic(CODEX_AUTH_FILE, `${JSON.stringify(raw, null, 2)}\n`)
  } catch {
    // The usage result is still usable in memory.
  }
}

async function refreshCodex(creds) {
  if (!creds.refreshToken) return null
  try {
    const response = await fetchResponse(CODEX_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
    })
    if (!response.ok || !response.body?.access_token) return null
    const data = response.body
    const identity = codexIdentity(data.access_token, data.id_token ?? creds.idToken)
    const next = {
      ...creds,
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : creds.refreshToken,
      idToken: data.id_token ?? creds.idToken,
      accountId: identity.accountId ?? creds.accountId,
      email: identity.email ?? creds.email,
      plan: identity.plan ?? creds.plan,
      expiresAt:
        typeof data.expires_in === 'number'
          ? Date.now() + data.expires_in * 1000
          : (identity.expiresAt ?? creds.expiresAt),
    }
    if (creds.wroteBack) {
      writeCodexFile(creds, {
        access_token: next.accessToken,
        refresh_token: next.refreshToken,
        id_token: next.idToken,
      })
    }
    return next
  } catch {
    return null
  }
}

function codexWindowLabel(seconds, fallback) {
  if (!seconds) return fallback
  if (seconds >= 604800) return 'Weekly window'
  if (seconds >= 86400) {
    const days = Math.round(seconds / 86400)
    return days === 1 ? 'Daily window' : `${days}-day window`
  }
  const hours = Math.round(seconds / 3600)
  return hours > 0 ? `${hours}-hour window` : fallback
}

function codexWindow(raw, fallbackLabel) {
  if (!raw || typeof raw !== 'object') return null
  const used = clampPercent(raw.used_percent ?? raw.usedPercent)
  const resetAt =
    toIso(raw.reset_at ?? raw.resetAt) ??
    (asNumber(raw.reset_after_seconds ?? raw.resetAfterSeconds) !== null
      ? new Date(
          Date.now() + (raw.reset_after_seconds ?? raw.resetAfterSeconds) * 1000,
        ).toISOString()
      : null)
  return {
    id: fallbackLabel.toLowerCase().replace(/\s+/g, '-'),
    label: codexWindowLabel(asNumber(raw.limit_window_seconds ?? raw.limitWindowSeconds), fallbackLabel),
    usedPercent: used,
    remainingPercent: used === null ? null : 100 - used,
    remaining: null,
    entitlement: null,
    resetAt,
    unlimited: false,
    detail: null,
  }
}

async function loadCodex() {
  let creds = readCodexFile()
  let source = creds?.source ?? null

  if (!creds) {
    const db = await readDbCredential('openai')
    if (db?.access) {
      const identity = codexIdentity(db.access, null)
      creds = {
        accessToken: db.access,
        refreshToken: typeof db.refresh === 'string' ? db.refresh : '',
        accountId: identity.accountId,
        idToken: null,
        email: identity.email,
        plan: identity.plan,
        expiresAt: asNumber(db.expires) ?? 0,
        source: 'OpenCode sign-in',
        raw: null,
        wroteBack: false,
      }
      source = creds.source
    }
  }

  if (!creds) {
    return baseProvider('codex', {
      status: 'signin',
      message: 'No Codex credentials found. Run `codex login` in a terminal.',
      command: 'codex login',
      source: 'No credentials',
    })
  }

  // OpenCode owns renewal of its credentials. Never rotate its refresh token
  // without updating the host's credential store.
  if (creds.wroteBack && creds.expiresAt && Date.now() + EXPIRY_BUFFER_MS >= creds.expiresAt) {
    const refreshed = await refreshCodex(creds)
    if (refreshed) creds = refreshed
  }

  if (!creds.accountId) {
    return baseProvider('codex', {
      status: 'expired',
      plan: creds.plan,
      account: creds.email,
      source,
      message:
        'This OpenAI sign-in cannot read ChatGPT usage. Run `codex login` to connect a Codex account.',
      command: 'codex login',
    })
  }

  const headers = {
    Authorization: `Bearer ${creds.accessToken}`,
    'ChatGPT-Account-Id': creds.accountId,
    Accept: 'application/json',
    'User-Agent': 'codex-cli',
  }

  let response
  try {
    response = await fetchResponse(CODEX_USAGE_URL, { headers })
  } catch (error) {
    return baseProvider('codex', {
      status: 'error',
      plan: creds.plan,
      account: creds.email,
      source,
      message: `Could not reach ChatGPT: ${error instanceof Error ? error.message : String(error)}`,
      command: 'codex login',
    })
  }

  if (response.status === 401 || response.status === 403) {
    return baseProvider('codex', {
      status: 'expired',
      plan: creds.plan,
      account: creds.email,
      source,
      message: 'Codex sign-in has expired. Run `codex login` in a terminal, then refresh.',
      command: 'codex login',
    })
  }

  if (!response.ok || !response.body) {
    return baseProvider('codex', {
      status: 'error',
      plan: creds.plan,
      account: creds.email,
      source,
      message: `ChatGPT usage request failed (HTTP ${response.status}).`,
      command: 'codex login',
    })
  }

  const body = response.body
  const rateLimit = body.rate_limit ?? body.rateLimit ?? {}
  const windows = [
    codexWindow(rateLimit.primary_window ?? rateLimit.primaryWindow, 'Session'),
    codexWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow, 'Weekly'),
  ].filter(Boolean)

  const credits = body.credits ?? {}
  let note = null
  if (credits.unlimited === true) note = 'Included credits: unlimited'
  else if (credits.balance !== null && credits.balance !== undefined) {
    note = `Credit balance: ${credits.balance}`
  }

  const plan = body.plan_type ?? body.planType ?? creds.plan
  const email = body.email ?? creds.email

  return baseProvider('codex', {
    status: 'ok',
    plan,
    account: email,
    source,
    windows,
    note,
    message: rateLimit.limit_reached || rateLimit.limitReached ? 'Rate limit reached.' : null,
  })
}

// ---------------------------------------------------------------------------
// GitHub Copilot

function readCopilotHosts() {
  for (const file of COPILOT_HOSTS_FILES) {
    if (!existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const value of Object.values(raw)) {
        const token = value?.oauth_token
        if (typeof token === 'string' && token) {
          return { token, source: 'GitHub Copilot CLI', login: value.user ?? null }
        }
      }
    } catch {
      // try the next file
    }
  }
  return null
}

async function readCopilotCredential() {
  const db = await readDbCredential('github-copilot')
  if (db?.access) {
    return {
      token: db.access,
      source: 'OpenCode credential store',
      login: null,
      endpoint:
        typeof db.metadata?.apiEndpoint === 'string' ? db.metadata.apiEndpoint : null,
    }
  }
  const env = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_COPILOT_TOKEN
  if (env) return { token: env, source: 'Environment', login: null, endpoint: null }
  return readCopilotHosts()
}

function copilotLabel(key) {
  switch (key) {
    case 'premium_interactions':
      return 'Premium requests'
    case 'chat':
      return 'Chat'
    case 'completions':
      return 'Completions'
    default:
      return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
}

function copilotOrder(key) {
  if (key === 'premium_interactions') return 0
  if (key === 'chat') return 1
  if (key === 'completions') return 2
  return 3
}

function copilotWindow(key, snapshot, resetAt) {
  const unlimited = snapshot?.unlimited === true
  if (unlimited) {
    return {
      id: key,
      label: copilotLabel(key),
      usedPercent: 0,
      remainingPercent: 100,
      remaining: null,
      entitlement: null,
      resetAt,
      unlimited: true,
      detail: 'Unlimited',
    }
  }

  const remaining = asNumber(snapshot?.remaining) ?? asNumber(snapshot?.quota_remaining)
  const entitlement = asNumber(snapshot?.entitlement)
  const used =
    asNumber(snapshot?.credits_used) ??
    (entitlement !== null && remaining !== null ? entitlement - remaining : null)
  const percent = clampPercent(
    asNumber(snapshot?.percent_remaining) ??
      (entitlement && remaining !== null ? (remaining / entitlement) * 100 : null),
  )

  return {
    id: key,
    label: copilotLabel(key),
    usedPercent: percent === null ? null : 100 - percent,
    remainingPercent: percent,
    remaining,
    entitlement,
    resetAt,
    unlimited: false,
    detail: used !== null ? `${Math.round(used).toLocaleString()} used` : null,
  }
}

async function loadCopilot() {
  const creds = await readCopilotCredential()
  if (!creds) {
    return baseProvider('copilot', {
      status: 'signin',
      source: 'No credentials',
      message:
        'No GitHub Copilot credentials found. Sign in to Copilot in OpenCode Settings → Integrations.',
    })
  }

  const headers = {
    Authorization: `token ${creds.token}`,
    Accept: 'application/json',
    'Editor-Version': 'vscode/1.96.2',
    'Editor-Plugin-Version': 'copilot-chat/0.26.7',
    'User-Agent': 'GitHubCopilotChat/0.26.7',
    'X-Github-Api-Version': '2025-04-01',
  }

  let response
  try {
    response = await fetchResponse(COPILOT_USAGE_URL, { headers })
  } catch (error) {
    return baseProvider('copilot', {
      status: 'error',
      source: creds.source,
      message: `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  if (response.status === 401 || response.status === 403) {
    return baseProvider('copilot', {
      status: 'expired',
      source: creds.source,
      message: 'GitHub rejected the Copilot token. Sign in to Copilot again in OpenCode.',
    })
  }

  if (!response.ok || !response.body) {
    return baseProvider('copilot', {
      status: 'error',
      source: creds.source,
      message: `GitHub Copilot usage request failed (HTTP ${response.status}).`,
    })
  }

  const body = response.body
  const resetAt = toIso(body.quota_reset_date_utc ?? body.quota_reset_date)
  const windows = []

  const snapshots = body.quota_snapshots ?? {}
  for (const key of Object.keys(snapshots).sort((a, b) => copilotOrder(a) - copilotOrder(b))) {
    windows.push(copilotWindow(key, snapshots[key], resetAt))
  }

  if (!windows.length && body.limited_user_quotas) {
    const monthly = body.monthly_quotas ?? {}
    for (const key of Object.keys(body.limited_user_quotas).sort(
      (a, b) => copilotOrder(a) - copilotOrder(b),
    )) {
      const left = asNumber(body.limited_user_quotas[key])
      const total = asNumber(monthly[key])
      silentPushLegacy(windows, key, left, total, resetAt)
    }
  }

  return baseProvider('copilot', {
    status: 'ok',
    plan: body.copilot_plan ?? body.access_type_sku ?? null,
    account: body.login ?? creds.login,
    source: creds.source,
    windows,
    note:
      typeof body.access_type_sku === 'string' && /free/i.test(body.access_type_sku)
        ? 'Free trial quota'
        : null,
  })
}

function silentPushLegacy(windows, key, left, total, resetAt) {
  const percent = total && left !== null ? clampPercent((left / total) * 100) : null
  windows.push({
    id: key,
    label: copilotLabel(key),
    usedPercent: percent === null ? null : 100 - percent,
    remainingPercent: percent,
    remaining: left,
    entitlement: total,
    resetAt,
    unlimited: false,
    detail: total !== null && left !== null ? `${(total - left).toLocaleString()} used` : null,
  })
}

// ---------------------------------------------------------------------------
// Claude Code

function parseClaudeCredentials(raw) {
  try {
    const parsed = JSON.parse(raw)
    const inner = parsed.claudeAiOauth ?? parsed
    if (typeof inner.accessToken !== 'string' || !inner.accessToken) return null
    return {
      accessToken: inner.accessToken,
      refreshToken: typeof inner.refreshToken === 'string' ? inner.refreshToken : '',
      expiresAt: asNumber(inner.expiresAt) ?? 0,
      scopes: Array.isArray(inner.scopes) ? inner.scopes : [],
      subscriptionType: inner.subscriptionType ?? null,
      rateLimitTier: inner.rateLimitTier ?? null,
      source: 'Claude Code',
      file: CLAUDE_CREDENTIALS_FILE,
      wrapped: Boolean(parsed.claudeAiOauth),
      raw: parsed,
    }
  } catch {
    return null
  }
}

async function readClaudeCredential() {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (env) {
    return {
      accessToken: env,
      refreshToken: '',
      expiresAt: 0,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      source: 'CLAUDE_CODE_OAUTH_TOKEN',
      file: null,
      wrapped: false,
      raw: null,
    }
  }

  if (existsSync(CLAUDE_CREDENTIALS_FILE)) {
    try {
      const creds = parseClaudeCredentials(readFileSync(CLAUDE_CREDENTIALS_FILE, 'utf8'))
      if (creds) return creds
    } catch {
      // fall through
    }
  }

  const db = await readDbCredential('anthropic')
  if (db?.access) {
    return {
      accessToken: db.access,
      refreshToken: typeof db.refresh === 'string' ? db.refresh : '',
      expiresAt: asNumber(db.expires) ?? 0,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      source: 'OpenCode credential store',
      file: null,
      wrapped: false,
      raw: null,
    }
  }

  return null
}

function writeClaudeFile(creds, tokens) {
  if (!creds.file || !creds.raw) return
  try {
    const next = { ...(creds.raw.claudeAiOauth ?? creds.raw) }
    next.accessToken = tokens.accessToken
    next.refreshToken = tokens.refreshToken
    next.expiresAt = tokens.expiresAt
    const payload = creds.wrapped ? { ...creds.raw, claudeAiOauth: next } : next
    writeAtomic(creds.file, JSON.stringify(payload))
  } catch {
    // Keep the refreshed token in memory.
  }
}

async function refreshClaude(creds) {
  if (!creds.refreshToken) return null
  try {
    const response = await fetchResponse(CLAUDE_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }).toString(),
    })
    if (!response.ok || !response.body?.access_token) return null
    const data = response.body
    const next = {
      ...creds,
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : creds.refreshToken,
      expiresAt:
        typeof data.expires_in === 'number'
          ? Date.now() + data.expires_in * 1000
          : Date.now() + 8 * 60 * 60_000,
    }
    writeClaudeFile(creds, next)
    return next
  } catch {
    return null
  }
}

const CLAUDE_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'claude-code/2.1.0',
}

function claudeWindow(id, label, raw) {
  if (!raw || typeof raw !== 'object') return null
  const used = clampPercent(raw.utilization)
  return {
    id,
    label,
    usedPercent: used,
    remainingPercent: used === null ? null : 100 - used,
    remaining: null,
    entitlement: null,
    resetAt: toIso(raw.resets_at ?? raw.resetsAt),
    unlimited: false,
    detail: null,
  }
}

async function loadClaude() {
  let creds = await readClaudeCredential()
  if (!creds) {
    return baseProvider('claude', {
      status: 'signin',
      source: 'No credentials',
      message:
        'No Claude Code credentials found. Run `claude` and sign in, or set CLAUDE_CODE_OAUTH_TOKEN.',
      command: 'claude',
    })
  }

  if (creds.expiresAt && Date.now() + EXPIRY_BUFFER_MS >= creds.expiresAt) {
    const refreshed = await refreshClaude(creds)
    if (refreshed) creds = refreshed
  }

  const authHeaders = { ...CLAUDE_HEADERS, Authorization: `Bearer ${creds.accessToken}` }

  let usage
  try {
    usage = await fetchResponse(CLAUDE_USAGE_URL, { headers: authHeaders })
  } catch (error) {
    return baseProvider('claude', {
      status: 'error',
      source: creds.source,
      message: `Could not reach Anthropic: ${error instanceof Error ? error.message : String(error)}`,
      command: 'claude',
    })
  }

  if (usage.status === 401 || usage.status === 403) {
    return baseProvider('claude', {
      status: 'expired',
      source: creds.source,
      message: 'Claude session expired. Run `claude` to sign in again, then refresh.',
      command: 'claude',
    })
  }

  if (!usage.ok || !usage.body) {
    return baseProvider('claude', {
      status: 'error',
      source: creds.source,
      message: `Claude usage request failed (HTTP ${usage.status}).`,
      command: 'claude',
    })
  }

  let profile = null
  try {
    profile = await fetchResponse(CLAUDE_PROFILE_URL, { headers: authHeaders })
  } catch {
    // The usage response is enough when the profile call fails.
  }

  const body = usage.body
  const windows = [
    claudeWindow('session', 'Session (5h)', body.five_hour ?? body.fiveHour),
    claudeWindow('weekly', 'Weekly · all models', body.seven_day ?? body.sevenDay),
    claudeWindow('opus', 'Weekly · Opus', body.seven_day_opus ?? body.sevenDayOpus),
    claudeWindow('sonnet', 'Weekly · Sonnet', body.seven_day_sonnet ?? body.sevenDaySonnet),
  ].filter(Boolean)

  const seen = new Set(windows.map((w) => w.id))
  const limits = Array.isArray(body.limits) ? body.limits : []
  for (const limit of limits) {
    const display = limit?.scope?.model?.display_name ?? limit?.scope?.model?.displayName
    if (typeof display !== 'string' || !display) continue
    const id = `model-${display.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    if (seen.has(id)) continue
    seen.add(id)
    const used = clampPercent(limit.percent)
    windows.push({
      id,
      label: `Weekly · ${display}`,
      usedPercent: used,
      remainingPercent: used === null ? null : 100 - used,
      remaining: null,
      entitlement: null,
      resetAt: toIso(limit.resets_at ?? limit.resetsAt),
      unlimited: false,
      detail: null,
    })
  }

  const extra = body.extra_usage ?? body.extraUsage
  if (extra?.is_enabled ?? extra?.isEnabled) {
    const used = clampPercent(extra.utilization)
    const monthly = asNumber(extra.monthly_limit ?? extra.monthlyLimit)
    const spent = asNumber(extra.used_credits ?? extra.usedCredits)
    windows.push({
      id: 'extra',
      label: 'Extra usage',
      usedPercent: used,
      remainingPercent: used === null ? null : 100 - used,
      remaining: null,
      entitlement: monthly,
      resetAt: null,
      unlimited: false,
      detail:
        monthly !== null && spent !== null
          ? `${spent.toLocaleString()} of ${monthly.toLocaleString()} ${extra.currency ?? ''}`.trim()
          : null,
    })
  }

  const profileBody = profile?.body ?? {}
  const account = profileBody.account ?? profileBody
  const organization = profileBody.organization ?? {}

  return baseProvider('claude', {
    status: 'ok',
    plan:
      organization.organization_type ??
      account.subscription_type ??
      account.subscriptionType ??
      creds.subscriptionType,
    account: account.email ?? null,
    source: creds.source,
    windows,
    note: creds.rateLimitTier ? `Rate limit tier: ${creds.rateLimitTier}` : null,
  })
}

// ---------------------------------------------------------------------------
// Snapshot API

const LOADERS = {
  codex: loadCodex,
  copilot: loadCopilot,
  claude: loadClaude,
}

function publicSnapshot() {
  const providers = PROVIDER_ORDER.map(
    (id) => cache?.providers.find((provider) => provider.id === id) ?? baseProvider(id, { status: 'loading' }),
  )
  const ageMs = cache ? Date.now() - cache.at : 0
  return {
    providers,
    fetchedAt: new Date(cache?.at ?? Date.now()).toISOString(),
    ageMs,
  }
}

export async function getSnapshot(options = {}) {
  const force = options.force === true
  const only = options.provider && LOADERS[options.provider] ? options.provider : null
  const fresh = cache !== null && Date.now() - cache.at < CACHE_TTL_MS

  if (!force && !only && fresh) return publicSnapshot()
  if (!only && inflight) return inflight

  const run = (async () => {
    const ids = only ? [only] : PROVIDER_ORDER
    const loaded = await Promise.all(
      ids.map(async (id) => {
        try {
          return await LOADERS[id]()
        } catch (error) {
          return providerError(id, error)
        }
      }),
    )
    const merged = new Map((cache?.providers ?? []).map((provider) => [provider.id, provider]))
    for (const provider of loaded) merged.set(provider.id, provider)
    cache = {
      at: Date.now(),
      providers: PROVIDER_ORDER.map((id) => merged.get(id)).filter(Boolean),
    }
    return publicSnapshot()
  })()

  if (!only) inflight = run
  try {
    return await run
  } finally {
    if (!only && inflight === run) inflight = null
  }
}

export function __clearCache() {
  cache = null
  inflight = null
}

export const __paths = {
  codex: CODEX_AUTH_FILE,
  claude: CLAUDE_CREDENTIALS_FILE,
  copilotHosts: COPILOT_HOSTS_FILES,
  db: DB_CANDIDATES,
  dayMs: DAY_MS,
}
