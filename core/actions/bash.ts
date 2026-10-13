/**
 * Bash commands that leave this machine. A command is split into its simple
 * commands (on `&&`, `||`, `;`, `|`, `&` and newlines, quote-aware) and each
 * is matched against a short pattern list from the workspace's actions file.
 * No match = not an action: Bash is mostly local, and the list is the claim.
 *
 * Pattern grammar, one line each:
 *   gh pr comment|review               leading words, `|` = alternatives
 *   gh api -X|--method POST|PUT        then flags that must appear anywhere
 *   vercel --prod                      a flag with no value = present
 *   git push !--dry-run|-n             `!` = that flag must NOT appear
 *
 * Pure and browser-safe.
 */

/** One simple command: its words, quotes removed. */
export type CommandPart = string[]

/** A pattern from the actions file, parsed. */
export type BashPattern = {
  /** as written — what a record cites as why it counted */
  text: string
  /** leading words, each a set of alternatives */
  words: string[][]
  /** flags that must appear after them (`not`: must not); `values: null` = the flag alone */
  flags: Array<{ names: string[]; values: string[] | null; not?: boolean }>
}

type Heredoc = { delim: string; strip: boolean }

/** Skip the bodies of pending heredocs, starting at the line after their `<<`. */
function skipHeredocs(s: string, i: number, docs: Heredoc[]): number {
  for (const d of docs) {
    while (i < s.length) {
      const nl = s.indexOf('\n', i)
      const end = nl === -1 ? s.length : nl
      const line = s.slice(i, end)
      i = end + 1
      if ((d.strip ? line.replace(/^\t+/, '') : line) === d.delim) break
    }
  }
  return Math.min(i, s.length)
}

/** Read a heredoc's delimiter after `<<`; returns it and where the scan resumes. */
function readHeredoc(s: string, i: number): [Heredoc, number] {
  let strip = false
  if (s[i] === '-') {
    strip = true
    i++
  }
  while (s[i] === ' ' || s[i] === '\t') i++
  let delim = ''
  while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
    const c = s[i]
    if (c === "'" || c === '"') {
      const end = s.indexOf(c, i + 1)
      delim += s.slice(i + 1, end === -1 ? s.length : end)
      i = end === -1 ? s.length : end + 1
    } else if (c === '\\') {
      delim += s[i + 1] ?? ''
      i += 2
    } else {
      delim += c
      i++
    }
  }
  return [{ delim, strip }, i]
}

/** A double-quoted string from just after its `"`: its text and the index after the closing quote. */
function readDouble(s: string, i: number): [string, number] {
  let out = ''
  while (i < s.length && s[i] !== '"') {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      out += '"\\$`\n'.includes(n) ? (n === '\n' ? '' : n) : c + n
      i += 2
    } else if (c === '$' && s[i + 1] === '(') {
      const j = skipSubst(s, i + 2)
      out += s.slice(i, j)
      i = j
    } else if (c === '`') {
      const end = s.indexOf('`', i + 1)
      const j = end === -1 ? s.length : end + 1
      out += s.slice(i, j)
      i = j
    } else {
      out += c
      i++
    }
  }
  return [out, i + 1]
}

/** From just after `$(`, the index after its matching `)` — quotes and heredocs inside are skipped whole. */
function skipSubst(s: string, i: number): number {
  let depth = 1
  const docs: Heredoc[] = []
  while (i < s.length) {
    const c = s[i]
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      i = end === -1 ? s.length : end + 1
    } else if (c === '"') {
      i = readDouble(s, i + 1)[1]
    } else if (c === '\\') {
      i += 2
    } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const [doc, j] = readHeredoc(s, i + 2)
      if (doc.delim) docs.push(doc)
      i = j
    } else if (c === '\n') {
      i = docs.length ? skipHeredocs(s, i + 1, docs.splice(0)) : i + 1
    } else if (c === '(') {
      depth++
      i++
    } else if (c === ')') {
      depth--
      i++
      if (depth === 0) return i
    } else i++
  }
  return s.length
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])

/**
 * Split a shell command into its simple commands, each as a list of words.
 * Not a shell: enough of one to find where commands start — quotes, escapes,
 * `$( )`, backticks, heredocs, comments and redirections (`2>&1` is not a
 * background `&`) are respected. `bash -c "…"` is opened up and split too.
 */
export function splitCommand(src: string): CommandPart[] {
  const parts: CommandPart[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const docs: Heredoc[] = []
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endPart = () => {
    endWord()
    if (words.length) parts.push(words)
    words = []
  }
  const s = src
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\n') {
      endPart()
      i = docs.length ? skipHeredocs(s, i + 1, docs.splice(0)) : i + 1
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
    } else if (c === '#' && !inWord) {
      while (i < s.length && s[i] !== '\n') i++
    } else if (c === '\\') {
      if (s[i + 1] !== '\n') {
        word += s[i + 1] ?? ''
        inWord = true
      }
      i += 2
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1)
      const j = end === -1 ? s.length : end
      word += s.slice(i + 1, j)
      inWord = true
      i = j + 1
    } else if (c === '"') {
      const [text, j] = readDouble(s, i + 1)
      word += text
      inWord = true
      i = j
    } else if (c === '$' && s[i + 1] === '(') {
      const j = skipSubst(s, i + 2)
      word += s.slice(i, j)
      inWord = true
      i = j
    } else if (c === '$' && s[i + 1] === '{') {
      const end = s.indexOf('}', i + 2)
      const j = end === -1 ? s.length : end + 1
      word += s.slice(i, j)
      inWord = true
      i = j
    } else if (c === '`') {
      const end = s.indexOf('`', i + 1)
      const j = end === -1 ? s.length : end + 1
      word += s.slice(i, j)
      inWord = true
      i = j
    } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      endWord()
      const [doc, j] = readHeredoc(s, i + 2)
      if (doc.delim) docs.push(doc)
      i = j
    } else if (c === '>' || c === '<') {
      // A redirection stays inside the command: `2>&1`, `>>`, `<&3`, `>|`.
      word += c
      inWord = true
      i++
      if (s[i] === '>' || s[i] === '|') word += s[i++]
      if (s[i] === '&') {
        word += s[i++]
        while (i < s.length && /[0-9-]/.test(s[i])) word += s[i++]
      }
    } else if (c === '&') {
      if (s[i + 1] === '>') {
        word += '&>'
        inWord = true
        i += 2
      } else {
        endPart()
        i += s[i + 1] === '&' ? 2 : 1
      }
    } else if (c === '|') {
      endPart()
      i += s[i + 1] === '|' || s[i + 1] === '&' ? 2 : 1
    } else if (c === ';') {
      endPart()
      i += s[i + 1] === ';' ? 2 : 1
    } else if (c === ')' || ((c === '(' || c === '{' || c === '}') && !inWord)) {
      // An unquoted `)` always closes something — `(cd x; git push)` ends at it.
      endPart()
      i++
    } else {
      word += c
      inWord = true
      i++
    }
  }
  endPart()
  // `bash -c "git push && …"` runs a whole script: split it too.
  return parts.flatMap((p) => {
    const cmd = basename(p[0])
    if (!SHELLS.has(cmd)) return [p]
    const at = p.findIndex((w, k) => k > 0 && /^-[a-z]*c$/.test(w))
    return at > 0 && p[at + 1] !== undefined ? [p, ...splitCommand(p[at + 1])] : [p]
  })
}

const basename = (w: string): string => w.slice(w.lastIndexOf('/') + 1)

/** Words that run the next command rather than being it: `sudo git push`, `npx vercel deploy`. */
const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'npx', 'bunx'])
/** Global flags that take the next word as their value (`git -C dir push`, `gh -R o/r …`). */
const VALUE_FLAGS = new Set(['-C', '-c', '-R', '--repo', '--git-dir', '--work-tree', '--namespace'])

/** The command as run: env assignments and wrappers dropped, the program by its basename. */
export function unwrap(part: CommandPart): CommandPart {
  let i = 0
  while (i < part.length) {
    const w = part[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
    else if (WRAPPERS.has(basename(w))) {
      i++
      while (i < part.length && part[i].startsWith('-')) i++
    } else break
  }
  const rest = part.slice(i)
  return rest.length ? [basename(rest[0]), ...rest.slice(1)] : rest
}

/** Parse one pattern line; a string is the reason it's no good. */
export function parsePattern(text: string): BashPattern | string {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return 'empty pattern'
  const words: string[][] = []
  const flags: BashPattern['flags'] = []
  for (let i = 0; i < tokens.length; i++) {
    const not = tokens[i].startsWith('!')
    const alts = (not ? tokens[i].slice(1) : tokens[i]).split('|')
    if (alts.some((a) => !a)) return `"${tokens[i]}": empty alternative`
    if (not && !alts[0].startsWith('-')) return `"${tokens[i]}": only a flag can be negated`
    if (alts[0].startsWith('-')) {
      if (alts.some((a) => !a.startsWith('-'))) return `"${tokens[i]}": mix of flags and words`
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('-') && !next.startsWith('!')) {
        const values = next.split('|')
        if (values.some((v) => !v)) return `"${next}": empty alternative`
        flags.push({ names: alts, values: values.map((v) => v.toUpperCase()), ...(not ? { not } : {}) })
        i++
      } else flags.push({ names: alts, values: null, ...(not ? { not } : {}) })
    } else {
      if (flags.length) return `"${tokens[i]}": words go before flags`
      if (alts.some((a) => a.startsWith('-'))) return `"${tokens[i]}": mix of flags and words`
      words.push(alts)
    }
  }
  if (!words.length) return 'a pattern starts with the command'
  return { text: tokens.join(' '), words, flags }
}

/** Does `rest` carry this flag (with one of its values)? `-X POST`, `-XPOST`, `--method=post`. */
function hasFlag(rest: string[], f: BashPattern['flags'][number]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    for (const name of f.names) {
      let value: string | undefined
      if (t === name) {
        if (!f.values) return true
        value = rest[i + 1]
      } else if (name.startsWith('--') && t.startsWith(`${name}=`)) value = t.slice(name.length + 1)
      else if (!name.startsWith('--') && name.length === 2 && t.startsWith(name) && t.length > 2 && !t.startsWith('--')) value = t.slice(2)
      else continue
      if (!f.values) return true
      if (value !== undefined && f.values.includes(value.toUpperCase())) return true
    }
  }
  return false
}

/**
 * Match one command against a pattern. On a match, the index just past its
 * leading words (where the command's own arguments start); else -1.
 */
export function matchPart(part: CommandPart, p: BashPattern): number {
  const w = unwrap(part)
  let i = 0
  for (const [k, alts] of p.words.entries()) {
    if (k > 0) while (i < w.length && w[i].startsWith('-')) i += VALUE_FLAGS.has(w[i]) ? 2 : 1
    if (i >= w.length || !alts.includes(w[i])) return -1
    i++
  }
  for (const f of p.flags) if (hasFlag(w.slice(i), f) === !!f.not) return -1
  return i
}

/** Short flags whose next word is their value (`-t title`, `-R o/r`), across gh and git. */
const SHORT_VALUE_FLAGS = new Set(['-t', '-b', '-m', '-f', '-F', '-R', '-X', '-H', '-B', '-l', '-a', '-r', '-o', '-C', '-c'])

/**
 * The words of a command after its matched leading words, flags skipped with
 * their values: a long flag (`--body x`) and the short ones above take the
 * next word; `-u` and friends stand alone.
 */
function argsAfter(w: string[], from: number): string[] {
  const out: string[] = []
  for (let i = from; i < w.length; i++) {
    const t = w[i]
    if (t.startsWith('-')) {
      const takesValue = (t.startsWith('--') && !t.includes('=')) || SHORT_VALUE_FLAGS.has(t)
      if (takesValue && w[i + 1] !== undefined && !w[i + 1].startsWith('-')) i++
      continue
    }
    out.push(t)
  }
  return out
}

/** The value of `--title`/`-t`, when the command sets one. */
function titleOf(w: string[]): string | null {
  for (let i = 0; i < w.length; i++) {
    const t = w[i]
    if ((t === '--title' || t === '-t') && w[i + 1] !== undefined) return w[i + 1]
    if (t.startsWith('--title=')) return t.slice('--title='.length)
  }
  return null
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/**
 * One line for a matched command: its leading words, the first couple of
 * arguments (a PR number, a remote and branch), and the title when it sets
 * one. Bodies and heredocs never make it in.
 */
export function describePart(part: CommandPart, p: BashPattern): string {
  const w = unwrap(part)
  const at = matchPart(part, p)
  const lead = w.slice(0, Math.max(at, 1))
  const title = titleOf(w)
  if (title) return clip(`${lead.join(' ')}: ${title}`, 140)
  const args = argsAfter(w, Math.max(at, 1))
    .filter((a) => !a.startsWith('$(') && !a.includes('\n') && !/^[0-9]*[<>]|^&>/.test(a))
    .slice(0, 2)
    .map((a) => clip(a, 40))
  return clip([...lead, ...args].join(' '), 140)
}

/**
 * The branch a `git push` names, if it names one: `git push origin feat`,
 * `git push -u origin HEAD:feat` → "feat". Null when it pushes the current
 * branch implicitly — the result says which, later (pushedBranch).
 */
export function pushTarget(part: CommandPart): string | null {
  const w = unwrap(part)
  const at = w.indexOf('push')
  if (at === -1) return null
  const args: string[] = []
  for (let i = at + 1; i < w.length; i++) {
    const t = w[i]
    if (t.startsWith('-')) {
      if (t === '-o' || t === '--push-option' || t === '--repo' || t === '--receive-pack' || t === '--exec') i++
      continue
    }
    if (/^[0-9]*>/.test(t) || t.startsWith('&>')) break
    args.push(t)
  }
  const ref = args[1]
  if (!ref || ref === 'HEAD') return null
  const dst = ref.replace(/^\+/, '').split(':').pop() ?? ''
  return dst.replace(/^refs\/heads\//, '') || null
}
