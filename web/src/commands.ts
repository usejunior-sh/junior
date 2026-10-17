/**
 * `/` commands in a composer: spotting the one being typed, keeping the
 * folder's list current, and ranking it on every keystroke.
 *
 * The `@` picker's sibling, but a much smaller thing. Nothing is attached and
 * nothing is resolved, picking a command only writes text, because Claude
 * Code's own CLI expands `/name args` when the message reaches it. Neither
 * this file nor the server has to know a command was used.
 *
 * The list comes from the SDK (`supportedCommands()`), keyed by folder, and is
 * small enough, a few dozen entries, that the search is local and instant.
 * No debounce: the list is already here, so narrowing it is a filter, not a
 * fetch.
 */
import { useEffect, useMemo, useState } from 'react'
import { fuzzyRank, fuzzyScore } from '../../shared/fuzzy.js'
import type { CommandsResponse, SlashCommandInfo } from '../../shared/protocol.js'
import { store } from './store.js'

// The command under the caret

export type ActiveCommand = {
  /** always 0: a command is only a command at the very start of a message */
  start: 0
  /** index just past the query (the caret) */
  end: number
  query: string
}

/**
 * The `/word` being typed, if the message is one. The `/` must be the first
 * character, anywhere else it is a path, a date or a fraction, and the
 * picker closes at the first space, which is where the command ends and its
 * arguments begin.
 */
export function activeCommand(text: string, caret: number): ActiveCommand | null {
  if (!text.startsWith('/')) return null
  const word = /^\/(\S*)/.exec(text)
  if (!word) return null
  // The caret has to still be in the name. Past it the user is writing
  // arguments (or prose after a command that was never one), and a menu
  // hovering over that is just in the way.
  if (caret < 1 || caret > word[0].length) return null
  return { start: 0, end: caret, query: text.slice(1, caret) }
}

/**
 * Replace the typed name with the picked one plus a space, so arguments can
 * follow straight away, and a command that takes none still submits cleanly
 * once the draft is trimmed.
 */
export function insertCommand(
  text: string,
  active: ActiveCommand,
  c: SlashCommandInfo,
): { text: string; caret: number } {
  const token = `/${c.name} `
  // Only the name is replaced; anything already typed after it survives.
  const rest = text.slice(/^\/\S*/.exec(text)?.[0].length ?? active.end)
  return { text: token + rest.replace(/^ /, ''), caret: token.length }
}

/** Folders already fetched, so switching tabs doesn't refetch. */
const cache = new Map<string, SlashCommandInfo[]>()
/** Requests in flight, so two composers on one folder ask once. */
const inflight = new Map<string, Promise<void>>()
/** The folder the server resolved each asked-about folder to (`~` expanded). */
const resolved = new Map<string, string>()

function load(cwd: string): Promise<void> {
  const running = inflight.get(cwd)
  if (running) return running
  const job = fetch(`/api/commands?cwd=${encodeURIComponent(cwd)}`)
    .then((r) => r.json() as Promise<CommandsResponse>)
    .then((b) => {
      if (!b.ok) return
      cache.set(cwd, b.commands)
      // The server answers about the resolved folder and keys its pushes by
      // it, so remember which one this composer's `cwd` means.
      resolved.set(cwd, b.cwd)
      cache.set(b.cwd, b.commands)
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(cwd)
    })
  inflight.set(cwd, job)
  return job
}

/**
 * The commands available in `cwd`. Fetched lazily: `enabled` goes true the
 * first time the user types `/`, so a composer that never uses them never
 * spawns the probe the server needs for a folder with no live session.
 *
 * Kept current after that: the server pushes the whole list whenever a
 * session's subprocess discovers skills mid-run.
 */
export function useCommands(cwd: string, enabled: boolean): { commands: SlashCommandInfo[]; loading: boolean } {
  const [, bump] = useState(0)

  useEffect(() => {
    if (!enabled || cache.has(cwd)) return
    void load(cwd).then(() => bump((n) => n + 1))
  }, [cwd, enabled])

  useEffect(
    () =>
      store.onCommandsChanged((changed, commands) => {
        if (changed !== cwd && changed !== resolved.get(cwd)) return
        cache.set(cwd, commands)
        cache.set(changed, commands)
        bump((n) => n + 1)
      }),
    [cwd],
  )

  // A folder with no live session needs a subprocess spawned before it can
  // answer, which is slow enough that the picker must say so rather than
  // flash "nothing matches" at a list it simply hasn't got yet.
  return { commands: cache.get(cwd) ?? [], loading: enabled && !cache.has(cwd) }
}

export type CommandHit = SlashCommandInfo & {
  /** where it came from: a plugin's name, or `user` / `project` for a skill */
  source?: string
  /** the alias that matched, when the query found the command by one of those */
  via?: string
  /** the description trimmed to its first sentence, for the one-line row */
  short: string
}

/** How many rows the picker shows at once; the rest are a keystroke away. */
const LIMIT = 40

/**
 * Split a command into what a one-line row can show.
 *
 * Two things have to be dug out of the strings the SDK hands over. A skill
 * defined by the user or the project has its origin appended to the
 * description as `(user)` / `(project)`, which is real information, but at
 * the end of the one field that gets ellipsised, so it is moved to a badge.
 * And a skill's description is written to route a *model*, not to label a
 * menu row: the useful sentence comes first and a paragraph of "Use when the
 * user asks to…" follows it. The row shows the first sentence; the full text
 * is still the row's tooltip, and still what the search reads.
 */
export const hit = (c: SlashCommandInfo): CommandHit => {
  const tagged = /^(.*?)\s*\((user|project)\)\s*$/s.exec(c.description)
  const body = tagged ? tagged[1] : c.description
  const colon = c.name.indexOf(':')
  // `plugin:skill` names carry their own origin; a bare name may carry a tag.
  const source = colon > 0 ? c.name.slice(0, colon) : tagged?.[2]
  // A sentence end, not just a full stop. A period only ends a sentence when
  // the string ends there or a capital follows it, which is what keeps
  // `v0.8.0`, `.gitignore` and, the one that actually bit, the `(e.g.` in
  // /loop's description from cutting the row off mid-clause.
  const stop = /\.(?:\s+(?=[A-Z])|$)/.exec(body)
  const short = stop ? body.slice(0, stop.index + 1) : body
  return { ...c, short, ...(source ? { source } : {}) }
}

/**
 * Rank a folder's commands against what has been typed. Matching runs over
 * the name *and* the description, so `/` + "ship" finds `/release`, but the
 * two are ranked separately and name matches always sort first, because
 * someone typing a name knows what they want.
 */
export function useCommandSearch(active: ActiveCommand | null, commands: readonly SlashCommandInfo[]): CommandHit[] {
  return useMemo(() => {
    if (!active) return []
    const q = active.query
    if (!q) return commands.slice(0, LIMIT).map(hit)

    const byName = fuzzyRank(q, commands, (c) => c.name, LIMIT)
    const taken = new Set(byName.map((c) => c.name))

    // An alias is a name the user may well know (`/cost` for `/usage`), so it
    // matches like one, and the row says which alias got them there.
    const aliased: CommandHit[] = []
    for (const c of commands) {
      if (taken.has(c.name)) continue
      const via = c.aliases?.find((a) => fuzzyScore(q, a) !== null)
      if (via) {
        aliased.push({ ...hit(c), via })
        taken.add(c.name)
      }
    }

    // Descriptions are prose, so they need the floor that stops a short query
    // from being a subsequence of every sentence in the list.
    const byDesc = fuzzyRank(
      q,
      commands.filter((c) => !taken.has(c.name)),
      (c) => c.description,
      LIMIT,
      2.5,
    )

    return [...byName.map(hit), ...aliased, ...byDesc.map(hit)].slice(0, LIMIT)
  }, [active?.query, commands])
}

/** The exact command a draft names, if it names one, for the composer's hint. */
export function commandFor(text: string, commands: readonly SlashCommandInfo[]): SlashCommandInfo | null {
  const m = /^\/(\S+)/.exec(text)
  if (!m) return null
  return commands.find((c) => c.name === m[1] || c.aliases?.includes(m[1])) ?? null
}
