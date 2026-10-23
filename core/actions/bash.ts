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

export type BashPattern = {
  /** as written: what a record cites as why it counted */
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

/**
 * A double-quoted string from just after its `"`: its text and the index
 * after the closing quote. The scripts of its `$( )` and backticks go into
 * `subs` when given. They run, quotes or not.
 */
function readDouble(s: string, i: number, subs?: string[]): [string, number] {
  let out = ''
  while (i < s.length && s[i] !== '"') {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      out += '"\\$`\n'.includes(n) ? (n === '\n' ? '' : n) : c + n
      i += 2
    } else if (c === '$' && s[i + 1] === '(') {
      const j = skipSubst(s, i + 2)
      if (s[i + 2] !== '(') subs?.push(s.slice(i + 2, j - 1))
      out += s.slice(i, j)
      i = j
    } else if (c === '`') {
      const end = s.indexOf('`', i + 1)
      const j = end === -1 ? s.length : end + 1
      subs?.push(s.slice(i + 1, end === -1 ? s.length : end))
      out += s.slice(i, j)
      i = j
    } else {
      out += c
      i++
    }
  }
  return [out, i + 1]
}

/** From just after `$(`, the index after its matching `)`, quotes and heredocs inside are skipped whole. */
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
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** A word as one shell word again, for a script rebuilt from words: single-quoted. */
const quote = (w: string): string => `'${w.replace(/'/g, `'\\''`)}'`

/**
 * Split a shell command into its simple commands, each as a list of words.
 * Not a shell: enough of one to find where commands start, quotes, escapes,
 * `$( )`, backticks, heredocs, comments and redirections (`2>&1` is not a
 * background `&`) are respected. `bash -c "…"` and `eval "…"` are opened up
 * and split too, also behind a wrapper (`env bash -c`, `xargs sh -c`), and
 * so is every command substitution (`$( )`, backticks, also inside double
 * quotes) and process substitution (`<( )`, `>( )`): what they run comes
 * after the command they sit in.
 */
export function splitCommand(src: string): CommandPart[] {
  const { parts, subs } = scan(src)
  const opened = parts.flatMap((p) => {
    const script = scriptOf(p)
    return script === null ? [p] : [p, ...splitCommand(script)]
  })
  return [...opened, ...subs.flatMap((body) => splitCommand(body))]
}

/**
 * The script a command runs, when it runs one: `bash -c "git push && …"`,
 * `eval "git push origin main"` (its words joined, as eval does),
 * `npx -c "…"`, `env -S "git push" main` (the string split, then the rest),
 * `find . -exec git push origin {} \;` (each `-exec` command). Its parts
 * always follow it in splitCommand, so a caller judging parts may judge the
 * script's parts and skip this one.
 */
export function scriptOf(part: CommandPart): string | null {
  const { at, calls, split } = peel(part)
  // `env -S "git push origin" main`: env splits the string, then appends its other words.
  if (split !== null) return [split, ...part.slice(at).map(quote)].join(' ')
  // `npx -c "…"` runs its string as a script, like `bash -c`.
  if (calls.length) return calls.join('\n')
  const w = unwrap(part)
  if (w[0] === 'eval') {
    // eval takes no options, but skips a `--`: `eval -- "git push"` runs `git push`.
    const args = w[1] === '--' ? w.slice(2) : w.slice(1)
    return args.length ? args.join(' ') : null
  }
  if (w[0] === 'find') {
    // `-exec cmd … ;` / `+`, and `-execdir`, `-ok`, `-okdir`: each runs its command per file.
    const runs: string[] = []
    for (let k = 1; k < w.length; k++) {
      if (!FIND_EXEC.has(w[k])) continue
      let end = k + 1
      while (end < w.length && w[end] !== ';' && w[end] !== '+') end++
      if (end > k + 1) runs.push(w.slice(k + 1, end).map(quote).join(' '))
      k = end
    }
    return runs.length ? runs.join('\n') : null
  }
  if (!SHELLS.has(w[0])) return null
  const c = w.findIndex((x, k) => k > 0 && /^-[a-z]*c$/.test(x))
  return c > 0 && w[c + 1] !== undefined ? w[c + 1] : null
}

/** The scripts of the command's substitutions, outermost only (`$( )`, backticks, `<( )`, `>( )`). */
export function substitutions(src: string): string[] {
  return scan(src).subs
}

function scan(src: string): { parts: CommandPart[]; subs: string[] } {
  const parts: CommandPart[] = []
  const subs: string[] = []
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
      const [text, j] = readDouble(s, i + 1, subs)
      word += text
      inWord = true
      i = j
    } else if ((c === '$' || ((c === '<' || c === '>') && !inWord)) && s[i + 1] === '(') {
      // `$( )`, or a process substitution `<( )` / `>( )`. A word, whose script runs too.
      const j = skipSubst(s, i + 2)
      // `$(( ))` is arithmetic, not a script.
      if (s[i + 2] !== '(') subs.push(s.slice(i + 2, j - 1))
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
      subs.push(s.slice(i + 1, end === -1 ? s.length : end))
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
    } else if (c === ')' || (c === '(' && !inWord) || (c === '{' && !inWord && /^\s?$/.test(s[i + 1] ?? '')) || (c === '}' && !inWord && /^[\s;&|)]?$/.test(s[i + 1] ?? ''))) {
      // An unquoted `)` always closes something: `(cd x; git push)` ends at it.
      // `{` and `}` group only as words of their own: `{main,feat}` and `{}` are words.
      endPart()
      i++
    } else {
      word += c
      inWord = true
      i++
    }
  }
  endPart()
  return { parts, subs }
}

const basename = (w: string): string => w.slice(w.lastIndexOf('/') + 1)

/**
 * Words that run the next command rather than being it: `sudo git push`,
 * `npx vercel deploy`, `xargs git push origin`. Each with the flags of its own
 * that take the next word as their value (`sudo -u bob`, `xargs -I {}`).
 */
const WRAPPERS = new Map<string, Set<string>>([
  ['sudo', new Set(['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t', '-D', '-R'])],
  ['command', new Set()],
  ['builtin', new Set()],
  // env's `-S "…"` is a script, not a value: see peel.
  ['env', new Set(['-u', '-C', '--unset', '--chdir'])],
  // timeout also takes a duration before the command: see POSITIONAL.
  ['timeout', new Set(['-k', '-s', '--kill-after', '--signal'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['ionice', new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['time', new Set(['-o', '-f'])],
  ['nohup', new Set()],
  ['exec', new Set(['-a'])],
  ['npx', new Set(['-p', '--package', '-c', '--call'])],
  ['bunx', new Set(['-p', '--package'])],
  // xargs adds words from its input to the command: see pushRefs.
  // GNU's `-e[eof]`, `-i[str]` and `-l[n]` take their value attached, if at all.
  ['xargs', new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-J', '-R', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--max-chars'])],
])
/** Wrappers that take plain words before the command: `timeout 60 git push`. */
const POSITIONAL = new Map<string, number>([['timeout', 1]])
/** Global flags that take the next word as their value (`git -C dir push`, `gh -R o/r …`). */
const VALUE_FLAGS = new Set(['-C', '-c', '-R', '--repo', '--git-dir', '--work-tree', '--namespace'])

/** Reserved words that lead into the command after them: `then rm x`, `do git push`, `! grep`. */
const LEAD_WORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'esac', '!', '{', '}'])
/** Reserved words whose part is a word list, not a command: `for f in a b`, `case $x in`. */
const LIST_WORDS = new Set(['for', 'select', 'case'])

/**
 * The command as run: env assignments, wrappers and leading reserved words
 * dropped, the program by its basename. A `for`/`case` header runs nothing: [].
 */
export function unwrap(part: CommandPart): CommandPart {
  const { at } = peel(part)
  if (at < 0) return []
  const rest = part.slice(at)
  return rest.length ? [basename(rest[0]), ...rest.slice(1)] : rest
}

/** The wrappers a command runs under, by basename: `sudo xargs git push` → ['sudo', 'xargs']. */
export const wrappersOf = (part: CommandPart): string[] => peel(part).wrappers

type Peeled = {
  /** where the command proper starts; -1 for a `for`/`case` header */
  at: number
  /** the wrappers it runs under, by basename */
  wrappers: string[]
  /** the scripts of `npx -c "…"` */
  calls: string[]
  /** env's `-S "…"` / `--split-string=…`: the command, split by env; the words after it are its arguments */
  split: string | null
  /** xargs's replace strings (`-I {}`, `-i`, `-J %`): where its input words land */
  placeholders: string[]
}

/** Where the command proper starts, and what wraps it. */
function peel(part: CommandPart): Peeled {
  const out: Peeled = { at: 0, wrappers: [], calls: [], split: null, placeholders: [] }
  let i = 0
  while (i < part.length) {
    const w = part[i]
    if (LIST_WORDS.has(w)) return { ...out, at: -1 }
    const name = basename(w)
    const flags = WRAPPERS.get(name)
    if (LEAD_WORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
    else if (flags) {
      out.wrappers.push(name)
      i++
      while (i < part.length && part[i].startsWith('-')) {
        const f = part[i]
        const next = part[i + 1]
        if (name === 'npx') {
          if ((f === '-c' || f === '--call') && next !== undefined) out.calls.push(next)
          else if (f.startsWith('--call=')) out.calls.push(f.slice('--call='.length))
        } else if (name === 'env') {
          if ((f === '-S' || f === '--split-string') && next !== undefined) {
            out.split = next
            i += 2
            continue
          }
          if (f.startsWith('--split-string=')) out.split = f.slice('--split-string='.length)
          else if (/^-S./.test(f)) out.split = f.slice(2)
        } else if (name === 'xargs') {
          if ((f === '-I' || f === '-J') && next !== undefined) out.placeholders.push(next)
          else if (/^-[IJi]./.test(f)) out.placeholders.push(f.slice(2))
          else if (f === '-i' || f === '--replace') out.placeholders.push('{}')
          else if (f.startsWith('--replace=')) out.placeholders.push(f.slice('--replace='.length) || '{}')
        }
        i += flags.has(f) ? 2 : 1
      }
      // The command env splits from its string is the command proper; what follows are its arguments.
      if (out.split !== null) break
      i += Math.min(POSITIONAL.get(name) ?? 0, part.length - i)
    } else break
  }
  out.at = i
  return out
}

/** git and gh: where the verb sits, past the global flags and their values; -1 when there is none. */
function verbAt(w: CommandPart): number {
  for (let i = 1; i < w.length; i++) {
    if (!w[i].startsWith('-')) return i
    if (VALUE_FLAGS.has(w[i])) i++
  }
  return -1
}

/** git verbs that stay on this machine whatever words xargs adds to them. */
const XARGS_LOCAL_GIT = new Set(['add', 'rm', 'mv', 'restore', 'checkout', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'status', 'rev-parse', 'cat-file', 'reset', 'check-ignore'])

/**
 * Does only the shell, or xargs's input, decide what this command runs?
 * Then it can't be judged from its text, and is held like a send:
 *
 *   $G push origin main          the program is a variable or a substitution
 *   git $VERB origin main        so is git's or gh's verb
 *   … | xargs git                xargs supplies the verb (any gh, and git
 *   … | xargs env                but for a few local verbs), the program
 *   … | xargs -I{} sh -c {}      behind a wrapper, or the script itself
 *
 * `eval "$CMD"` and `bash -c "$CMD"` land here through their script's part.
 */
export function unknownCommand(part: CommandPart): boolean {
  const { at, wrappers, calls, split, placeholders } = peel(part)
  if (at < 0) return false
  // `xargs env -S "git push origin"`: xargs appends to the split command.
  if (split !== null) return wrappers.includes('xargs')
  const w = unwrap(part)
  const prog = w[0]
  // `$G`, `"$GIT"`, `$(which git)`, `${X:-git}`: the basename still shows it.
  if (prog !== undefined && /[$`)}]/.test(prog)) return true
  if (prog === 'git' || prog === 'gh') {
    const v = verbAt(w)
    if (v !== -1 && EXPANSION.test(w[v])) return true
  }
  if (!wrappers.includes('xargs')) return false
  // `xargs env`, `xargs sudo`: the command is the input. A bare `xargs` runs echo.
  if (prog === undefined) return calls.length === 0 && wrappers[wrappers.length - 1] !== 'xargs'
  const lands = (t: string) => placeholders.some((p) => p !== '' && t.includes(p))
  if (lands(prog)) return true
  const script = scriptOf(part)
  if (script !== null) return !script.trim() || lands(script)
  // `xargs sh` runs files named by its input.
  if (SHELLS.has(prog)) return true
  if (prog === 'gh') return true
  if (prog === 'git') {
    const v = verbAt(w)
    return v === -1 || !XARGS_LOCAL_GIT.has(w[v])
  }
  return false
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
    // Between leading words: flags, and words only the shell knows (`git $OPTS push`).
    if (k > 0) while (i < w.length && (w[i].startsWith('-') || /[$`]/.test(w[i]))) i += VALUE_FLAGS.has(w[i]) ? 2 : 1
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
 * What one refspec of a `git push` sends to: a branch by name, the
 * checked-out branch (`HEAD`, `@`, no refspec at all, or exactly
 * `"$(git branch --show-current)"`), or 'unknown' when only the shell knows:
 * a variable, a substitution, a glob, a brace, or words fed in by xargs.
 * An unknown target is never free.
 */
export type PushRef = { branch: string } | 'current' | 'unknown'

const EXPANSION = /[$`]/
const GLOB = /[*?[\]{}]/
const CURRENT_CMD = String.raw`\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+(?:HEAD|@))\s*`
/** The current-branch substitution, word for word: `$(git branch --show-current)` or in backticks. */
const CURRENT_SUBST = new RegExp(String.raw`^(?:\$\(${CURRENT_CMD}\)|\`${CURRENT_CMD}\`)$`)
/** A redirection word: its operator, and its target when attached (`>log`, `2>&1`). */
const REDIRECT = /^(?:[0-9]*(?:>>|>\||>&|<&|<<<|>|<)|&>>?)/
/** `git push` flags whose value is the next word. */
/** Config keys that decide where a push lands: a remote's push refspecs, push.default, a branch's upstream. */
const PUSH_CONFIG = /^(?:remote\..+\.push|push\.default|branch\..+\.merge)=/i
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

function refOf(spec: string): PushRef {
  const ref = spec.replace(/^\+/, '')
  if (ref === 'HEAD' || ref === '@' || CURRENT_SUBST.test(ref)) return 'current'
  const colon = ref.lastIndexOf(':')
  const src = colon === -1 ? '' : ref.slice(0, colon)
  let dst = colon === -1 ? ref : ref.slice(colon + 1)
  if (EXPANSION.test(src) && !CURRENT_SUBST.test(src)) return 'unknown'
  if (CURRENT_SUBST.test(dst)) return 'current'
  if (EXPANSION.test(dst) || GLOB.test(ref)) return 'unknown'
  // git reads `heads/main` as refs/heads/main; any other ref (`refs/tags/v1`,
  // `tags/v1`) is not a branch at all.
  if (dst.startsWith('refs/heads/')) dst = dst.slice('refs/heads/'.length)
  else if (/^(refs|tags|remotes)\//.test(dst)) return 'unknown'
  else if (dst.startsWith('heads/')) dst = dst.slice('heads/'.length)
  if (!dst || dst === 'HEAD' || dst === '@') return 'unknown'
  return { branch: dst }
}

/**
 * Every place a `git push` sends to, one per refspec; ['current'] when it
 * names none. [] when the command isn't a push.
 */
export function pushRefs(part: CommandPart): PushRef[] {
  const w = unwrap(part)
  const at = w.indexOf('push')
  if (at === -1) return []
  // xargs appends words from its input: a branch, a refspec, a flag.
  if (wrappersOf(part).includes('xargs')) return ['unknown']
  // `git $OPTS push`: the flags before the verb could be anything.
  if (w.slice(1, at).some((t) => EXPANSION.test(t))) return ['unknown']
  // `git -c remote.origin.push=HEAD:main push origin`: config can remap any refspec.
  const pre = w.slice(1, at)
  if (pre.some((t, k) => (pre[k - 1] === '-c' && PUSH_CONFIG.test(t)) || (t.startsWith('--config-env=') && PUSH_CONFIG.test(t.slice('--config-env='.length))))) return ['unknown']
  const args: string[] = []
  let opts = true
  for (let i = at + 1; i < w.length; i++) {
    const t = w[i]
    if (t.startsWith('<(') || t.startsWith('>(')) return ['unknown']
    const redirect = REDIRECT.exec(t)
    if (redirect) {
      // `> log` takes the next word as its target; `>log` and `2>&1` carry it.
      if (redirect[0] === t) i++
      continue
    }
    if (opts && t === '--') {
      opts = false
      continue
    }
    if (opts && t.startsWith('-')) {
      // `-$F` could be `-f`; `--push-option=$X` could be anything.
      if (EXPANSION.test(t)) return ['unknown']
      if (PUSH_VALUE_FLAGS.has(t)) i++
      continue
    }
    args.push(t)
  }
  // The remote: unquoted, `$R` could split into a remote and a refspec.
  if (args[0] !== undefined && EXPANSION.test(args[0])) return ['unknown']
  const specs = args.slice(1)
  return specs.length ? specs.map(refOf) : ['current']
}

/**
 * The branch a `git push` names, if it names exactly one: `git push origin
 * feat`, `git push -u origin HEAD:feat` → "feat". Null when it pushes the
 * current branch, more than one, or one only the shell knows. The result
 * says which, later (pushedBranch).
 */
export function pushTarget(part: CommandPart): string | null {
  const refs = pushRefs(part)
  return refs.length === 1 && typeof refs[0] === 'object' ? refs[0].branch : null
}
