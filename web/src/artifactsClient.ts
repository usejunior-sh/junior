/**
 * What the artifact surfaces share: URLs, fetches and hooks. No new socket
 * frame and no polling. Everything derives from `artifactStore` (the list,
 * reloaded on the server's `artifacts_changed`), and a per-id text or version
 * hook refetches when the list says that artifact's version moved.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArtifactContentResponse, ArtifactVersionsResponse, ArtifactWithLinks } from '../../shared/protocol.js'
import { artifactStore, useArtifacts } from './artifactStore.js'
import { withWorkspace } from './workspaceUrl.js'

export function artifactRawUrl(id: string, o: { v?: number; scripts?: boolean; download?: boolean } = {}): string {
  const q = new URLSearchParams({ id })
  if (o.v !== undefined) q.set('v', String(o.v))
  if (o.scripts) q.set('scripts', '1')
  if (o.download) q.set('download', '1')
  // img, iframe, embed and download links are not fetches, so they carry the workspace themselves
  return withWorkspace(`/api/artifacts/raw?${q}`)
}

async function getJson<T extends { ok: boolean }>(url: string): Promise<T | { ok: false; error: string }> {
  try {
    return (await (await fetch(url)).json()) as T
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function fetchArtifactContent(id: string, v?: number): Promise<ArtifactContentResponse> {
  const q = new URLSearchParams({ id })
  if (v !== undefined) q.set('v', String(v))
  return getJson<ArtifactContentResponse>(`/api/artifacts/content?${q}`)
}

export function fetchArtifactVersions(id: string): Promise<ArtifactVersionsResponse> {
  return getJson<ArtifactVersionsResponse>(`/api/artifacts/versions?id=${encodeURIComponent(id)}`)
}

/** Open the file on this Mac. Resolves to the error text, or null when it opened. */
export async function openArtifactFile(id: string, mode: 'editor' | 'reveal' | 'default'): Promise<string | null> {
  try {
    const res = await fetch('/api/artifacts/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, mode }),
    })
    const b = (await res.json()) as { ok: boolean; error?: string }
    return b.ok ? null : b.error ?? 'could not open'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** The first surface to ask loads the list. */
function useListLoaded() {
  const snap = useArtifacts()
  useEffect(() => {
    if (!snap.loaded && !snap.loading) void artifactStore.refresh()
  }, [snap.loaded, snap.loading])
  return snap
}

// An artifact the list hides (the brief of a finished item) is still there: ask the server before saying it is
// gone. An answer is good for as long as the list it was asked against.
const probes = new Map<string, { list: readonly ArtifactWithLinks[]; p: Promise<ArtifactContentResponse> }>()

/**
 * One artifact, live. `loading` until the list has loaded; `deleted` once it
 * has and the server does not know the id either (a card in an old chat).
 */
export function useArtifact(id: string): { phase: 'loading' | 'live' | 'deleted'; artifact?: ArtifactWithLinks } {
  const snap = useListLoaded()
  const listed = snap.artifacts.find((a) => a.id === id)
  const [probe, setProbe] = useState<{ id: string; res: ArtifactContentResponse } | null>(null)
  const missing = snap.loaded && !listed
  useEffect(() => {
    if (!missing) return
    let dead = false
    let hit = probes.get(id)
    if (!hit || hit.list !== snap.artifacts) {
      hit = { list: snap.artifacts, p: fetchArtifactContent(id) }
      probes.set(id, hit)
    }
    void hit.p.then((res) => {
      if (!dead) setProbe({ id, res })
    })
    return () => {
      dead = true
    }
    // the list moving (an artifact deleted or added) is a reason to ask again
  }, [id, missing, snap.artifacts])
  if (listed) return { phase: 'live', artifact: listed }
  if (!snap.loaded) return { phase: 'loading' }
  if (probe?.id !== id) return { phase: 'loading' }
  if (!probe.res.ok) return { phase: 'deleted' }
  const { artifact, links } = probe.res
  return { phase: 'live', artifact: { ...artifact, links: links.filter((l) => l.fromKind === 'artifact' && l.fromId === id), hidden: true } }
}

/** Artifacts a session published (an `output` link to it), the newest change first. */
export function useSessionArtifacts(sessionId: string): readonly ArtifactWithLinks[] {
  const snap = useListLoaded()
  return useMemo(
    () =>
      snap.artifacts
        .filter((a) => a.links.some((l) => l.role === 'output' && l.toKind === 'session' && l.toId === sessionId))
        .sort((a, b) => b.updated - a.updated),
    [snap.artifacts, sessionId],
  )
}

type TextState = { state: 'loading' | 'ready' | 'error'; text: string; truncated: boolean }
const LOADING: TextState = { state: 'loading', text: '', truncated: false }
const textCache = new Map<string, TextState>()
const textSubs = new Set<() => void>()

/**
 * The text of an artifact, or of one version of it. A version never changes,
 * so it is cached for good; with no version the text follows the list: when the
 * artifact's `version` moves it is fetched again.
 */
export function useArtifactText(id: string, version?: number): TextState {
  const snap = useArtifacts()
  const live = snap.artifacts.find((a) => a.id === id)?.version ?? 0
  const key = `${id}@${version ?? `live${live}`}`
  const [, bump] = useState(0)
  useEffect(() => {
    const sub = () => bump((n) => n + 1)
    textSubs.add(sub)
    return () => {
      textSubs.delete(sub)
    }
  }, [])
  useEffect(() => {
    const have = textCache.get(key)
    if (have && have.state !== 'error') return
    if (textCache.size > 200) textCache.clear()
    textCache.set(key, LOADING)
    void fetchArtifactContent(id, version).then((r) => {
      textCache.set(key, r.ok ? { state: 'ready', text: r.body, truncated: r.truncated } : { state: 'error', text: '', truncated: false })
      for (const fn of textSubs) fn()
    })
  }, [key, id, version])
  return textCache.get(key) ?? LOADING
}

/** The version list of one artifact. Reloads when the artifact's version moves in the list, or on `reload()`. */
export function useArtifactVersions(id: string): {
  state: 'loading' | 'ready' | 'error'
  data?: Extract<ArtifactVersionsResponse, { ok: true }>
  error?: string
  reload(): void
} {
  const snap = useArtifacts()
  const live = snap.artifacts.find((a) => a.id === id)?.version ?? 0
  const [nonce, setNonce] = useState(0)
  const [res, setRes] = useState<{ id: string; r: ArtifactVersionsResponse } | null>(null)
  useEffect(() => {
    let dead = false
    void fetchArtifactVersions(id).then((r) => {
      if (!dead) setRes({ id, r })
    })
    return () => {
      dead = true
    }
  }, [id, live, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  if (!res || res.id !== id) return { state: 'loading', reload }
  if (!res.r.ok) return { state: 'error', error: res.r.error, reload }
  return { state: 'ready', data: res.r, reload }
}
