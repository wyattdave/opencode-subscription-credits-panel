# opencode-subscription-credits-panel

An OpenCode Desktop side-panel plugin that shows remaining account usage for
**ChatGPT / Codex**, **GitHub Copilot**, and **Claude Code**.

Everything is resolved on the OpenCode server. The renderer only ever receives
normalized usage numbers — raw tokens never cross the RPC boundary.

## Install

### From npm

Add the package name to your OpenCode plugin config:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-subscription-credits-panel"]
}
```

### From a local checkout

```powershell
git clone https://github.com/wyattdave/opencode-subscription-credits-panel
cd opencode-subscription-credits-panel
npm install
npm run build
```

Then point your config at the checkout path:

```jsonc
{
  "plugins": ["C:/path/to/opencode-subscription-credits-panel"]
}
```

OpenCode picks the plugin up on config reload; open the session side panel and
click **+** to see **Account usage** (restart the desktop app if it is missing).

## Use

In any session, open the side panel and click **+** → **Account usage**.
A `Refresh` button re-queries all providers; auto-refresh runs on open.

## Where credentials come from

| Provider | Source |
| --- | --- |
| ChatGPT / Codex | `~/.codex/auth.json`, then the OpenCode SQLite credential store (`openai`) |
| GitHub Copilot | OpenCode SQLite credential store (`github-copilot`), legacy `hosts.json`, env vars |
| Claude Code | `~/.claude/.credentials.json`, `CLAUDE_CODE_OAUTH_TOKEN` |

Expired OAuth tokens owned by this plugin (Codex and Claude credential files)
are refreshed server-side and written back to the original file when the
refresh succeeds. OpenCode's own credential-store tokens are never rotated.

## Not connected?

- **Codex expired** → click **Sign in with ChatGPT** in the Codex card. Your
  browser opens the normal ChatGPT OAuth sign-in page. Sign in and approve. A
  loopback-only callback completes authorization using PKCE. The panel saves the
  credentials to `~/.codex/auth.json` and refreshes usage automatically. No CLI
  installation or device-code setting is needed. Attempts expire after 15
  minutes; **Cancel** stops the callback server. Callback ports 1455 and 1457
  are tried without interrupting other apps. `codex login` still works as an
  alternative. Signing in here does not replace OpenCode's provider
  credentials: its direct-access OAuth token lacks the ChatGPT account claims
  needed by the usage API.
- **Claude not connected** → run `claude` and sign in, or set
  `CLAUDE_CODE_OAUTH_TOKEN`.

## Architecture

- `index.mjs` — server plugin entry, registers RPC handlers.
- `rpc.mjs` — shared RPC contract (`snapshot`, `refresh`, sign-in status).
- `providers.mjs` — credential discovery, token refresh, usage fetching/parsing.
- `codex-login.mjs` — server-side browser OAuth, PKCE callback, and credential saving.
- `src/gui.tsx` — panel definition, **+** menu item, command, and UI components.
- `src/panel.css` — panel styling.
- `dist/gui-experimental.cjs` — built GUI bundle loaded by the desktop renderer.

```powershell
npm run typecheck        # type-check the GUI sources
npm test                 # sign-in flow unit tests
npm run build            # emit dist/gui-experimental.cjs
node scripts/probe.mjs   # print raw provider results without the UI
```

The GUI bundle must not import Node built-ins at top level; the host externalizes
`solid-js`, `@opencode/plugin/gui`, `@opencode/plugin/rpc`, and `effect`.

## Publishing

`npm publish` runs `prepublishOnly` first: typecheck, tests, and the GUI bundle
build. The `files` allowlist ships only the runtime modules plus `dist` and
docs. Release flow:

```powershell
npm version patch   # or minor / major
npm publish         # logs in to npm interactively on first use
git push --follow-tags
```

MIT — see [LICENSE](LICENSE).

## Troubleshooting

Check that the plugin is loaded:

```powershell
opencode-cli api get /api/plugin
```

`opencode-credits-panel` should appear with `server`, `rpc`, and `gui` features
and `state.status: "active"`. Server-side logs live in
`~/.local/share/opencode/log/opencode.log`.
