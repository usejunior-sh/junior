import { GitCompare, History } from 'lucide-react'
import type { ArtifactFormat, ArtifactVersionsResponse } from '../../../../shared/protocol.js'
import { compareMode, previousVersion, versionLine } from '../../artifactView.js'
import { Select, SelectItem } from '../../ui/Select.js'

type Versions = Extract<ArtifactVersionsResponse, { ok: true }>

export type Compare = { on: boolean; side: 'old' | 'new' }

type Props = {
  format: ArtifactFormat
  state: 'loading' | 'ready' | 'error'
  data?: Versions
  error?: string
  /** the version on show */
  version: number
  /** the newest version */
  latest: number
  /** the session's title, or null when no such session exists any more */
  sessionTitle: (id: string) => string | null
  onSelect: (v: number | null) => void
  compare: Compare
  onCompare: (c: Compare) => void
}

/**
 * The version dropdown and how to compare. Text formats get a "Changes" diff
 * of the version before it against the one on show; html, pdf and images get
 * an Old / New switch that swaps what the viewer loads. Version 1 has nothing
 * to compare with, and a file with no history has no other version to pick.
 */
export function VersionBar({ format, state, data, error, version, latest, sessionTitle, onSelect, compare, onCompare }: Props) {
  if (state === 'loading') return <div className="artVer artVerQuiet">Loading versions…</div>
  if (state === 'error' || !data) return <div className="artVer artVerQuiet">Versions are not available. {error}</div>

  const noHistory = !data.history
  const prev = noHistory ? undefined : previousVersion(data.versions, version)
  const viewingOld = version !== latest
  const mode = compareMode(format)

  return (
    <div className="artVer">
      <History size={14} aria-hidden="true" className="artVerIcon" />
      <Select
        className="artVerSelect"
        contentClassName="artVerMenu"
        aria-label="Version"
        value={String(version)}
        onValueChange={(v) => onSelect(Number(v) === latest ? null : Number(v))}
        disabled={noHistory || data.versions.length < 2}
      >
        {data.versions.map((v) => (
          <SelectItem key={v.sha || v.version} value={String(v.version)} description={v.note}>
            {versionLine(v, sessionTitle)}
          </SelectItem>
        ))}
      </Select>

      {noHistory && <span className="artVerNote">{data.historyNote ?? 'This file keeps no history.'}</span>}
      {data.capped && !noHistory && <span className="artVerNote">Showing the latest 200 versions.</span>}
      {viewingOld && (
        <button type="button" className="link artVerBack" onClick={() => onSelect(null)}>
          Back to latest
        </button>
      )}

      <span className="spacer" />

      {prev &&
        (mode === 'text' ? (
          <button
            type="button"
            className={`btn xs${compare.on ? '' : ' ghost'}`}
            aria-pressed={compare.on}
            onClick={() => onCompare({ ...compare, on: !compare.on })}
            title={`Lines that changed between v${prev.version} and v${version}`}
          >
            <GitCompare size={12} aria-hidden="true" /> Changes
          </button>
        ) : (
          <div className="seg" role="group" aria-label={`Compare v${prev.version} with v${version}`}>
            <button
              type="button"
              className={`segBtn${compare.on && compare.side === 'old' ? ' active' : ''}`}
              aria-pressed={compare.on && compare.side === 'old'}
              onClick={() => onCompare({ on: true, side: 'old' })}
              title={`Show v${prev.version}`}
            >
              Old
            </button>
            <button
              type="button"
              className={`segBtn${!compare.on || compare.side === 'new' ? ' active' : ''}`}
              aria-pressed={!compare.on || compare.side === 'new'}
              onClick={() => onCompare({ on: false, side: 'new' })}
              title={`Show v${version}`}
            >
              New
            </button>
          </div>
        ))}
    </div>
  )
}
