/**
 * A file Junior published, drawn in the chat where it made it: a thumbnail of
 * the file on the left; on the right the title, one line of facts (format, size,
 * when) and the ways to open it. It is derived from the event log
 * (`foldArtifacts` in transcript.ts), so it comes back on reload and resume.
 *
 * The thumbnail is a picture, never a live page: text is clamped, a CSV is a few
 * rows, an image is cropped to fit, and an HTML page or a PDF is its first
 * screen in a frame with scripts off and no pointer events. The page itself is
 * one click away on the artifact page, where it runs sandboxed.
 */
import { Check, Copy, ExternalLink, FolderOpen, Loader, Pencil } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isImageFormat, type ArtifactFormat } from '../../../shared/protocol.js'
import { parseCsv } from '../../../shared/csv.js'
import { artifactRawUrl, openArtifactFile, useArtifact, useArtifactText } from '../artifactsClient.js'
import { artifactAgo, FormatIcon, formatLabel, fmtBytes } from '../artifactFormat.js'
import { onThisMac } from '../device.js'
import { ARTIFACT_BODY_KEEP, type ArtifactItem } from '../transcript.js'
import { Tooltip } from '../ui/Tooltip.js'

const PREVIEW_LINES = 8
const PREVIEW_CHARS = 320
const CSV_ROWS = 5
const CSV_COLS = 4

/** Markdown as it reads: no heading hashes, emphasis stars, backticks or quote marks, so the tile looks like a page, not source. */
export function plainMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\n{3,}/g, '\n\n')
}

/** The first few lines of a text, for the clamped preview. */
export function excerpt(text: string): string {
  const lines = text.trim().split('\n').slice(0, PREVIEW_LINES).join('\n')
  return lines.length > PREVIEW_CHARS ? `${lines.slice(0, PREVIEW_CHARS).trimEnd()} …` : lines
}

/** What a format's thumbnail is made of: its own text, a few CSV rows, the image, or (html, pdf, anything else) a frame or a glyph. */
function previewKind(f: ArtifactFormat): 'text' | 'csv' | 'image' | 'glyph' {
  if (f === 'md' || f === 'txt' || f === 'json') return 'text'
  if (f === 'csv') return 'csv'
  if (isImageFormat(f)) return 'image'
  return 'glyph'
}

/** A tile with no picture to show: the format's icon, large and quiet. */
function Glyph({ format }: { format: ArtifactFormat }) {
  return (
    <div className="artGlyph">
      <FormatIcon format={format} size={26} />
    </div>
  )
}

/** Fetches the text only when asked to: a preview with a body in hand never calls this. */
function Fetched({ id, version, children }: { id: string; version?: number; children: (t: ReturnType<typeof useArtifactText>) => ReactNode }) {
  return <>{children(useArtifactText(id, version))}</>
}

function CsvTable({ text }: { text: string }) {
  const csv = useMemo(() => parseCsv(text, CSV_ROWS), [text])
  const cols = Math.min(CSV_COLS, Math.max(csv.header.length, ...csv.rows.map((r) => r.length)))
  return (
    <table className="artCardCsv">
      <thead>
        <tr>
          {Array.from({ length: cols }, (_, i) => (
            <th key={i}>{csv.header[i] ?? ''}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {csv.rows.map((r, ri) => (
          <tr key={ri}>
            {Array.from({ length: cols }, (_, i) => (
              <td key={i}>{r[i] ?? ''}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A page or a PDF as a picture: the real file in a big frame, shrunk to the tile. Scripts off, no clicks, no focus. */
function Framed({ kind, src }: { kind: 'html' | 'pdf'; src: string }) {
  return (
    <div className={`artShrink ${kind}`} aria-hidden="true">
      <iframe
        className="artShrinkFrame"
        title=""
        tabIndex={-1}
        loading="lazy"
        // empty sandbox: no scripts, no forms, no same-origin; the raw route adds its own CSP on top
        {...(kind === 'html' ? { sandbox: '' } : {})}
        src={kind === 'pdf' ? `${src}#toolbar=0&navpanes=0&scrollbar=0&view=FitH` : src}
      />
    </div>
  )
}

function Thumb({ item, id, format, version, deleted }: { item: ArtifactItem; id: string; format: ArtifactFormat; version?: number; deleted: boolean }) {
  const kind = previewKind(format)
  const [imgFailed, setImgFailed] = useState(false)
  // A deleted file has no bytes to draw; an old version of a file over 10 MB has none either: the glyph stays.
  if (deleted) return <Glyph format={format} />
  const src = artifactRawUrl(id, version ? { v: version } : {})
  if (format === 'html' || format === 'pdf') return <Framed kind={format} src={src} />
  if (kind === 'image') {
    if (imgFailed) return <Glyph format={format} />
    return <img className="artCardThumb" loading="lazy" alt="" src={src} onError={() => setImgFailed(true)} />
  }
  // A body the transcript cut short undercounts a CSV's rows, so those read the file.
  const have = item.body !== undefined && !(kind === 'csv' && item.body.length >= ARTIFACT_BODY_KEEP)
  const show = (text: string) => (kind === 'csv' ? <CsvTable text={text} /> : <pre className="artText">{excerpt(format === 'md' ? plainMarkdown(text) : text)}</pre>)
  if (have) return show(item.body!)
  return (
    <Fetched id={id} version={version}>
      {(t) => (t.state === 'ready' ? show(t.text) : t.state === 'loading' ? <div className="artSkel" aria-hidden="true" /> : <Glyph format={format} />)}
    </Fetched>
  )
}

/** Open in editor / Reveal / Copy path: they act on this Mac's files, so they are offered only here. Icon buttons: the card's one labelled button is Open. */
function MacActions({ id, abs, disabled, onError }: { id: string; abs: string; disabled: boolean; onError: (msg: string | null) => void }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const open = (mode: 'editor' | 'reveal') => {
    onError(null)
    void openArtifactFile(id, mode).then(onError)
  }
  const copy = () => {
    void navigator.clipboard.writeText(abs).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 2000)
      },
      () => onError('Could not copy the path'),
    )
  }
  return (
    <>
      <Tooltip content="Open in editor">
        <button type="button" className="btn icon sm ghost" aria-label="Open in editor" disabled={disabled} onClick={() => open('editor')}>
          <Pencil size={13} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip content="Reveal in Finder">
        <button type="button" className="btn icon sm ghost" aria-label="Reveal in Finder" disabled={disabled} onClick={() => open('reveal')}>
          <FolderOpen size={13} aria-hidden="true" />
        </button>
      </Tooltip>
      {abs && !disabled && (
        <Tooltip content={copied ? 'Copied' : <span className="mono">Copy path · {abs}</span>}>
          <button type="button" className="btn icon sm ghost" aria-label="Copy path" onClick={copy}>
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          </button>
        </Tooltip>
      )}
    </>
  )
}

/** The call is out and nothing has come back. It may be waiting on your OK, so the copy does not say it is publishing. */
function Publishing({ item }: { item: ArtifactItem }) {
  const title = typeof item.call.input.title === 'string' ? item.call.input.title : ''
  return (
    <div className="artCard pending" role="status">
      <div className="artBody">
        <div className="artTop">
          <span className="glyph busy" aria-hidden="true">
            <Loader size={13} />
          </span>
          <span className="artCardTitle muted">{title ? `Preparing ${title}…` : 'Preparing an artifact…'}</span>
        </div>
      </div>
    </div>
  )
}

function Published({ item, onOpen }: { item: ArtifactItem; onOpen: (hash: string) => void }) {
  const pub = item.pub!
  const live = useArtifact(pub.id)
  const [err, setErr] = useState<string | null>(null)
  const deleted = live.phase === 'deleted'
  const newer = live.artifact && pub.version > 0 && live.artifact.version > pub.version ? live.artifact.version : 0
  const version = pub.version > 0 ? pub.version : undefined
  const noChange = pub.action === 'unchanged' && item.calls === 1
  const label = noChange ? 'No change' : item.created ? 'New' : 'Updated'
  const at = item.call.endedAt ?? item.call.startedAt
  const hash = `/artifact/${pub.id}`
  const facts = [formatLabel(pub.format), pub.size > 0 ? fmtBytes(pub.size) : '', at !== undefined ? artifactAgo(at) : ''].filter(Boolean)
  return (
    <section className={`artCard${deleted ? ' gone' : ''}`} aria-label={`Artifact: ${pub.title}`}>
      {/* the picture is a mouse shortcut to Open; keyboard and screen readers use the title and the Open button */}
      <div className="artTile" aria-hidden="true" onClick={deleted ? undefined : () => onOpen(hash)}>
        <Thumb item={item} id={pub.id} format={pub.format} version={version} deleted={deleted} />
      </div>
      <div className="artBody">
        <div className="artTop">
          <button type="button" className="artCardTitle" disabled={deleted} onClick={() => onOpen(hash)}>
            {pub.title}
          </button>
          {deleted ? (
            <span className="pill mono artDel">Deleted</span>
          ) : (
            <span className={`pill mono${item.created && !noChange ? ' artNew' : ''}`}>
              {label}
              {!noChange && version ? ` · v${version}` : ''}
            </span>
          )}
        </div>
        <div className="artFacts">
          <FormatIcon format={pub.format} size={12} />
          <span title={at !== undefined ? new Date(at).toLocaleString() : undefined}>{facts.join(' · ')}</span>
          {newer > 0 && <span className="artNow">now v{newer}</span>}
        </div>
        <div className="artActs">
          <button type="button" className="btn xs" disabled={deleted} onClick={() => onOpen(hash)}>
            <ExternalLink size={12} aria-hidden="true" /> Open
          </button>
          {onThisMac() && <MacActions id={pub.id} abs={pub.abs} disabled={deleted} onError={setErr} />}
        </div>
        {err && <div className="artErr">{err}</div>}
      </div>
    </section>
  )
}

export function ArtifactCard({ item, onOpen }: { item: ArtifactItem; onOpen: (hash: string) => void }) {
  return item.pub ? <Published item={item} onOpen={onOpen} /> : <Publishing item={item} />
}
