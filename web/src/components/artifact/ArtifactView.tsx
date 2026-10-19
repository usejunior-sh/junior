import { useState } from 'react'
import { Download, ExternalLink, FileX } from 'lucide-react'
import type { Artifact } from '../../../../shared/protocol.js'
import { artifactRawUrl, openArtifactFile } from '../../artifactsClient.js'
import { prettyJson } from '../../artifactView.js'
import { onThisMac } from '../../device.js'
import { useIsMobile } from '../../useMobile.js'
import { Markdown } from '../Markdown.js'
import { CsvView } from './CsvView.js'
import { HtmlView } from './HtmlView.js'

type Props = {
  artifact: Artifact
  /** the text of the version on show: md without frontmatter, other text formats raw, '' for binary ones */
  body: string
  /** the server cut `body` at its inline cap */
  truncated: boolean
  /** the version on show: the raw url asks for it by number, so a new version loads a fresh frame */
  version: number
}

/** The viewer for one format. Each format's pieces are their own components; this only picks. */
export function ArtifactView({ artifact: a, body, truncated, version }: Props) {
  switch (a.format) {
    case 'md':
      return (
        <div className="artView artViewMd">
          {body.trim() ? <Markdown text={body} /> : <div className="artEmpty">Empty. Edit here, or open it in your editor.</div>}
        </div>
      )
    case 'html':
      return <HtmlView id={a.id} version={version} title={a.title} byModel={a.author === 'model'} />
    case 'csv':
      return <CsvView text={body} cut={truncated} />
    case 'pdf':
      return <PdfView id={a.id} version={version} title={a.title} />
    case 'png':
    case 'jpg':
    case 'gif':
    case 'webp':
      return <ImageView id={a.id} version={version} title={a.title} />
    case 'svg':
      return <SvgView id={a.id} version={version} title={a.title} source={body} cut={truncated} />
    case 'json':
      return <CodeView text={prettyJson(body)} cut={truncated} empty="Empty file." />
    case 'txt':
      return <CodeView text={body} cut={truncated} empty="Empty file." />
  }
}

function CodeView({ text, cut, empty }: { text: string; cut: boolean; empty: string }) {
  if (!text.trim()) return <div className="artView artEmpty artViewEmpty">{empty}</div>
  return (
    <div className="artView">
      <pre className="artCode">{text}</pre>
      {cut && <div className="artViewNote">The file is large. This is the start of it.</div>}
    </div>
  )
}

/** What a viewer shows when the raw route answers with an error: the file is gone. */
function Missing() {
  return (
    <div className="artViewMissing">
      <FileX size={20} aria-hidden="true" />
      <p>The file is gone. It was deleted or moved out of the artifacts folder.</p>
    </div>
  )
}

function ImageView({ id, version, title }: { id: string; version: number; title: string }) {
  const [bad, setBad] = useState(false)
  if (bad) return <Missing />
  return (
    <div className="artView artViewImg">
      {/* `key` so a new version clears an earlier failure */}
      <img key={version} src={artifactRawUrl(id, { v: version })} alt={title} onError={() => setBad(true)} />
    </div>
  )
}

function SvgView({ id, version, title, source, cut }: { id: string; version: number; title: string; source: string; cut: boolean }) {
  const [showSource, setShowSource] = useState(false)
  const [bad, setBad] = useState(false)
  return (
    <div className="artView">
      <div className="artViewBar">
        <div className="seg" role="group" aria-label="View">
          <button type="button" className={`segBtn${showSource ? '' : ' active'}`} aria-pressed={!showSource} onClick={() => setShowSource(false)}>
            Image
          </button>
          <button type="button" className={`segBtn${showSource ? ' active' : ''}`} aria-pressed={showSource} onClick={() => setShowSource(true)}>
            Source
          </button>
        </div>
      </div>
      {showSource ? (
        <>
          <pre className="artCode">{source}</pre>
          {cut && <div className="artViewNote">The file is large. This is the start of it.</div>}
        </>
      ) : bad ? (
        <Missing />
      ) : (
        <div className="artViewImg">
          {/* an <img>, never inline markup: the svg cannot run script this way */}
          <img key={version} src={artifactRawUrl(id, { v: version })} alt={title} onError={() => setBad(true)} />
        </div>
      )}
    </div>
  )
}

/**
 * A pdf in an embed. A phone cannot show one in a page, so it gets a plain
 * link that opens the file in a tab. Off the Mac there is no "default app" to
 * ask for, so the fallback there is the same link.
 */
function PdfView({ id, version, title }: { id: string; version: number; title: string }) {
  const phone = useIsMobile()
  const [err, setErr] = useState<string | null>(null)
  const url = artifactRawUrl(id, { v: version })
  const external =
    onThisMac() && !phone ? (
      <button type="button" className="link" onClick={() => void openArtifactFile(id, 'default').then(setErr)}>
        Open it in your PDF app
      </button>
    ) : (
      <a className="link" href={url} target="_blank" rel="noreferrer">
        Open it in a new tab
      </a>
    )
  return (
    <div className="artView artViewPdf">
      {/* the browser's own PDF toolbar and thumbnails are hidden: the page's header already has Download and the rest */}
      {!phone && <embed key={version} className="artPdfEmbed" type="application/pdf" src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={title} />}
      <div className="artViewFoot">
        {phone ? 'PDFs open in their own tab on a phone. ' : 'Not showing? '}
        {external}
        {err && <span className="artViewErr">{err}</span>}
      </div>
    </div>
  )
}
