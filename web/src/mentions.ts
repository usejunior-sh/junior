/**
 * `@` mentions in a composer: spotting the token under the caret, searching
 * the things it could mean (files under the session folder, work items, other
 * sessions), and holding the picked ones until the message is sent. The kinds
 * are a registry — a new kind is one entry in `SOURCES`, a resolver on the
 * server, and nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyRank } from '../../shared/fuzzy.js'
import {
  MAX_MENTIONS_PER_MESSAGE,
  mentionToken,
  type FileSearchResponse,
  type Mention,
  type MentionKind,
  type ScoredItem,
  type SessionSummary,
} from '../../shared/protocol.js'
import { useInbox } from './inboxStore.js'
import { artifactStore, useArtifacts } from './artifactStore.js'
import { useSessions } from './hooks.js'
import type { ArtifactWithLinks } from '../../shared/protocol.js'

// ---------------------------------------------------------------------------
// The token under the caret
// ---------------------------------------------------------------------------

export type ActiveMention = {
  /** index of the `@` */
  start: number
  /** index just past the query (the caret) */
  end: number
  query: string
  /** `file:` / `item:` / `session:` / `artifact:` narrows the picker to one kind; a bare query searches all */
  kind: MentionKind | null
}

/**
 * The `@word` the caret sits in, if any. The `@` must start the text or follow
 * whitespace (so an email address is not a mention), and the query runs to the
 * caret without whitespace.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i])) {
    if (text[i] === '@') {
      if (i > 0 && !/\s/.test(text[i - 1])) return null
      const raw = text.slice(i + 1, caret)
      // A closed token (`@item:x ` already committed) never reopens — the
      // trailing space ends it, which the loop above already guarantees.
      const m = /^(file|item|session|artifact):(.*)$/.exec(raw)
      if (m) return { start: i, end: caret, query: m[2], kind: m[1] as MentionKind }
      return { start: i, end: caret, query: raw, kind: null }
    }
    i--
  }
  return null
}

/** Replace the active token with the picked mention's token plus a space. */
export function insertMention(text: string, active: ActiveMention, m: Mention): { text: string; caret: number } {
  const token = mentionToken(m) + ' '
  const next = text.slice(0, active.start) + token + text.slice(active.end)
  return { text: next, caret: active.start + token.length }
}

/**
 * Retarget the active token at one kind (or all of them, with `null`). The
 * picker's tabs go through here rather than holding their own state: the
 * prefix in the text *is* the filter, so clicking "Artifacts" and typing
 * `artifact:` land in exactly the same place.
 */
export function setMentionKind(text: string, active: ActiveMention, kind: MentionKind | null): { text: string; caret: number } {
  const token = '@' + (kind ? `${kind}:` : '') + active.query
  const next = text.slice(0, active.start) + token + text.slice(active.end)
  return { text: next, caret: active.start + token.length }
}

// ---------------------------------------------------------------------------
// Search — one result shape for every kind
// ---------------------------------------------------------------------------

export type MentionHit = Mention & {
  /** the dimmer second line: a folder, a score reason, a session status */
  hint?: string
  /** files only */
  dir?: boolean
}

type Group = { kind: MentionKind; title: string; hits: MentionHit[] }

export const GROUP_TITLE: Record<MentionKind, string> = { file: 'Files', item: 'Work items', session: 'Sessions', artifact: 'Artifacts' }

/** How many hits each kind contributes on the All tab. */
const ALL_TAB_PER_KIND = 6

/** The picker's tabs, left to right; `null` is "All". */
export const MENTION_TABS: readonly (MentionKind | null)[] = [null, 'file', 'artifact', 'item', 'session']

const itemHit = (i: ScoredItem): MentionHit => ({
  kind: 'item',
  ref: i.id,
  label: i.title,
  hint: i.reason,
})

const sessionHit = (s: SessionSummary): MentionHit => ({
  kind: 'session',
  ref: s.id,
  label: s.title,
  hint: `${s.status} · ${s.cwd.split('/').pop() ?? ''}`,
})

const artifactHit = (a: ArtifactWithLinks): MentionHit => ({
  kind: 'artifact',
  ref: a.id,
  label: a.title,
  hint: `${a.author === 'model' ? 'model' : 'you'} · ${a.path}`,
})

const fileHit = (path: string, dir: boolean): MentionHit => {
  const parts = path.replace(/\/$/, '').split('/')
  const name = parts.pop() ?? path
  return { kind: 'file', ref: path, label: dir ? `${name}/` : name, hint: parts.length ? parts.join('/') + '/' : undefined, dir }
}

/**
 * Results for the active token. Items and sessions are already on the client
 * and rank locally; files ask the server for the folder's listing (debounced).
 * With no query, a few of each kind show so the picker teaches what `@` can do.
 */
export function useMentionSearch(active: ActiveMention | null, root: string, exclude: readonly Mention[]) {
  const sessions = useSessions()
  const inbox = useInbox()
  const artifacts = useArtifacts()
  const [files, setFiles] = useState<{ q: string; root: string; hits: MentionHit[]; error?: string }>({
    q: '',
    root: '',
    hits: [],
  })
  const timer = useRef<number | null>(null)

  const query = active?.query ?? ''
  const kind = active?.kind ?? null
  const wantFiles = active !== null && (kind === null || kind === 'file')
  const wantArtifacts = active !== null && (kind === null || kind === 'artifact')

  // Artifacts load lazily, the first time a token could mean one.
  useEffect(() => {
    if (wantArtifacts) void artifactStore.refresh()
  }, [wantArtifacts])

  useEffect(() => {
    if (!wantFiles) return
    if (timer.current) window.clearTimeout(timer.current)
    const ctl = new AbortController()
    timer.current = window.setTimeout(() => {
      const url = `/api/files/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}&limit=${kind === 'file' ? 30 : ALL_TAB_PER_KIND}`
      void fetch(url, { signal: ctl.signal })
        .then((r) => r.json() as Promise<FileSearchResponse>)
        .then((b) => {
          if (b.ok) setFiles({ q: query, root, hits: b.hits.map((h) => fileHit(h.path, h.dir)) })
          else setFiles({ q: query, root, hits: [], error: b.error })
        })
        .catch(() => {})
    }, 60)
    return () => {
      ctl.abort()
    }
  }, [wantFiles, query, root, kind])

  return useMemo<Group[]>(() => {
    if (!active) return []
    const taken = new Set(exclude.map((m) => `${m.kind}:${m.ref}`))
    const keep = (h: MentionHit) => !taken.has(`${h.kind}:${h.ref}`)
    const groups: Group[] = []
    // On the All tab every kind gets the same small slice, so no one kind
    // (files, always the longest list) pushes the others below the fold.
    const cap = kind === null ? ALL_TAB_PER_KIND : 30
    const push = (k: MentionKind, hits: MentionHit[]) => {
      if (hits.length || kind === k) groups.push({ kind: k, title: GROUP_TITLE[k], hits })
    }
    // Tab order, so the list and the tabs read the same way.
    if (kind === null || kind === 'file') {
      // Stale results (an older query, another folder) still show rather than
      // flashing empty; the next response replaces them.
      push('file', files.root === root ? files.hits.filter(keep).slice(0, cap) : [])
    }
    if (kind === null || kind === 'artifact') {
      const visible = artifacts.artifacts.filter((a) => !a.hidden)
      push('artifact', fuzzyRank(query, visible, (a) => a.title, cap, 2.5).map(artifactHit).filter(keep))
    }
    if (kind === null || kind === 'item') {
      push('item', fuzzyRank(query, inbox.items, (i) => i.title, cap, 2.5).map(itemHit).filter(keep))
    }
    if (kind === null || kind === 'session') {
      const chat = sessions.filter((s) => s.kind === 'chat')
      push('session', fuzzyRank(query, chat, (s) => s.title, cap, 2.5).map(sessionHit).filter(keep))
    }
    return groups
  }, [active, kind, query, root, files, inbox.items, sessions, artifacts.artifacts, exclude])
}

// ---------------------------------------------------------------------------
// The picked mentions, held until send
// ---------------------------------------------------------------------------

/**
 * What the message has attached, for as long as the message says so.
 *
 * The text is the truth and the chips are a mirror — so the mirror is *derived*
 * rather than kept in step: a mention counts as attached exactly while its
 * token is in the draft. Delete `@src/foo.ts`, or clear the box, and the chip
 * goes with it; nothing can be attached that the message doesn't mention.
 *
 * Picked mentions stay in the pool after their token leaves, because the text
 * can come back — retyped, pasted back, restored from a draft — and the
 * attachment should ride along with it rather than have to be picked again.
 * The pool is emptied on send.
 */
export function useMentions(text: string, initial: readonly Mention[] = []) {
  const [pool, setPool] = useState<Mention[]>(() => initial.slice(0, MAX_MENTIONS_PER_MESSAGE))

  const mentions = useMemo(() => pool.filter((m) => text.includes(mentionToken(m))), [pool, text])

  // The cap counts what is attached, not what the pool remembers — attaching
  // and detaching all afternoon must not use the budget up.
  const full = mentions.length >= MAX_MENTIONS_PER_MESSAGE

  const add = useCallback(
    (m: Mention) => {
      if (full) return
      setPool((prev) => {
        if (prev.some((p) => p.kind === m.kind && p.ref === m.ref)) return prev
        return [...prev, { kind: m.kind, ref: m.ref, label: m.label }]
      })
    },
    [full],
  )

  const clear = useCallback(() => setPool([]), [])

  /** The wire shape: whatever the message still mentions. */
  const payload = useCallback((): Mention[] | undefined => (mentions.length > 0 ? mentions : undefined), [mentions])

  return { mentions, add, clear, payload }
}
