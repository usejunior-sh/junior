import { File, FileCode, FileJson, FileSpreadsheet, FileText, FileType, Image } from 'lucide-react'
import type { ArtifactFormat } from '../../shared/protocol.js'

/** The short badge text for a format: `MD`, `HTML`, `CSV`… */
export const formatLabel = (f: ArtifactFormat): string => f.toUpperCase()

export function FormatIcon({ format, size = 14 }: { format: ArtifactFormat; size?: number }) {
  const p = { size, 'aria-hidden': true, className: 'artFmtIcon' }
  switch (format) {
    case 'md':
    case 'txt':
      return <FileText {...p} />
    case 'html':
      return <FileCode {...p} />
    case 'json':
      return <FileJson {...p} />
    case 'csv':
      return <FileSpreadsheet {...p} />
    case 'pdf':
      return <FileType {...p} />
    case 'svg':
    case 'png':
    case 'jpg':
    case 'gif':
    case 'webp':
      return <Image {...p} />
    default:
      return <File {...p} />
  }
}

// The chip grouping is a pure rule, so it lives in artifactView.ts where a node test can reach it (no JSX there).
export { FORMAT_CHIPS, chipOf, type FormatChip } from './artifactView.js'

/** `812 B`, `12 KB`, `1.4 MB`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** `now`, `5m`, `3h`, `2d`: the Artifacts page's `when` rule. */
export function artifactAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`: the artifact page's header, where a lone `5m` would read as a duration. */
export function artifactAgoLong(ms: number): string {
  const short = artifactAgo(ms)
  if (short === 'now') return 'just now'
  const n = short.slice(0, -1)
  return `${n} ${short.endsWith('m') ? 'min' : short.endsWith('h') ? 'h' : 'd'} ago`
}
