#!/usr/bin/env node
/**
 * One-command setup for the OpenCode subscription credits panel.
 *
 * Usage:
 *   npx opencode-subscription-credits-panel          Register the plugin in your OpenCode config
 *   npx opencode-subscription-credits-panel remove   Remove it again (npx pkg remove)
 *
 * The plugin package ships its GUI bundle prebuilt, so OpenCode installs it
 * straight from the registry without any local build step. This script only
 * needs to manage the `plugins` entry in the global opencode.json(c).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PACKAGE_NAME = 'opencode-subscription-credits-panel'

// ---------------------------------------------------------------------------
// Config discovery

export function resolveConfigPath(explicit, environment = process.env, home = homedir()) {
  if (explicit) return explicit
  if (environment.OPENCODE_CONFIG) return environment.OPENCODE_CONFIG
  for (const file of ['opencode.jsonc', 'opencode.json']) {
    const path = join(home, '.config', 'opencode', file)
    if (existsSync(path)) return path
  }
  return join(home, '.config', 'opencode', 'opencode.jsonc')
}

function displayPath(path, home = homedir()) {
  const prefix = home.endsWith('\\') || home.endsWith('/') ? home.slice(0, -1) : home
  return path.startsWith(prefix) ? `~${path.slice(prefix.length)}` : path
}

// ---------------------------------------------------------------------------
// JSONC-aware scanning. Handles strings and // and /* */ comments without a
// full parser, so untouched parts of the user's config keep their formatting.

function skipString(text, i) {
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '"') return i + 1
    i++
  }
  return text.length
}

function skipComment(text, i) {
  if (text[i] === '/' && text[i + 1] === '/') {
    const end = text.indexOf('\n', i)
    return end === -1 ? text.length : end + 1
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2)
    return end === -1 ? text.length : end + 2
  }
  return null
}

function skipSpaceAndComments(text, i) {
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue }
    const skipped = skipComment(text, i)
    if (skipped !== null) { i = skipped; continue }
    return i
  }
  return text.length
}

function matchBracket(text, openIndex) {
  let depth = 0
  let i = openIndex
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') { i = skipString(text, i + 1); continue }
    if (ch === '/') {
      const skipped = skipComment(text, i)
      if (skipped !== null) { i = skipped; continue }
      i++; continue
    }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** Locates the top-level `plugins` array: open `[`, close `]`, inner bounds. */
export function locatePluginsArray(text) {
  let depth = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      const end = skipString(text, i + 1)
      if (depth === 1) {
        const key = text.slice(i + 1, end - 1)
        const colon = skipSpaceAndComments(text, end)
        if (key === 'plugins' && text[colon] === ':') {
          const open = skipSpaceAndComments(text, colon + 1)
          if (text[open] === '[') {
            const close = matchBracket(text, open)
            if (close !== -1) return { open, close, contentStart: open + 1, contentEnd: close }
          }
        }
      }
      i = end
      continue
    }
    if (ch === '/') {
      const skipped = skipComment(text, i)
      if (skipped !== null) { i = skipped; continue }
      i++; continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    i++
  }
  return null
}

/** Splits array content into top-level element spans on unquoted commas. */
function splitElements(content) {
  const elements = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < content.length) {
    const ch = content[i]
    if (ch === '"') { i = skipString(content, i + 1); continue }
    if (ch === '/') {
      const skipped = skipComment(content, i)
      if (skipped !== null) { i = skipped; continue }
      i++; continue
    }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      elements.push({ start, end: i })
      start = i + 1
    }
    i++
  }
  elements.push({ start, end: content.length })
  return elements
}

function lastSegment(value) {
  return (value.split(/[\\/]+/).pop() ?? '').replace(/\.git$/i, '')
}

// Older manual installs of this plugin registered a local path instead of the
// published package name. They point at the same code, so migrate them. This
// includes checkouts of the current repository that predate npm publishing.
const LEGACY_SEGMENT = /^(opencode-credits|opencode-credits-panel|opencode-subscription-credits-panel)$/i

/** Element text (its string value) after comments have been removed. */
function entryValue(text) {
  const stripped = stripComments(text).trim()
  const match = /^"([^"]*)"$/.exec(stripped)
  return match ? match[1] : null
}

function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      const end = skipString(text, i + 1)
      out += text.slice(i, end)
      i = end
      continue
    }
    if (ch === '/') {
      const skipped = skipComment(text, i)
      if (skipped !== null) { i = skipped; continue }
    }
    out += ch
    i++
  }
  return out
}

/** Index of the last significant character: indentation of an element's line. */
function indentOfLastLine(text) {
  const cut = text.lastIndexOf('\n')
  const line = cut === -1 ? text : text.slice(cut + 1)
  const match = /^[ \t]*/.exec(line)
  return match ? match[0] : ''
}

/** End index (in `content`) of the value that starts between start and end. */
function valueBounds(content, start, end) {
  let i = start
  while (i < end) {
    const ch = content[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue }
    if (ch === '/') {
      const skipped = skipComment(content, i)
      if (skipped !== null) { i = skipped; continue }
    }
    break
  }
  const valueStart = i
  if (content[i] === '"') return { start: valueStart, end: skipString(content, i + 1) }
  if (content[i] === '{' || content[i] === '[') {
    const close = matchBracket(content, i)
    return { start: valueStart, end: close === -1 ? end : close + 1 }
  }
  return { start: valueStart, end }
}

/**
 * Span that removes an element together with one adjacent separator comma, so
 * remaining separators stay balanced. Prefers the comma that follows the
 * element; falls back to the one that precedes it (comments in between win
 * either way once they cannot be preserved).
 */
function removableSpan(content, target) {
  const nextComma = content.indexOf(',', target.end)
  const between = nextComma === -1 ? '' : content.slice(target.end, nextComma)
  if (nextComma !== -1 && !between.includes('/')) return { start: target.start, end: nextComma + 1 }
  let previousComma = -1
  for (let i = target.start - 1; i >= 0; i--) {
    if (content[i] === ',') { previousComma = i; break }
  }
  if (previousComma !== -1) return { start: previousComma, end: target.end }
  if (nextComma !== -1) return { start: target.start, end: nextComma + 1 }
  return { start: target.start, end: target.end }
}

/** Applies edits (spans over `content`, with optional replacement) in one pass. */
function rebuild(source, bounds, content, edits) {
  const merged = []
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    const previous = merged[merged.length - 1]
    if (previous && edit.start <= previous.end) {
      previous.end = Math.max(previous.end, edit.end)
    } else {
      merged.push({ ...edit })
    }
  }
  let next = ''
  let cursor = 0
  for (const edit of merged) {
    next += content.slice(cursor, edit.start) + (edit.replacement ?? '')
    cursor = edit.end
  }
  next += content.slice(cursor)
  return source.slice(0, bounds.contentStart) + next + source.slice(bounds.contentEnd)
}

/** Adds, migrates or removes the plugin entry in a plugins array. */
export function applyPluginEdit(source, { name = PACKAGE_NAME, mode = 'add' } = {}) {
  const entry = `"${name}"`
  const bounds = locatePluginsArray(source)

  if (!bounds) {
    if (mode === 'remove') return { text: source, changed: false }
    return insertTopLevelArray(source, entry)
  }

  const content = source.slice(bounds.contentStart, bounds.contentEnd)
  const elements = splitElements(content).filter((element) => element.end > element.start)
  const entries = elements.map((element) => ({
    element,
    text: stripComments(content.slice(element.start, element.end)).trim(),
  }))

  if (mode === 'remove') {
    const targets = entries
      .filter((item) => item.text === entry)
      .map((item) => item.element)
    if (targets.length === 0) return { text: source, changed: false }
    return { text: rebuild(source, bounds, content, targets.map((element) => removableSpan(content, element))), changed: true }
  }

  const present = entries.some((item) => item.text === entry)
  const legacy = entries
    .filter((item) => item.text !== entry)
    .filter((item) => {
      const value = entryValue(content.slice(item.element.start, item.element.end))
      return value !== null && LEGACY_SEGMENT.test(lastSegment(value))
    })
    .map((item) => item.element)

  if (present) {
    // A stale local path next to the package name contributes nothing.
    if (legacy.length === 0) return { text: source, changed: false }
    return { text: rebuild(source, bounds, content, legacy.map((element) => removableSpan(content, element))), changed: true }
  }

  if (legacy.length > 0) {
    // Migrate: the first leftover entry becomes the package name; any others
    // are dropped together with one adjacent comma to keep the array valid.
    // Replace only the value itself so surrounding indentation survives.
    const first = legacy[0]
    const value = valueBounds(content, first.start, first.end)
    const edits = [{ start: value.start, end: value.end, replacement: entry }]
    for (const element of legacy.slice(1)) edits.push(removableSpan(content, element))
    return { text: rebuild(source, bounds, content, edits), changed: true }
  }

  // Append. The last element span can carry leading comments; commented-out
  // entries collapse to whitespace after stripping, so they are not "real".
  const real = entries.filter((item) => item.text !== '')
  const singleLine = !content.includes('\n')
  if (real.length === 0) {
    const indent = indentOfLastLine(content) || '  '
    const appended = singleLine ? ` ${entry}` : `\n${indent}${entry}`
    return { text: source.slice(0, bounds.contentEnd) + appended + source.slice(bounds.contentEnd), changed: true }
  }

  const last = real[real.length - 1].element
  const indent = indentOfLastLine(content.slice(last.start, last.end))
  // Comments trailing the value must sit after any inserted comma, so anchor
  // at the end of the value, not the end of the span (which includes them).
  const valueStop = valueBounds(content, last.start, last.end).end
  const tail = content.slice(valueStop)
  const tailComma = tail.indexOf(',')
  const tailComment = tail.search(/\/[/*]/)
  const alreadySeparated = tailComma !== -1 && (tailComment === -1 || tailComma < tailComment)

  if (alreadySeparated || tailComment === -1) {
    // Safe to append at the end: an existing comma separates, or the tail is
    // plain whitespace so we can add our own comma right after the element.
    const prefix = alreadySeparated ? '' : ','
    const appended = singleLine ? `${prefix} ${entry}` : `${prefix}\n${indent}${entry}`
    return { text: source.slice(0, bounds.contentEnd) + appended + source.slice(bounds.contentEnd), changed: true }
  }

  // The tail holds a trailing comment and no comma. Put the separator before
  // the comment so the comment cannot swallow it, then append after the tail.
  const separated = `${content.slice(0, valueStop)},${content.slice(valueStop)}\n${indent}${entry}`
  return { text: source.slice(0, bounds.contentStart) + separated + source.slice(bounds.contentEnd), changed: true }
}

function insertTopLevelArray(source, entry) {
  // First `{` that is not inside a comment or a string is the root object.
  let open = -1
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"') { i = skipString(source, i + 1); continue }
    if (ch === '/') {
      const skipped = skipComment(source, i)
      if (skipped !== null) { i = skipped; continue }
    }
    if (ch === '{') { open = i; break }
    i++
  }
  if (open === -1) return { text: `{\n  "plugins": [${entry}]\n}\n`, changed: true }
  const close = matchBracket(source, open)
  if (close === -1) return { text: `{\n  "plugins": [${entry}]\n}\n`, changed: true }
  const inside = source.slice(open + 1, close)
  if (inside.trim() === '') {
    // Truly empty object (no comments either): rewrite it wholesale.
    return {
      text: `${source.slice(0, open)}{\n  "plugins": [${entry}]\n}${source.slice(close + 1)}`,
      changed: true,
    }
  }
  return {
    text: `${source.slice(0, open + 1)}\n  "plugins": [${entry}],${source.slice(open + 1)}`,
    changed: true,
  }
}

// ---------------------------------------------------------------------------
// CLI

export function parseArgs(argv) {
  let command = 'add'
  let config = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config' || arg === '-c') { config = argv[++i] ?? null; continue }
    if (arg.startsWith('--config=')) { config = arg.slice(9); continue }
    if (arg === '--remove' || arg === 'remove') { command = 'remove'; continue }
    if (arg === '--add' || arg === 'add') { command = 'add'; continue }
    if (arg === '-h' || arg === '--help' || arg === 'help') { command = 'help'; continue }
  }
  return { command, config }
}

export function main(argv, { environment = process.env, home = homedir(), write = (line) => console.log(line), fail = (line) => console.error(line) } = {}) {
  const { command, config } = parseArgs(argv)

  if (command === 'help') {
    write('Usage: npx opencode-subscription-credits-panel [--config <path>] [add|remove]')
    write('')
    write('  (default)  Register the plugin in your global OpenCode config.')
    write('  remove     Remove the plugin entry again.')
    write('  --config   Edit this config file instead of the default one.')
    return 0
  }

  const configPath = resolveConfigPath(config, environment, home)
  const exists = existsSync(configPath)
  const source = exists ? readFileSync(configPath, 'utf8') : ''

  let result
  try {
    result = applyPluginEdit(source, { name: PACKAGE_NAME, mode: command })
  } catch (error) {
    fail(`Could not edit ${displayPath(configPath, home)}: ${error instanceof Error ? error.message : String(error)}`)
    fail('No changes were written. Edit your opencode.jsonc by hand if needed:')
    fail(`  "plugins": ["${PACKAGE_NAME}"]`)
    return 1
  }

  if (!result.changed) {
    if (command === 'remove') {
      write(`${PACKAGE_NAME} was not listed in ${displayPath(configPath, home)}; nothing to remove.`)
    } else {
      write(`${PACKAGE_NAME} is already registered in ${displayPath(configPath, home)}.`)
    }
    return 0
  }

  mkdirSync(dirname(configPath), { recursive: true })
  if (exists && source !== '') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backup = `${configPath}.bak-${stamp}`
    copyFileSync(configPath, backup)
    write(`Backed up the previous config to ${displayPath(backup, home)}.`)
  }
  writeFileSync(configPath, result.text.endsWith('\n') ? result.text : `${result.text}\n`)

  if (command === 'remove') {
    write(`Removed ${PACKAGE_NAME} from ${displayPath(configPath, home)}.`)
    write('Restart OpenCode (or run `opencode service restart`) if it is currently running.')
    return 0
  }

  write(`${exists ? 'Updated' : 'Created'} ${displayPath(configPath, home)}.`)
  write('')
  write('OpenCode installs the plugin package from npm automatically (its GUI')
  write('bundle ships prebuilt, so no local build step is needed). To finish:')
  write('  1. Restart the OpenCode service:  opencode service restart')
  write('  2. Open the session side panel, click + and pick "Account usage"')
  return 0
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  process.exitCode = main(process.argv.slice(2))
}
