/**
 * Junior's memory: facts Junior keeps on its own, one dated line each, in
 * `<workspace>/memory.md`. Who people are, what a project is, where something
 * stands, what the user said about a thing that will still be true next week.
 * Junior decides when something is worth keeping and doesn't ask first; the
 * user reads or edits the file, or tells Junior to forget a line.
 *
 * It is the third kind of memory, and the loosest, so it stays in its lane:
 *   - how the user works (a rule) is a learning: Junior proposes, the user keeps;
 *   - a fact true only today, or a rule the user states, is a pin;
 *   - everything else worth knowing next week is a memory line.
 *
 * Capped at MEMORY_MAX_BYTES, since it rides the system prompt of every chat
 * and thread: when a new line doesn't fit, the oldest lines move out to
 * `memory-archive.md` (kept, never loaded). A line is a line: newlines fold.
 *
 *   - 2026-11-14 · Priya owns the billing service; ask her before touching it.
 *
 * Lines the user wrote by hand without the date are kept as they are. Pure and
 * browser-safe; time is always an argument.
 */
import { dayKey } from './today.js'

/** Bytes the file may hold. About 1,000 tokens on every turn of every chat. */
export const MEMORY_MAX_BYTES = 4_096
/** The longest one line may be. */
export const MEMORY_LINE_MAX = 240

const HEADER = `# Junior's memory

Facts Junior keeps on its own, one per line. Edit or delete lines freely.
Older lines move to memory-archive.md when this file is full.
`

const LINE_RE = /^- (?:(\d{4}-\d{2}-\d{2}) · )?(.+)$/

export type MemoryLine = { day?: string; text: string }

/** One line of text: whitespace folded, invisible-free, cut at MEMORY_LINE_MAX. */
export function memoryText(raw: string): string {
  const t = raw
    .replace(/[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > MEMORY_LINE_MAX ? `${t.slice(0, MEMORY_LINE_MAX - 1).trimEnd()}…` : t
}

/** The lines of the file, oldest first. Headings and blank lines aren't memories. */
export function parseMemory(text: string): MemoryLine[] {
  const out: MemoryLine[] = []
  for (const raw of text.split('\n')) {
    const m = LINE_RE.exec(raw.trim())
    if (!m) continue
    const t = memoryText(m[2])
    if (t) out.push({ ...(m[1] ? { day: m[1] } : {}), text: t })
  }
  return out
}

export const memoryLine = (l: MemoryLine): string => `- ${l.day ? `${l.day} · ` : ''}${l.text}`

export function serializeMemory(lines: readonly MemoryLine[]): string {
  return `${HEADER}\n${lines.map(memoryLine).join('\n')}${lines.length ? '\n' : ''}`
}

const bytes = (s: string): number => new TextEncoder().encode(s).length
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Lines whose text contains `needle`, any case. */
export function matching(lines: readonly MemoryLine[], needle: string): number[] {
  const n = norm(needle)
  if (!n) return []
  return lines.flatMap((l, i) => (norm(l.text).includes(n) ? [i] : []))
}

export type RememberResult = { lines: MemoryLine[]; archived: MemoryLine[]; replaced?: MemoryLine; existed: boolean }

/**
 * Keep a fact. With `replaces`, the one line containing that text is swapped
 * for the new one (none or several matching is an error, so nothing is
 * guessed at). The same words twice keep one line. When the file would pass
 * the cap, the oldest lines go to `archived`.
 */
export function remember(lines: readonly MemoryLine[], input: { text: string; replaces?: string }, now: number): RememberResult {
  const text = memoryText(input.text)
  if (!text) throw new Error('a memory needs text')
  let next = [...lines]
  let replaced: MemoryLine | undefined
  if (input.replaces?.trim()) {
    const hits = matching(next, input.replaces)
    if (!hits.length) throw new Error(`no memory line contains "${input.replaces.trim()}"`)
    if (hits.length > 1) throw new Error(`${hits.length} memory lines contain "${input.replaces.trim()}"; quote more of the one to replace`)
    replaced = next[hits[0]]
    next.splice(hits[0], 1)
  }
  if (next.some((l) => norm(l.text) === norm(text))) return { lines: next, archived: [], ...(replaced ? { replaced } : {}), existed: !replaced }
  next.push({ day: dayKey(now), text })
  const archived: MemoryLine[] = []
  while (next.length > 1 && bytes(serializeMemory(next)) > MEMORY_MAX_BYTES) archived.push(next.shift() as MemoryLine)
  return { lines: next, archived, ...(replaced ? { replaced } : {}), existed: false }
}

/** Forget the one line containing `needle`. None or several matching is an error. */
export function forget(lines: readonly MemoryLine[], needle: string): { lines: MemoryLine[]; forgot: MemoryLine } {
  const hits = matching(lines, needle)
  if (!hits.length) throw new Error(`no memory line contains "${needle.trim()}"`)
  if (hits.length > 1) throw new Error(`${hits.length} memory lines contain "${needle.trim()}"; quote more of the one to forget`)
  const next = [...lines]
  const [forgot] = next.splice(hits[0], 1)
  return { lines: next, forgot }
}

/** The archive gets lines appended, oldest first, with no cap: it is never loaded. */
export function appendArchive(existing: string, lines: readonly MemoryLine[]): string {
  const head = existing.trim() ? existing.replace(/\n*$/, '\n') : ARCHIVE_HEADER
  return `${head}${lines.map(memoryLine).join('\n')}\n`
}

const ARCHIVE_HEADER = `# Junior's memory: archive\n\nLines that moved out of memory.md when it was full. Never loaded into a chat.\n\n`

/** The system-prompt block: the lines and how to keep more. Always present, so Junior knows the tools. */
export function memoryAppend(lines: readonly MemoryLine[]): string {
  const rules = [
    `\n\n## Your memory`,
    `Facts you keep on your own, across every chat. Keep one with remember when you learn something that will still`,
    `matter next week: who someone is, what a project or service is, where a long piece of work stands, a decision`,
    `and why. One plain line each. Update a line with remember's \`replaces\`; drop a wrong one with forget.`,
    `Not here: how the user wants work done (propose_learning), a fact true only today or a rule they state`,
    `(pin_note), secrets, tokens or passwords (never). Don't announce small saves; say so only when asked.`,
  ]
  const body = lines.length ? `\n${lines.map(memoryLine).join('\n')}` : `\n(nothing yet)`
  return `${rules.join('\n')}${body}`
}
