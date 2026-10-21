import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Viewport } from '../../core/browser/wire.js'
import { type Shot, type ShotKind, VIEWPORTS } from './hub.js'

/**
 * How a viewport reads to the agent. null is a tab that fits the pane (where
 * new tabs start): its size is the pane's, so it is given when known.
 */
export const viewportLabel = (v: Viewport | null, fit?: { width: number; height: number } | null): string => {
  if (!v) return fit ? `fits the pane, ${fit.width}×${fit.height}` : 'fits the pane'
  const name = Object.entries(VIEWPORTS).find(([, p]) => p.width === v.width && p.height === v.height)?.[0]
  return `${v.width}×${v.height}${name ? ` ${name}` : v.mobile ? ' mobile' : ''}`
}

// Evidence: what the agent saw, kept per session on disk.

export class ShotStore {
  constructor(readonly root: string) {}

  dir(sessionId: string) {
    if (!/^[\w-]+$/.test(sessionId)) throw new Error('bad session id')
    return path.join(this.root, sessionId)
  }

  list(sessionId: string): Shot[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(sessionId), 'shots.json'), 'utf8')) as Shot[]
    } catch {
      return []
    }
  }

  async add(sessionId: string, data: Buffer, mime: string, meta: Omit<Shot, 'n' | 'file' | 'mime' | 'at'>): Promise<Shot> {
    const dir = this.dir(sessionId)
    await fsp.mkdir(dir, { recursive: true })
    const shots = this.list(sessionId)
    const n = (shots.at(-1)?.n ?? 0) + 1
    const file = `${n}.${mime === 'image/png' ? 'png' : 'webp'}`
    await fsp.writeFile(path.join(dir, file), data)
    const shot: Shot = { n, file, mime, at: Date.now(), ...meta }
    shots.push(shot)
    await fsp.writeFile(path.join(dir, 'shots.json'), JSON.stringify(shots, null, 1))
    return shot
  }

  file(sessionId: string, n: number): { path: string; mime: string } | null {
    const s = this.list(sessionId).find((x) => x.n === n)
    return s ? { path: path.join(this.dir(sessionId), s.file), mime: s.mime } : null
  }

  async remove(sessionId: string) {
    await fsp.rm(this.dir(sessionId), { recursive: true, force: true }).catch(() => {})
  }

  turns(sessionId: string): VerifiedTurn[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(sessionId), 'turns.json'), 'utf8')) as VerifiedTurn[]
    } catch {
      return []
    }
  }

  /** A turn that used the browser ended: remember which shots it took and what the agent said. */
  async addTurn(sessionId: string, turn: VerifiedTurn): Promise<VerifiedTurn[]> {
    const turns = [...this.turns(sessionId), turn]
    await fsp.mkdir(this.dir(sessionId), { recursive: true })
    await fsp.writeFile(path.join(this.dir(sessionId), 'turns.json'), JSON.stringify(turns, null, 1))
    return turns
  }
}

export type VerifiedTurn = { startedAt: number; endedAt: number; summary: string; shots: number[] }

export const shotUrl = (workspaceId: string, sessionId: string, n: number) =>
  `/api/browser/shots/${sessionId}/${n}?workspace=${encodeURIComponent(workspaceId)}`

const KIND_LABEL: Record<ShotKind, string> = { screenshot: 'Screenshot', checkpoint: 'Checkpoint', compare: 'Compare', pick: 'Picked' }

/**
 * The Verification note (.docs/browser.md, Proof): every turn that used the
 * browser, newest first, what the agent said it did, and the screenshots,
 * checkpoints and diffs it took to see it. Rewritten after each such turn.
 */
export function renderVerification(o: { title: string; workspaceId: string; sessionId: string; turns: VerifiedTurn[]; shots: Shot[] }): string {
  const byN = new Map(o.shots.map((s) => [s.n, s]))
  const when = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 16)
  const parts: string[] = [
    `What the agent looked at in the browser while it worked, turn by turn. Screenshots are what the agent itself saw; compares show red where pixels changed since the checkpoint.`,
  ]
  for (const t of [...o.turns].reverse()) {
    const shots = t.shots.map((n) => byN.get(n)).filter((s): s is Shot => !!s)
    if (!shots.length) continue
    parts.push(`## ${when(t.endedAt)} UTC`)
    const summary = t.summary.trim()
    if (summary) parts.push(summary.length > 1500 ? `${summary.slice(0, 1500)}…` : summary)
    const urls = [...new Set(shots.map((s) => s.url))]
    parts.push(`Pages: ${urls.map((u) => `\`${u}\``).join(', ')}`)
    for (const s of shots) {
      const label = [KIND_LABEL[s.kind], s.label ? `“${s.label}”` : '', s.viewport, s.note ?? ''].filter(Boolean).join(' · ')
      parts.push(`**#${s.n}** ${label}\n\n![${KIND_LABEL[s.kind]} ${s.n}](${shotUrl(o.workspaceId, o.sessionId, s.n)})`)
    }
  }
  return parts.join('\n\n') + '\n'
}

/** The marker a tool result carries so the transcript can show the saved shot. */
export const shotMarker = (n: number) => `[shot #${n}]`
export const SHOT_MARKER_RE = /\[shot #(\d+)\]/g
