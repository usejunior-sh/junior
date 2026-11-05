import { useState, useEffect, useCallback } from 'react'
import type { SessionSummary, JobsResponse } from '../../../shared/protocol.js'
import type { OpenTab } from '../components/TabBand.js'
import { useConn, type Route } from '../hooks.js'
import { useInbox } from '../inboxStore.js'
import { useArtifacts } from '../artifactStore.js'
import { GENERIC, isDocKey, kindOfKey, sectionOf, tabKeyOf } from './tabs.js'
import { JUNIOR_DM, findDm } from '../../../core/junior/dms.js'
import { useChatAgents } from '../chatAgents.js'
import { usePersona } from '../junior.js'
import { needsYouText } from '../inboxTabs.js'
import { isWorking } from '../sessionModes.js'
import type { TabsApi } from './types.js'

export function useDocumentTabs({ conn, route, docKeys, inbox, artifacts, sessions, titles, openTab, remember, setPreview }: {
  conn: ReturnType<typeof useConn>
  route: Route
  docKeys: string[]
  inbox: ReturnType<typeof useInbox>
  artifacts: ReturnType<typeof useArtifacts>
  sessions: readonly SessionSummary[]
  titles: TabsApi['titles']
  openTab: TabsApi['open']
  remember: TabsApi['remember']
  setPreview: TabsApi['setPreview']
}) {
  // Jobs have no client store; the band needs their titles, so fetch the
  // (small) list once the first job is in play and keep it.
  const [jobTitles, setJobTitles] = useState<Map<string, string>>(new Map())
  const wantJobTitles = sectionOf(route) === 'jobs' || docKeys.some((k) => k.startsWith('job'))
  useEffect(() => {
    if (conn !== 'connected' || !wantJobTitles) return
    void fetch('/api/jobs')
      .then((r) => r.json() as Promise<JobsResponse>)
      .then((b) => {
        if (b.ok) setJobTitles(new Map(b.jobs.map((w) => [w.id, w.title])))
      })
      .catch(() => {})
  }, [conn, wantJobTitles])

  // DM tabs are named and faced after their agent, and light up like a chat's.
  const chatAgents = useChatAgents()
  const persona = usePersona()

  /** The live name for a document tab, or null while its store is still cold. */
  const liveTitle = useCallback(
    (key: string): string | null => {
      const id = key.slice(key.indexOf(':') + 1)
      if (key.startsWith('item:')) return inbox.items.find((i) => i.id === id)?.title ?? null
      if (key.startsWith('artifact:')) return artifacts.artifacts.find((a) => a.id === id)?.title ?? null
      if (key.startsWith('run:')) {
        const lead = sessions.find((s) => s.teamRun?.id === id && s.teamRun.role === 'lead')
        return lead ? `Run · ${lead.title}` : null
      }
      if (key.startsWith('dm:')) {
        if (id === JUNIOR_DM) return persona.name
        // The face already says it's Junior: the tab names the agent alone, so it fits.
        return chatAgents.find((a) => a.name === id)?.label ?? null
      }
      if (key.startsWith('job:')) return jobTitles.get(id) ?? null
      if (key.startsWith('job-form:')) return id === 'new' ? 'New job' : jobTitles.get(id) ?? null
      if (key.startsWith('change:')) {
        // A file is named by its basename; the path lives in the page header.
        const file = decodeURIComponent(id.slice(id.indexOf('/') + 1))
        return file.slice(file.lastIndexOf('/') + 1)
      }
      return null
    },
    [inbox.items, artifacts.artifacts, jobTitles, sessions, chatAgents, persona.name],
  )

  /** A document tab: its best known name, no project dot, nothing running. */
  const docTab = useCallback(
    (key: string): OpenTab | null => {
      const kind = kindOfKey(key)
      if (!kind) return null
      const tab: OpenTab = { key, kind, title: (liveTitle(key) ?? titles[key]) || GENERIC[kind], color: 'var(--stone)', running: false }
      if (kind !== 'dm') return tab
      const dm = key.slice(3)
      const session = findDm(sessions, dm)
      const face = dm === JUNIOR_DM ? undefined : (chatAgents.find((a) => a.name === dm)?.colour ?? undefined)
      const waiting = session ? needsYouText(session) : null
      const running = !!session && isWorking(session)
      return { ...tab, face, color: running ? 'var(--blue)' : 'var(--stone)', running, ...(waiting ? { waiting } : {}) }
    },
    [liveTitle, titles, sessions, chatAgents],
  )

  /** Commit a peeked document to a real tab, it stops being replaceable. */
  const pin = useCallback(
    (key: string, title?: string) => {
      if (title) remember({ [key]: title })
      openTab(key)
    },
    [openTab, remember],
  )

  /** Editing what you were only peeking at makes it yours: keep the tab. */
  const pinCurrent = useCallback(() => {
    const key = tabKeyOf(route)
    if (key && isDocKey(key)) openTab(key)
  }, [route, openTab])

  // The peek slot: opening a document parks it in the band so it survives you
  // looking at a session.
  useEffect(() => {
    const key = tabKeyOf(route)
    if (key && isDocKey(key)) setPreview(key)
  }, [route, setPreview])

  // Names arrive after the tab does: stores load, things get renamed. Teach
  // the band every name it can currently resolve.
  useEffect(() => {
    const patch: Record<string, string> = {}
    for (const k of docKeys) {
      const t = liveTitle(k)
      if (t) patch[k] = t
    }
    if (Object.keys(patch).length) remember(patch)
  }, [docKeys, liveTitle, remember])

  return { docTab, pin, pinCurrent }
}
