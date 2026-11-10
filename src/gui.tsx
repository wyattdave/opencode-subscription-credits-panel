import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js'
import { Command, MenuItem, Panel, Plugin, Store, Style } from '@opencode/plugin/gui'
import { Schema } from 'effect'
import { Credits } from '../rpc.mjs'
import css from './panel.css?inline'
import { usedText } from './usage-text.mjs'
import { setProviderVisible, visibleProviders } from './visibility.mjs'

type UsageWindow = {
  id: string
  label: string
  usedPercent: number | null
  remainingPercent: number | null
  remaining: number | null
  entitlement: number | null
  resetAt: string | null
  unlimited: boolean
  detail: string | null
}

type Provider = {
  id: 'codex' | 'copilot' | 'claude' | 'go' | 'cursor'
  name: string
  status: 'ok' | 'expired' | 'signin' | 'error' | 'loading' | 'unavailable'
  plan: string | null
  account: string | null
  source: string | null
  windows: UsageWindow[]
  note: string | null
  message: string | null
  command: string | null
  updatedAt: string
}

type Snapshot = {
  providers: Provider[]
  fetchedAt: string
  ageMs: number
}

const ICONS: Record<Provider['id'], string> = {
  codex: 'terminal',
  copilot: 'github',
  claude: 'brain',
  go: 'terminal',
  cursor: 'terminal',
}

const PROVIDERS = [
  { id: 'codex', name: 'ChatGPT / Codex' },
  { id: 'copilot', name: 'GitHub Copilot' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'go', name: 'OpenCode Go' },
  { id: 'cursor', name: 'Cursor' },
]

const PLAN_LABELS: Record<string, string> = {
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  free: 'Free',
  team: 'ChatGPT Team',
  business: 'ChatGPT Business',
  enterprise: 'ChatGPT Enterprise',
  individual: 'Copilot Individual',
  individual_max: 'Copilot Max',
  copilot_pro: 'Copilot Pro',
  copilot_business: 'Copilot Business',
  copilot_enterprise: 'Copilot Enterprise',
  max: 'Claude Max',
}

export default Plugin.define({
  stores: {
    visibility: Store.global(Schema.Struct({ hidden: Schema.Array(Schema.String) }), { hidden: [] }),
  },
  i18n: {
    en: {
      'menu.title': 'Account usage',
      'command.open': 'Open account usage',
      'panel.title': 'Usage & credits',
      'panel.refresh': 'Refresh usage',
    },
  },
  setup(ctx) {
    ctx.add(Style, css)

    const open = () => {
      const session = ctx.sessions.current()
      if (session) {
        ctx.layout.open(`${ctx.id}:credits`, session)
        return
      }
      ctx.toast.show({
        title: ctx.t('panel.title'),
        description: 'Open a session to use the account usage panel.',
      })
    }

    ctx.add(Command, () => ({ id: 'open', title: ctx.t('command.open'), run: open }))

    ctx.add(MenuItem, () => {
      const session = ctx.sessions.current()
      return {
        menu: 'session.panel' as const,
        id: 'credits',
        title: ctx.t('menu.title'),
        description: 'Codex · Copilot · Claude · Go · Cursor',
        icon: 'window-analytics' as const,
        opened: Boolean(session && ctx.layout.state(`${ctx.id}:credits`, session) !== 'closed'),
        run: open,
      }
    })

    const tab = {
      id: 'credits',
      closable: 'compact' as const,
      fallback: true,
      get title() {
        return ctx.t('menu.title')
      },
    }

    ctx.add(Panel, {
      id: 'credits',
      region: 'side',
      mobile: {
        title: ctx.t('menu.title'),
        order: 60,
        kind: 'drawer',
        icon: 'window-analytics',
        cached: true,
      },
      list: (input: { open: readonly string[] }) =>
        input.open.includes('credits') ? [tab] : [],
      render: (props: any) => (
        <Show when={props.session} keyed>
          {(session: any) => <CreditsPanel ctx={ctx} session={session} />}
        </Show>
      ),
    })
  },
})

function CreditsPanel(props: { ctx: any; session: any }) {
  const [data, setData] = createSignal<Snapshot | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const settingsID = `oc-provider-settings-${createUniqueId()}`
  const hidden = () => props.ctx.stores.visibility.value.hidden
  const setVisible = (id: string, visible: boolean) => {
    props.ctx.stores.visibility.set({ hidden: setProviderVisible(hidden(), id, visible) })
  }
  const providers = () => visibleProviders(data()?.providers ?? [], hidden())
  let disposed = false

  const client = () => props.session.server.client.rpc(Credits)
  const call = (method: 'snapshot' | 'refresh', input: Record<string, unknown>) =>
    client()[method](input, { location: props.session.location })

  const load = async (force: boolean) => {
    if (busy()) return
    setBusy(true)
    setError('')
    try {
      const next: Snapshot = await call(force ? 'refresh' : 'snapshot', {})
      if (disposed) return
      setData(next)
      const stale = next.ageMs > 60_000 || next.providers.some((item) => item.status !== 'ok')
      if (!force && stale) {
        const fresh: Snapshot = await call('refresh', {})
        if (!disposed) setData(fresh)
      }
    } catch (caught) {
      if (!disposed) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  onMount(() => {
    void load(false)
    const timer = setInterval(() => void load(true), 90_000)
    onCleanup(() => clearInterval(timer))
  })

  onCleanup(() => {
    disposed = true
  })

  return (
    <div class="oc-panel" aria-busy={busy()}>
      <header class="oc-header">
        <div>
          <p class="oc-eyebrow">Accounts</p>
          <h1>{props.ctx.t('panel.title')}</h1>
          <p class="oc-tagline">Your subscriptions, at a glance</p>
        </div>
        <div class="oc-header-actions">
          <button
            type="button"
            class="oc-settings-button"
            title="Provider settings"
            aria-label="Provider settings"
            aria-expanded={settingsOpen()}
            aria-controls={settingsID}
            onClick={() => setSettingsOpen(!settingsOpen())}
          >
            <span aria-hidden="true">⚙</span>
          </button>
          <props.ctx.ui.IconButton
            icon="refresh"
            label={props.ctx.t('panel.refresh')}
            size="normal"
            busy={busy()}
            onClick={() => void load(true)}
          />
        </div>
      </header>

      <Show when={settingsOpen()}>
        <section class="oc-settings" id={settingsID} aria-label="Provider settings">
          <div class="oc-settings-heading">
            <div>
              <h2>Visible providers</h2>
              <p>Choose the accounts shown in this panel.</p>
            </div>
            <button type="button" class="oc-text-button" onClick={() => props.ctx.stores.visibility.set({ hidden: [] })}>Show all</button>
          </div>
          <For each={PROVIDERS}>
            {(provider) => (
              <label class="oc-provider-toggle">
                <span>{provider.name}</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={!hidden().includes(provider.id)}
                  onChange={(event) => setVisible(provider.id, event.currentTarget.checked)}
                />
              </label>
            )}
          </For>
          <p class="oc-settings-footnote">Saved automatically for all sessions on this device. Hiding a card does not disconnect its account.</p>
        </section>
      </Show>

      <Show when={error()}>
        <div class="oc-banner oc-banner-error" role="alert">
          <CodeText text={error()} />
        </div>
      </Show>

      <Show
        when={data()}
        fallback={
          <div class="oc-skeletons" aria-label="Loading usage">
            <div class="oc-skeleton" />
            <div class="oc-skeleton" />
            <div class="oc-skeleton" />
          </div>
        }
      >
        {(snapshot) => (
          <>
            <p class="oc-updated" role="status">
              {busy() ? 'Refreshing accounts…' : `Updated ${relativeTime(snapshot().fetchedAt)}`}
            </p>
            <Show when={providers().length === 0}>
              <div class="oc-empty" role="status">
                <h2>No providers shown</h2>
                <p>Your accounts are hidden, not disconnected.</p>
                <button type="button" class="oc-command" onClick={() => setSettingsOpen(true)}>Choose providers</button>
              </div>
            </Show>
            <For each={providers()}>
              {(provider) => <ProviderCard ctx={props.ctx} provider={provider} onSignedIn={() => load(true)} />}
            </For>
          </>
        )}
      </Show>

      <footer class="oc-footer">
        Credentials stay on this machine and are sent only to their provider. Access tokens
        never enter this panel.
      </footer>
    </div>
  )
}

function ProviderCard(props: { ctx: any; provider: Provider; onSignedIn: () => Promise<void> }) {
  const provider = () => props.provider
  const command = () => provider().command

  const copyCommand = async () => {
    if (!command()) return
    try {
      await props.ctx.system.copy(command())
      props.ctx.toast.show({
        title: 'Command copied',
        description: command() ?? undefined,
        variant: 'success',
      })
    } catch {
      // The command stays visible if the clipboard is unavailable.
    }
  }

  return (
    <article class={`oc-card oc-${provider().id}`} data-status={provider().status}>
      <div class="oc-card-head">
        <div class="oc-identity">
          <span class="oc-glyph" aria-hidden="true">
            <props.ctx.ui.Icon name={ICONS[provider().id]} size="small" />
          </span>
          <div class="oc-identity-text">
            <h2>{provider().name}</h2>
            <p class="oc-meta" title={provider().plan ?? provider().source ?? undefined}>
              {planLabel(provider().plan) ?? provider().source ?? 'No credentials'}
            </p>
          </div>
        </div>
        <span class={`oc-badge oc-badge-${provider().status}`}>{statusLabel(provider().status)}</span>
      </div>

      <Show when={provider().account}>
        <p class="oc-account">{provider().account}</p>
      </Show>

      <Show when={provider().windows.length > 0}>
        <div class="oc-windows">
          <For each={provider().windows}>{(item) => <UsageRow window={item} />}</For>
        </div>
      </Show>

      <Show when={provider().note}>
        <p class="oc-note">{provider().note}</p>
      </Show>

      <Show when={provider().message && !(provider().id === 'codex' && ['expired', 'signin'].includes(provider().status))}>
        <div class="oc-alert" role="note">
          <CodeText text={provider().message ?? ''} />
        </div>
      </Show>

      <Show when={provider().id === 'codex'}>
        <CodexSignIn ctx={props.ctx} provider={provider()} onSignedIn={props.onSignedIn} />
      </Show>

      <Show when={command() && provider().id !== 'codex'}>
        <button
          type="button"
          class="oc-command"
          title={`Copy ${command()}`}
          onClick={() => void copyCommand()}
        >
          <props.ctx.ui.Icon name="copy" size="small" />
          <span>{command()}</span>
        </button>
      </Show>
    </article>
  )
}

type LoginState = {
  status: 'idle' | 'starting' | 'pending' | 'complete' | 'error'
  verificationUrl: string | null
  expiresAt: string | null
  message: string | null
}

function CodexSignIn(props: { ctx: any; provider: Provider; onSignedIn: () => Promise<void> }) {
  const [login, setLogin] = createSignal<LoginState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  let disposed = false
  let checking = false
  let completed = false
  let revision = 0
  const client = () => props.ctx.client.rpc(Credits)

  const check = async () => {
    if (checking || busy()) return
    checking = true
    const currentRevision = revision
    try {
      const next: LoginState = await client().codexLoginStatus({})
      if (disposed || revision !== currentRevision) return
      setLogin(next)
      setError('')
      if (next.status === 'complete' && !completed) {
        completed = true
        await props.onSignedIn()
        if (!disposed) props.ctx.toast.show({ title: 'ChatGPT connected', variant: 'success' })
      }
    } catch {
      if (!disposed && login()?.status === 'pending') setError('Unable to check sign-in. Retrying…')
    } finally {
      checking = false
    }
  }

  const openBrowser = async () => {
    const url = login()?.verificationUrl
    if (!url) return
    const target = new URL(url)
    // Only an official OpenAI authorization page can be opened by this action.
    if (target.origin !== 'https://auth.openai.com' || target.pathname !== '/oauth/authorize') return
    try {
      await props.ctx.system.openExternal(url)
    } catch {
      if (!disposed) setError('Could not open your browser. Use Copy sign-in link below to open it manually.')
    }
  }

  const start = async () => {
    if (busy()) return
    setBusy(true)
    setError('')
    completed = false
    revision++
    try {
      const next: LoginState = await client().codexLoginStart({})
      if (disposed) return
      setLogin(next)
      if (next.status === 'pending') await openBrowser()
    } catch {
      if (!disposed) setError('Could not start sign-in. Please retry.')
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  const cancel = async () => {
    setBusy(true)
    revision++
    try {
      const next: LoginState = await client().codexLoginCancel({})
      if (!disposed) { setLogin(next); setError('') }
    } catch {
      if (!disposed) setError('Could not cancel sign-in. Please retry.')
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  onMount(() => {
    void check()
    const timer = setInterval(() => {
      if (login()?.status === 'pending' || login()?.status === 'starting') void check()
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => { disposed = true })

  return (
    <Show when={props.provider.status !== 'ok' || login()?.status === 'pending'}>
      <div class="oc-login">
        <Show when={login()?.status === 'pending'} fallback={
          <>
            <p class="oc-note">Connect in your browser. No Codex installation or terminal needed.</p>
            <button class="oc-signin" type="button" disabled={busy()} onClick={() => void start()}>
              {busy() ? 'Opening sign-in…' : 'Sign in with ChatGPT'}
            </button>
          </>
        }>
          <p class="oc-note" role="status">Finish signing in on the ChatGPT page. Usage refreshes automatically.</p>
          <p class="oc-note">No device code or security-setting change needed.</p>
          <div class="oc-login-actions">
            <button class="oc-signin" type="button" onClick={() => void openBrowser()}>Open browser</button>
            <button class="oc-command" type="button" disabled={busy()} onClick={() => void cancel()}>Cancel</button>
          </div>
          <button class="oc-command" type="button" disabled={!login()?.verificationUrl} onClick={() => {
            void props.ctx.system.copy(login()?.verificationUrl ?? '').then(() => {
              props.ctx.toast.show({ title: 'Sign-in link copied', variant: 'success' })
            }).catch(() => setError('Could not copy the sign-in link. Please retry opening the browser.'))
          }}>Copy sign-in link</button>
        </Show>
        <Show when={login()?.status === 'error' || error()}>
          <div class="oc-alert" role="alert">{error() || login()?.message}</div>
        </Show>
      </div>
    </Show>
  )
}

function UsageRow(props: { window: UsageWindow }) {
  const item = () => props.window
  const remaining = () =>
    item().unlimited
      ? 100
      : (item().remainingPercent ??
        (item().usedPercent === null ? null : 100 - (item().usedPercent as number)))

  const tone = () => {
    const value = remaining()
    if (value === null) return 'muted'
    if (value <= 10) return 'low'
    if (value <= 25) return 'warn'
    return 'ok'
  }

  const remainingText = () => {
    if (item().unlimited) return 'Unlimited'
    if (item().remaining !== null && item().entitlement) {
      return `${formatNumber(item().remaining as number)} of ${formatNumber(item().entitlement as number)} left`
    }
    if (remaining() !== null) return `${Math.round(remaining() as number)}% left`
    return '—'
  }

  return (
    <div class={`oc-window oc-${tone()}`}>
      <div class="oc-window-top">
        <span>{item().label}</span>
        <strong>{remainingText()}</strong>
      </div>
      <div
        class="oc-meter"
        role="img"
        aria-label={`${item().label}: ${remainingText()}`}
      >
        <div class="oc-meter-fill" style={{ width: `${remaining() ?? 0}%` }} />
      </div>
      <div class="oc-window-bottom">
        <span>{usedText(item())}</span>
        <span>{resetText(item().resetAt)}</span>
      </div>
    </div>
  )
}

function CodeText(props: { text: string }) {
  const parts = () => props.text.split(/(`[^`]+`)/g).filter(Boolean)
  return (
    <>
      <For each={parts()}>
        {(part) =>
          part.startsWith('`') && part.endsWith('`') ? (
            <code>{part.slice(1, -1)}</code>
          ) : (
            <>{part}</>
          )
        }
      </For>
    </>
  )
}

function planLabel(plan: string | null) {
  if (!plan) return null
  const key = plan.toLowerCase()
  if (PLAN_LABELS[key]) return PLAN_LABELS[key]
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function statusLabel(status: Provider['status']) {
  switch (status) {
    case 'ok':
      return 'Live'
    case 'expired':
      return 'Sign in'
    case 'signin':
      return 'Not connected'
    case 'error':
      return 'Error'
    case 'unavailable':
      return 'Unavailable'
    default:
      return 'Loading'
  }
}

function formatNumber(value: number) {
  const rounded = Math.round(value * 10) / 10
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: rounded < 100 ? 1 : 0,
  }).format(rounded)
}

function relativeTime(iso: string) {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'just now'
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function resetText(iso: string | null) {
  if (!iso) return ''
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target)) return ''
  const diff = target - Date.now()
  if (diff <= 0) return 'Resets soon'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'Resets in <1m'
  if (minutes < 60) return `Resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return `Resets in ${hours}h${rest ? ` ${rest}m` : ''}`
  const days = Math.floor(hours / 24)
  if (days <= 7) return `Resets in ${days}d`
  return `Resets ${new Date(target).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}
