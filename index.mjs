import { Plugin } from '@opencode/plugin'
import { Credits } from './rpc.mjs'
import { getSnapshot } from './providers.mjs'
import { createCodexLogin } from './codex-login.mjs'

// One login per server process, not one per project/location. Keep it available
// across plugin hot reloads, without allowing different locations to bind twice.
const loginKey = Symbol.for('opencode-credits-panel.browser-login.v1')
const sharedLogin = globalThis[loginKey] ??= { login: createCodexLogin(), owners: 0 }

/**
 * Server half of the plugin. It owns credential access and outbound requests so
 * the renderer only ever receives normalized, token-free usage data.
 */
export default Plugin.define({
  id: 'opencode-credits-panel',
  async setup(ctx) {
    const login = sharedLogin.login
    sharedLogin.owners++
    await ctx.rpc.register(Credits, {
      snapshot: async () => getSnapshot(),
      refresh: async (input) => getSnapshot({ force: true, provider: input?.provider }),
      codexLoginStart: async () => login.start(),
      codexLoginStatus: async () => login.status(),
      codexLoginCancel: async () => login.cancel(),
    })
    return () => {
      sharedLogin.owners--
      if (sharedLogin.owners === 0) login.cancel()
    }
  },
})
