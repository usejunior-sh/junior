/**
 * Skills and agents (server/library.ts) from the browser: the list, one file,
 * and the writes. The server reloads every live session after a write and
 * broadcasts `library_changed`, which `useLibrary` refetches on, so a skill a
 * session just wrote shows up here without a refresh.
 */
import { useCallback, useEffect, useState } from 'react'
import type { LibraryEntry, LibraryFileResponse, LibraryKind, LibraryListResponse, LibraryTarget } from '../../shared/protocol.js'
import { draftStore } from './drafts.js'
import { store } from './store.js'

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const b = (await res.json()) as T & { ok: boolean; error?: string }
  if (!b.ok) throw new Error(b.error ?? `HTTP ${res.status}`)
  return b
}

export type LibraryList = { entries: LibraryEntry[]; targets: LibraryTarget[] }
export type LibraryFile = Extract<LibraryFileResponse, { ok: true }>

export function useLibrary(kind: LibraryKind, refreshNonce: number) {
  const [list, setList] = useState<LibraryList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    call<Extract<LibraryListResponse, { ok: true }>>('GET', `/api/library?kind=${kind}`)
      .then((b) => {
        setList({ entries: b.entries, targets: b.targets })
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [kind])
  useEffect(reload, [reload, refreshNonce])
  useEffect(() => store.onLibraryChanged(reload), [reload])
  return { list, error, reload }
}

export const readLibraryFile = (path: string) => call<LibraryFile>('GET', `/api/library/file?path=${encodeURIComponent(path)}`)
export const writeLibraryFile = (path: string, text: string) => call<LibraryFile>('PUT', '/api/library/file', { path, text })
export const createLibraryEntry = (body: { kind: LibraryKind; target: string; name: string; description: string }) =>
  call<{ ok: true; path: string }>('POST', '/api/library', body)
export const removeLibraryItem = (path: string, fileOnly = false) =>
  call<{ ok: true }>('DELETE', `/api/library?path=${encodeURIComponent(path)}${fileOnly ? '&file=1' : ''}`)
export const openLibraryFolder = (path: string) => call<{ ok: true }>('POST', '/api/library/open', { path })

/** The folder a target writes into, for a project target its repo, where a session making one should run. */
export const targetCwd = (t: LibraryTarget | undefined): string | undefined =>
  t?.id.startsWith('project:') ? t.id.slice('project:'.length) : undefined

/** Hand the job to Claude: a new session tab, prompt written, waiting for you to send it. */
export function askClaude(label: string, text: string, cwd?: string) {
  const d = draftStore.create({ label, text, ...(cwd ? { cwd } : {}) })
  // Leaving the settings page for the draft is just navigation.
  location.hash = `/new/${d.id}`
}

const WHAT = {
  skill: (dir: string, slug: string) =>
    `Write it to ${dir}/skills/${slug}/SKILL.md: frontmatter with \`name\` and a \`description\` that says what it does and when to use it (that line is how Claude decides to load it), then the instructions. Add files beside it (references/, scripts/) only if they earn their place.`,
  agent: (dir: string, slug: string) =>
    `Write it to ${dir}/agents/${slug}.md: frontmatter with \`name\`, a \`description\` that says when to hand work to it, and \`tools\` / \`model\` only if it needs limits; then its system prompt.`,
}

/** The prompt for "Create with Claude". */
export function createPrompt(kind: LibraryKind, target: LibraryTarget, name: string, brief: string): string {
  const slug = name || '<a short kebab-case name you pick>'
  const what = brief.trim() || '(ask me what it should do)'
  return [
    `Create a Claude Code ${kind === 'skill' ? 'skill' : 'subagent'}${name ? ` named "${name}"` : ''}. What it should do: ${what}`,
    '',
    WHAT[kind](target.dir, slug),
    '',
    'Ask me anything you need first, then write it. Junior reloads skills and agents in open sessions when your turn ends.',
  ].join('\n')
}

/** The prompt for "Improve with Claude" on an existing file. */
export function improvePrompt(e: LibraryEntry): string {
  return `Improve the Claude Code ${e.kind === 'skill' ? 'skill' : 'subagent'} "${e.name}" at ${e.path}.\n\nWhat I want changed: `
}
