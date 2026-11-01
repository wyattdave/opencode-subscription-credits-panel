import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyPluginEdit, main, PACKAGE_NAME, parseArgs, resolveConfigPath } from '../bin/setup.mjs'

const TEMP_ROOT = 'C:/Users/dwyat/AppData/Local/Temp/opencode'
const tempDir = () => mkdtempSync(join(TEMP_ROOT, 'setup-'))

/** Comment-stripping JSON.parse for JSONC documents. */
function parseJsonc(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '"') { j++; break }
        j++
      }
      out += text.slice(i, j)
      i = j
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    out += ch
    i++
  }
  // Drop trailing commas outside strings (some configs use them; real JSONC
  // parsers tolerate them).
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function mkdirTracked(dir) {
  mkdirSync(dir, { recursive: true })
}

test('appends to a single-line plugins array', () => {
  const result = applyPluginEdit('{\n  "plugins": ["model-context"]\n}\n')
  assert.equal(result.changed, true)
  assert.deepEqual(JSON.parse(result.text).plugins, ['model-context', PACKAGE_NAME])
})

test('appends to a multi-line plugins array and keeps other entries', () => {
  const source = '{\n  "model": "gpt",\n  "plugins": [\n    "model-context",\n    "other"\n  ]\n}\n'
  const result = applyPluginEdit(source)
  assert.equal(result.changed, true)
  const parsed = JSON.parse(result.text)
  assert.deepEqual(parsed.plugins, ['model-context', 'other', PACKAGE_NAME])
  assert.equal(parsed.model, 'gpt')
})

test('append preserves comments elsewhere in the config', () => {
  const source = '{\n  // schema pin\n  "model": "gpt",\n  "plugins": [\n    "model-context"\n  ] /* tail */\n}\n'
  const result = applyPluginEdit(source)
  assert.match(result.text, /\/\/ schema pin/)
  assert.match(result.text, /\/\* tail \*\//)
  assert.deepEqual(parseJsonc(result.text).plugins, ['model-context', PACKAGE_NAME])
})

test('append adds the separator before a trailing comment, not after', () => {
  const source = '{\n  "plugins": [\n    "model-context" // keep description\n  ]\n}\n'
  const result = applyPluginEdit(source)
  assert.match(result.text, /"model-context", \/\/ keep description/)
  const parsed = parseJsonc(result.text)
  assert.deepEqual(parsed.plugins, ['model-context', PACKAGE_NAME])
})

test('append reuses an existing separator comma even with a trailing comment', () => {
  const source = '{\n  "plugins": [\n    "model-context", // keep description\n  ]\n}\n'
  const result = applyPluginEdit(source)
  assert.doesNotMatch(result.text.replace(/\/\/[^\n]*/g, ''), /,\s*,/)
  assert.deepEqual(parseJsonc(result.text).plugins, ['model-context', PACKAGE_NAME])
})

test('append tolerates commented-out entries in the array', () => {
  const source = '{\n  "plugins": [\n    "model-context",\n    // "disabled-plugin",\n    "active"\n  ]\n}\n'
  const result = applyPluginEdit(source)
  const parsed = parseJsonc(result.text)
  assert.deepEqual(parsed.plugins, ['model-context', 'active', PACKAGE_NAME])
  assert.match(result.text, /\/\/ "disabled-plugin",/)
})

test('adding twice is a no-op', () => {
  const source = '{\n  "plugins": ["other"]\n}\n'
  const once = applyPluginEdit(source)
  const twice = applyPluginEdit(once.text)
  assert.equal(twice.changed, false)
  assert.equal(twice.text, once.text)
})

test('a commented-out package name does not count as registered', () => {
  const source = '{\n  "plugins": [\n    "other",\n    // "opencode-subscription-credits-panel",\n  ]\n}\n'
  const result = applyPluginEdit(source)
  assert.equal(result.changed, true)
  const parsed = parseJsonc(result.text)
  assert.ok(parsed.plugins.includes(PACKAGE_NAME))
})

test('migrates a legacy local path entry to the package name', () => {
  for (const path of ['C:/x/opencode-credits', 'C:/x/opencode-credits-panel', 'C:/GitHub/opencode-subscription-credits-panel']) {
    const result = applyPluginEdit(`{\n  "plugins": ["${path}"]\n}\n`)
    const parsed = JSON.parse(result.text)
    assert.deepEqual(parsed.plugins, [PACKAGE_NAME])
  }
})

test('migrates the first legacy path and drops additional stale ones', () => {
  const source = '{\n  "plugins": [\n    "C:/old/opencode-credits",\n    "C:/older/opencode-credits-panel",\n    "model-context"\n  ]\n}\n'
  const result = applyPluginEdit(source)
  const parsed = JSON.parse(result.text)
  assert.deepEqual(parsed.plugins, [PACKAGE_NAME, 'model-context'])
})

test('legacy paths next to the package name are cleaned up', () => {
  const source = '{\n  "plugins": [\n    "C:/old/opencode-credits",\n    "opencode-subscription-credits-panel"\n  ]\n}\n'
  const result = applyPluginEdit(source)
  const parsed = JSON.parse(result.text)
  assert.deepEqual(parsed.plugins, [PACKAGE_NAME])
})

test('migrating a legacy path keeps the surrounding formatting', () => {
  const source = '{\n  "plugins": [\n    "C:/GitHub/CAP-cli/plugin",\n    "C:/GitHub/opencode-subscription-credits-panel"\n  ]\n}\n'
  const result = applyPluginEdit(source)
  const parsed = JSON.parse(result.text)
  assert.deepEqual(parsed.plugins, ['C:/GitHub/CAP-cli/plugin', PACKAGE_NAME])
  // The migrated entry stays on its own line with its original indentation.
  assert.match(result.text, /"C:\/GitHub\/CAP-cli\/plugin",\n    "opencode-subscription-credits-panel"/)
})

test('migration ignores nested same-key objects and comments', () => {
  const source = '{\n  // "C:/commented/opencode-credits"\n  "nested": { "plugins": ["inner"] },\n  "plugins": [\n    /* old */ "C:/old/opencode-credits"\n  ]\n}\n'
  const result = applyPluginEdit(source)
  assert.match(result.text, /\/\/ "C:\/commented\/opencode-credits"/)
  const parsed = parseJsonc(result.text)
  assert.deepEqual(parsed.nested.plugins, ['inner'])
  assert.deepEqual(parsed.plugins, [PACKAGE_NAME])
})

test('remove deletes the entry and keeps the rest valid', () => {
  const source = '{\n  "plugins": [\n    "model-context",\n    "opencode-subscription-credits-panel",\n    "other"\n  ]\n}\n'
  const result = applyPluginEdit(source, { mode: 'remove' })
  assert.equal(result.changed, true)
  assert.deepEqual(JSON.parse(result.text).plugins, ['model-context', 'other'])
})

test('remove handles first, last and duplicated entries', () => {
  const first = JSON.parse(applyPluginEdit('{\n  "plugins": ["opencode-subscription-credits-panel", "a"]\n}\n', { mode: 'remove' }).text)
  assert.deepEqual(first.plugins, ['a'])
  const last = JSON.parse(applyPluginEdit('{\n  "plugins": ["a", "opencode-subscription-credits-panel"]\n}\n', { mode: 'remove' }).text)
  assert.deepEqual(last.plugins, ['a'])
  const sole = JSON.parse(applyPluginEdit('{\n  "plugins": [\n    "opencode-subscription-credits-panel"\n  ]\n}\n', { mode: 'remove' }).text)
  assert.deepEqual(sole.plugins, [])
  const duplicate = JSON.parse(applyPluginEdit('{\n  "plugins": ["opencode-subscription-credits-panel", "b", "opencode-subscription-credits-panel"]\n}\n', { mode: 'remove' }).text)
  assert.deepEqual(duplicate.plugins, ['b'])
})

test('remove is a no-op when the plugin is absent or the array is missing', () => {
  assert.equal(applyPluginEdit('{\n  "plugins": ["a"]\n}\n', { mode: 'remove' }).changed, false)
  assert.equal(applyPluginEdit('{\n  "model": "gpt"\n}\n', { mode: 'remove' }).changed, false)
  assert.equal(applyPluginEdit('', { mode: 'remove' }).changed, false)
})

test('creates a plugins array in a config without one', () => {
  const result = applyPluginEdit('{\n  "model": "gpt",\n  "theme": "dark"\n}\n')
  const parsed = JSON.parse(result.text)
  assert.deepEqual(parsed.plugins, [PACKAGE_NAME])
  assert.equal(parsed.model, 'gpt')
  assert.deepEqual(parseJsonc('{\n  /* only\n     comments */\n  "model": "gpt"\n}\n').model, 'gpt')
})

test('creates a whole config from an empty or missing document', () => {
  const fromEmpty = applyPluginEdit('')
  assert.deepEqual(JSON.parse(fromEmpty.text).plugins, [PACKAGE_NAME])
  const fromBare = applyPluginEdit('{ }')
  assert.deepEqual(JSON.parse(fromBare.text).plugins, [PACKAGE_NAME])
})

test('remove leaves no stray separators behind', () => {
  const source = '{\n  "plugins": ["a", "opencode-subscription-credits-panel", /* note */ "b"]\n}\n'
  const result = applyPluginEdit(source, { mode: 'remove' })
  assert.doesNotMatch(result.text.replace(/\/\*[^*]*\*\//g, ''), /,\s*,/)
  assert.deepEqual(parseJsonc(result.text).plugins, ['a', 'b'])
})

test('resolveConfigPath prefers jsonc, honors OPENCODE_CONFIG and --config', () => {
  const home = tempDir()
  try {
    assert.equal(resolveConfigPath(null, {}, home), join(home, '.config', 'opencode', 'opencode.jsonc'))
    const dir = join(home, '.config', 'opencode')
    mkdirTracked(dir)
    writeFileSync(join(dir, 'opencode.json'), '{}')
    writeFileSync(join(dir, 'opencode.jsonc'), '{}')
    assert.ok(resolveConfigPath(null, {}, home).endsWith('opencode.jsonc'))
    assert.equal(resolveConfigPath(null, { OPENCODE_CONFIG: 'D:/custom.jsonc' }, home), 'D:/custom.jsonc')
    assert.equal(resolveConfigPath('D:/explicit.json', {}, home), 'D:/explicit.json')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseArgs flags', () => {
  assert.deepEqual(parseArgs([]), { command: 'add', config: null })
  assert.deepEqual(parseArgs(['remove']), { command: 'remove', config: null })
  assert.deepEqual(parseArgs(['--remove']), { command: 'remove', config: null })
  assert.deepEqual(parseArgs(['--add']), { command: 'add', config: null })
  assert.deepEqual(parseArgs(['--config', 'a.json']), { command: 'add', config: 'a.json' })
  assert.deepEqual(parseArgs(['-c', 'a.json', 'remove']), { command: 'remove', config: 'a.json' })
  assert.deepEqual(parseArgs(['--config=b.json']), { command: 'add', config: 'b.json' })
  assert.deepEqual(parseArgs(['help']), { command: 'help', config: null })
})

test('main adds the plugin to a fresh config under a fake home', () => {
  const home = tempDir()
  try {
    const lines = []
    const code = main([], { environment: {}, home, write: (line) => lines.push(line) })
    assert.equal(code, 0)
    const configPath = join(home, '.config', 'opencode', 'opencode.jsonc')
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).plugins, [PACKAGE_NAME])
    assert.match(lines.join('\n'), /Created/)
    assert.match(lines.join('\n'), /Account usage/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('main backs up the previous config and reports already-registered', () => {
  const home = tempDir()
  try {
    const configPath = join(home, '.config', 'opencode', 'opencode.jsonc')
    mkdirTracked(join(home, '.config', 'opencode'))
    writeFileSync(configPath, '{\n  "plugins": ["other"]\n}\n')
    const first = main([], { environment: {}, home, write: () => {}, fail: () => {} })
    assert.equal(first, 0)
    assert.ok(readdirSync(join(home, '.config', 'opencode')).some((name) => name.startsWith('opencode.jsonc.bak-')))
    const lines = []
    const second = main([], { environment: {}, home, write: (line) => lines.push(line) })
    assert.equal(second, 0)
    assert.match(lines.join('\n'), /already registered/)
    const backups = readdirSync(join(home, '.config', 'opencode')).filter((name) => name.startsWith('opencode.jsonc.bak-'))
    assert.equal(backups.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('main remove flow works end to end', () => {
  const home = tempDir()
  try {
    const configPath = join(home, '.config', 'opencode', 'opencode.jsonc')
    mkdirTracked(join(home, '.config', 'opencode'))
    writeFileSync(configPath, `{\n  "plugins": ["a", "${PACKAGE_NAME}"]\n}\n`)
    const code = main(['remove'], { environment: {}, home, write: () => {} })
    assert.equal(code, 0)
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(parsed.plugins, ['a'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('main remove is a no-op without a config file', () => {
  const home = tempDir()
  try {
    const lines = []
    const code = main(['remove'], { environment: {}, home, write: (line) => lines.push(line) })
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /was not listed/)
    assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.jsonc')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('main --config writes to the given file', () => {
  const home = tempDir()
  const configPath = join(home, 'custom.jsonc')
  try {
    writeFileSync(configPath, '"placeholder"')
    const code = main(['--config', configPath], { environment: {}, home, write: () => {} })
    assert.equal(code, 0)
    const parsed = parseJsonc(readFileSync(configPath, 'utf8'))
    assert.deepEqual(parsed.plugins, [PACKAGE_NAME])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('real-world shaped config survives the full round trip', () => {
  const source = `{
  "$schema": "https://opencode.ai/config.json",
  // Per-project defaults live in opencode.json per repo.
  "model": "github-copilot/gpt-5",
  "small_model": "github-copilot/gpt-5-mini",
  "share": "disabled",
  "autoupdate": true,
  "plugins": [
    "codeapp-js",
    "C:/old/opencode-credits"
  ],
  "mcp": {
    // local servers only
    "context7": {
      "type": "local",
      "command": ["npx", "-y"]
    }
  }
}
`
  const added = applyPluginEdit(source)
  assert.equal(added.changed, true)
  const migrated = parseJsonc(added.text)
  assert.deepEqual(migrated.plugins, ['codeapp-js', PACKAGE_NAME])
  assert.equal(migrated.mcp.context7.type, 'local')

  const removed = applyPluginEdit(added.text, { mode: 'remove' })
  assert.equal(removed.changed, true)
  const after = parseJsonc(removed.text)
  assert.deepEqual(after.plugins, ['codeapp-js'])
  assert.equal(after.autoupdate, true)

  const again = applyPluginEdit(removed.text, { mode: 'remove' })
  assert.equal(again.changed, false)
  assert.equal(again.text, removed.text)
})
