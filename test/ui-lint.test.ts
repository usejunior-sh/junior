/**
 * The UI ratchet: the mechanical half of the UX developer review
 * (.docs/overnight-2026-10-24/05-plan.md, "The UI gate"). Nobody renders a
 * page in a test, but three things a reviewer would flag can be counted:
 *
 *   colours        raw hex and rgb()/rgba()/hsl()/hsla() outside the colour
 *                  homes. The design system's tokens are the place for colour.
 *   nativeDialogs  a native `<dialog>` that Radix doesn't own, `confirm(` and
 *                  `alert(` (bare or on `window.`). Radix Dialog / AlertDialog
 *                  is the pattern.
 *   bannedPhrases  the phrases the brand file bans, in copy (strings and JSX
 *                  text, never comments).
 *
 * Each file's counts live in test/ui-lint-baseline.json and can only go down.
 * A rise, or a count in a file the baseline doesn't know, fails. A fall passes
 * and prints a hint to lower the baseline. To rewrite it after a cleanup:
 *
 *   UI_LINT_BASELINE=write node --import tsx --test test/ui-lint.test.ts
 *
 * Only run that after a count fell. Raising the baseline to make a new colour
 * pass defeats the point.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(ROOT, 'test', 'ui-lint-baseline.json')

/** Everything under web/src that ships to the user's screen. */
const SCAN_ROOT = 'web/src'
const SCAN_EXT = /\.(tsx?|css)$/

/**
 * Where raw colours are supposed to live, so their colours are not counted
 * (their dialogs and phrases still are). tokens.css holds the design-system
 * tokens; themes.ts holds the theme palettes it swaps in at runtime.
 */
export const COLOUR_HOMES = ['web/src/styles/tokens.css', 'web/src/themes.ts']

/**
 * The phrases the brand file bans. Source of truth: the "Rules for new copy"
 * section of ../CLAUDE.md (one folder above this repo): no "24/7", no "walk
 * away", and never "Junior by Triage". Change them there first.
 */
export const BANNED_PHRASES: { phrase: string; re: RegExp }[] = [
  { phrase: '24/7', re: /\b24\s*\/\s*7\b/gi },
  { phrase: 'walk away', re: /\bwalk[\s-]+away\b/gi },
  { phrase: 'Junior by Triage', re: /\bjunior\s+by\s+triage\b/gi },
]

export type Counts = { colours: number; nativeDialogs: number; bannedPhrases: number }
export type Report = Record<string, Partial<Counts>>
const KINDS: (keyof Counts)[] = ['colours', 'nativeDialogs', 'bannedPhrases']

// ---------------------------------------------------------------------------
// Lexing: just enough to tell code, strings and comments apart.

/**
 * Splits TS/TSX source into code (strings and comments blanked) and the text
 * of every string literal and template chunk. Single- and double-quoted
 * strings end at a newline, so a stray apostrophe in JSX text ("Don't") or a
 * regex literal can only confuse the rest of its own line. JSX text stays in
 * `code`, which is why phrases are searched in both.
 */
export function splitTs(src: string): { code: string; strings: string[] } {
  let code = ''
  const strings: string[] = []
  // Each frame is a template literal being read, or code inside one's `${ }`
  // (with its own brace depth). The bottom frame is the file's code.
  const stack: ({ kind: 'code'; depth: number } | { kind: 'tmpl'; chunk: string })[] = [{ kind: 'code', depth: 0 }]
  let i = 0
  while (i < src.length) {
    const top = stack[stack.length - 1]
    const c = src[i]
    if (top.kind === 'tmpl') {
      if (c === '\\') { top.chunk += src.slice(i, i + 2); i += 2; continue }
      if (c === '`') { strings.push(top.chunk); stack.pop(); code += ' '; i++; continue }
      if (c === '$' && src[i + 1] === '{') { strings.push(top.chunk); top.chunk = ''; stack.push({ kind: 'code', depth: 0 }); code += ' '; i += 2; continue }
      top.chunk += c
      i++
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '//') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      code += src.slice(i, stop).replace(/[^\n]/g, '') // keep line numbers honest
      i = stop
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let text = ''
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue }
        text += src[j]
        j++
      }
      strings.push(text)
      code += ' '
      i = src[j] === c ? j + 1 : j
      continue
    }
    if (c === '`') { stack.push({ kind: 'tmpl', chunk: '' }); i++; continue }
    if (c === '{') top.depth++
    if (c === '}') {
      if (top.depth === 0 && stack.length > 1) { stack.pop(); i++; continue }
      top.depth--
    }
    code += c
    i++
  }
  for (const f of stack) if (f.kind === 'tmpl' && f.chunk) strings.push(f.chunk)
  return { code, strings }
}

const HEX = /(?<![\w&/#])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g
const FUNC_COLOUR = /(?<![\w-])(?:rgba?|hsla?)\(\s*(?!var\()/gi

const count = (re: RegExp, text: string) => text.match(re)?.length ?? 0

/**
 * Hex colours inside one string literal. A run of digits only ("#455") is
 * also how copy names an issue or PR ("a ref like #455, or a link"), so it
 * counts only where a colour sits: the whole string, or before `;` or `)`.
 * So "Fixes #123" passes, and a digits-only colour inside a longer value
 * ("1px solid #000") is missed. Any hex with a letter in it always counts.
 */
function hexInString(s: string): number {
  let n = 0
  for (const m of s.matchAll(HEX)) {
    if (/[a-f]/i.test(m[1])) { n++; continue }
    const after = s.slice((m.index ?? 0) + m[0].length)
    if ((m.index === 0 && after === '') || /^\s*[;)]/.test(after)) n++
  }
  return n
}

/**
 * `<dialog` elements that Radix doesn't own. `<Dialog.Content asChild>` around
 * a `<dialog open>` borrows the element for its styling only; Radix owns focus,
 * Escape and the layer stack, which is the pattern we want.
 */
function nativeDialogTags(code: string): number {
  let n = 0
  for (const m of code.matchAll(/<dialog\b/g)) {
    const before = code.slice(0, m.index)
    const opener = before.search(/<[A-Za-z][\w.]*[^<]*$/)
    const tag = opener === -1 ? '' : before.slice(opener)
    if (/^<(?:Alert)?Dialog\.Content\b/.test(tag) && /\basChild\b/.test(tag)) continue
    n++
  }
  return n
}

const phrases = (text: string) => BANNED_PHRASES.reduce((n, p) => n + count(p.re, text), 0)

/** Strips CSS comments and returns the value side of every declaration. */
function cssValues(src: string): { text: string; values: string[] } {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '')
  // `:` up to `;` or `}`, with no `{` between: a declaration, never a selector
  // (`a:hover {`, `:not(#fade) {`) or an at-rule prelude (`(max-width: 767px) {`).
  const values = [...text.matchAll(/:([^;{}]*)(?=[;}])/g)].map((m) => m[1])
  return { text, values }
}

/** Counts one file's text. `file` is repo-relative with forward slashes. */
export function countFile(file: string, src: string): Counts {
  const colourHome = COLOUR_HOMES.includes(file)
  if (file.endsWith('.css')) {
    const { text, values } = cssValues(src)
    const colours = colourHome ? 0 : values.reduce((n, v) => n + count(HEX, v) + count(FUNC_COLOUR, v), 0)
    return { colours, nativeDialogs: 0, bannedPhrases: phrases(text) }
  }
  const { code, strings } = splitTs(src)
  const colours = colourHome ? 0 : strings.reduce((n, s) => n + hexInString(s) + count(FUNC_COLOUR, s), 0)
  const nativeDialogs = nativeDialogTags(code) + count(/(?<![\w$.])(?:window\s*\.\s*)?(?:confirm|alert)\s*\(/g, code)
  const bannedPhrases = phrases(code) + strings.reduce((n, s) => n + phrases(s), 0)
  return { colours, nativeDialogs, bannedPhrases }
}

/** Every scanned file's non-zero counts, keyed by repo-relative path. */
export function scanTree(root = ROOT): Report {
  const files = (fs.readdirSync(path.join(root, SCAN_ROOT), { recursive: true }) as string[])
    .map((f) => `${SCAN_ROOT}/${f.split(path.sep).join('/')}`)
    .filter((f) => SCAN_EXT.test(f) && !f.endsWith('.d.ts'))
    .sort()
  const report: Report = {}
  for (const f of files) {
    const c = countFile(f, fs.readFileSync(path.join(root, f), 'utf8'))
    const nonZero = Object.fromEntries(KINDS.filter((k) => c[k] > 0).map((k) => [k, c[k]]))
    if (Object.keys(nonZero).length) report[f] = nonZero
  }
  return report
}

/**
 * The ratchet. `failures` are rises (or counts in a file the baseline doesn't
 * list); `hints` are falls, and baseline rows whose file is now clean or gone.
 */
export function compare(baseline: Report, current: Report): { failures: string[]; hints: string[] } {
  const failures: string[] = []
  const hints: string[] = []
  for (const [file, counts] of Object.entries(current)) {
    for (const k of KINDS) {
      const now = counts[k] ?? 0
      const was = baseline[file]?.[k] ?? 0
      if (now > was) failures.push(`${file}: ${k} rose from ${was} to ${now}`)
      else if (now < was) hints.push(`${file}: ${k} fell from ${was} to ${now}`)
    }
  }
  for (const [file, counts] of Object.entries(baseline)) {
    if (current[file]) continue
    for (const k of KINDS) if ((counts[k] ?? 0) > 0) hints.push(`${file}: ${k} fell from ${counts[k]} to 0`)
  }
  return { failures, hints }
}

const LOWER = 'Lower the baseline: UI_LINT_BASELINE=write node --import tsx --test test/ui-lint.test.ts'
const RAISED =
  'Use a token from web/src/styles/tokens.css, a Radix Dialog/AlertDialog, or copy the brand file allows ' +
  '(see the header of test/ui-lint.test.ts).'

function readBaseline(): Report {
  return (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as { files: Report }).files
}

// ---------------------------------------------------------------------------
// The tree against its baseline.

test('the tree holds its baseline: raw colours, native dialogs and banned phrases only go down', (t) => {
  const current = scanTree()
  if (process.env.UI_LINT_BASELINE === 'write') {
    const body = {
      _note: 'Per-file counts from test/ui-lint.test.ts. They may only go down; never raise one to make a test pass.',
      files: current,
    }
    fs.writeFileSync(BASELINE, JSON.stringify(body, null, 2) + '\n')
    t.diagnostic(`wrote ${path.relative(ROOT, BASELINE)}`)
    return
  }
  const { failures, hints } = compare(readBaseline(), current)
  for (const h of hints) t.diagnostic(`${h}. ${LOWER}`)
  assert.deepEqual(failures, [], `UI lint ratchet: ${failures.length} count(s) rose.\n${failures.join('\n')}\n${RAISED}`)
})

test('the scan covers components and styles, and only tokens.css and themes.ts hold raw colours', () => {
  assert.ok(COLOUR_HOMES.includes('web/src/styles/tokens.css'))
  const tokens = fs.readFileSync(path.join(ROOT, 'web/src/styles/tokens.css'), 'utf8')
  assert.ok(count(HEX, tokens) > 0, 'tokens.css defines raw colours')
  assert.equal(countFile('web/src/styles/tokens.css', tokens).colours, 0)
  // The same text anywhere else is counted.
  assert.ok(countFile('web/src/styles/inbox.css', tokens).colours > 0)
  const report = scanTree()
  assert.ok(!('web/src/styles/tokens.css' in report))
  assert.ok(Object.keys(report).some((f) => f.startsWith('web/src/components/') && f.endsWith('.tsx')))
  assert.ok(Object.keys(report).some((f) => f.startsWith('web/src/styles/') && f.endsWith('.css')))
})

// ---------------------------------------------------------------------------
// The failure path, on in-memory fixtures (never a real file).

const FIXTURE = 'web/src/components/Fixture.tsx'

test('a new component with a raw hex colour fails', () => {
  const src = `export function Fixture() {\n  return <div style={{ color: '#ff6a1f' }}>Hi</div>\n}\n`
  const current = { [FIXTURE]: countFile(FIXTURE, src) }
  assert.equal(current[FIXTURE].colours, 1)
  const { failures } = compare(readBaseline(), current)
  assert.deepEqual(failures, [`${FIXTURE}: colours rose from 0 to 1`])
})

test('a new component with a native <dialog> fails; a Radix-owned one does not', () => {
  const native = `export function Fixture() {\n  return <dialog ref={ref} onClose={close}><p>Sure?</p></dialog>\n}\n`
  assert.equal(countFile(FIXTURE, native).nativeDialogs, 1)
  assert.deepEqual(compare({}, { [FIXTURE]: countFile(FIXTURE, native) }).failures, [`${FIXTURE}: nativeDialogs rose from 0 to 1`])

  const radix = `<Dialog.Content asChild onEscapeKeyDown={(e) => e.preventDefault()}>\n  <dialog open className="projModal">x</dialog>\n</Dialog.Content>`
  assert.equal(countFile(FIXTURE, radix).nativeDialogs, 0)
})

test('confirm( and alert( count, bare or on window; lookalikes do not', () => {
  const src = [
    `if (!confirm('Delete it?')) return`,
    `window.confirm('Really?')`,
    `alert(String(err))`,
    `window.alert('x')`,
    `onConfirm(item)`,
    `actions.confirm(id)`,
    `showAlert()`,
  ].join('\n')
  assert.equal(countFile(FIXTURE, src).nativeDialogs, 4)
})

test('a file in the baseline fails when a count rises, and passes with a hint when it falls', () => {
  const base: Report = { [FIXTURE]: { colours: 2, nativeDialogs: 1 } }
  const up = compare(base, { [FIXTURE]: { colours: 3, nativeDialogs: 1 } })
  assert.deepEqual(up.failures, [`${FIXTURE}: colours rose from 2 to 3`])
  const down = compare(base, { [FIXTURE]: { colours: 1 } })
  assert.deepEqual(down.failures, [])
  assert.deepEqual(down.hints, [`${FIXTURE}: colours fell from 2 to 1`, `${FIXTURE}: nativeDialogs fell from 1 to 0`])
  // A file that went clean (or away) drops out of the report: still a hint.
  assert.deepEqual(compare(base, {}).hints.length, 2)
})

test('banned phrases are counted in strings and JSX text, and can only go down', () => {
  const src = [
    `const hint = 'Start it and walk away.'`,
    `const tag = \`Junior works 24/7 for \${name}\``,
    `export const P = () => <p>Junior, by your side, 24 / 7</p>`,
    `const credit = "Junior by Triage"`,
    `// a comment saying 24/7 or walk away is not copy`,
    `/* nor is this: walk-away */`,
  ].join('\n')
  assert.equal(countFile(FIXTURE, src).bannedPhrases, 4)
  const base: Report = { [FIXTURE]: { bannedPhrases: 1 } }
  assert.deepEqual(compare(base, { [FIXTURE]: { bannedPhrases: 2 } }).failures, [`${FIXTURE}: bannedPhrases rose from 1 to 2`])
  assert.deepEqual(compare(base, {}).failures, [])
  assert.deepEqual(BANNED_PHRASES.map((p) => p.phrase), ['24/7', 'walk away', 'Junior by Triage'])
})

// ---------------------------------------------------------------------------
// What isn't a raw colour.

test('colours: comments, refs, token-based rgb() and CSS id selectors are not counted', () => {
  const tsx = [
    `/** "acme/web#3312", or the item's home */`,
    `const placeholder = 'Also today… a ref like #455, or a link'`,
    `const a = 'PR #1234 is ready'`,
    `const b = 'rgba(var(--ink-rgb), 0.5)'`,
    `const c = '#000'`, // a colour, digits or not
    `const f = 'Fixes #123'`,
    `const d = \`1px solid #e8e5df\``,
    `const e = 'rgba(20, 18, 16, 0.84)'`,
  ].join('\n')
  assert.equal(countFile(FIXTURE, tsx).colours, 3)

  const css = [
    `/* was #fff before the tokens */`,
    `#fade, #palette { color: var(--ink); }`,
    `@media (max-width: 767px) { .row:hover { background: #fff; } }`,
    `.a { box-shadow: 0 0 0 1px rgba(248, 247, 244, 0.07), inset 0 0 #000 }`,
  ].join('\n')
  assert.equal(countFile('web/src/styles/fixture.css', css).colours, 3)
})

test('the lexer keeps template expressions as code and strings as strings', () => {
  const { code, strings } = splitTs("const x = `a ${f('b')} c`; // tail\nalert('d')")
  assert.deepEqual(strings, ['a ', 'b', ' c', 'd'])
  assert.match(code, /f\(/)
  assert.match(code, /alert\(/)
  assert.doesNotMatch(code, /tail/)
})
