import { AtSign, Copy, Download, ExternalLink, FolderOpen, Inbox, MessagesSquare, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { Artifact, Link } from '../../../../shared/protocol.js'
import { artifactAgoLong, fmtBytes, formatLabel } from '../../artifactFormat.js'
import { artifactRawUrl } from '../../artifactsClient.js'
import { itemHash } from '../../hooks.js'
import { onThisMac } from '../../device.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../ui/Menu.js'

/** The links other than the session that made it: the work items and notes it belongs to, as small inline chips. */
const MAX_LINKS = 2

type Props = {
  artifact: Artifact
  version: number
  /** the newest version */
  newest: number
  latest: boolean
  abs: string
  /** the session that published it, and its title (null once that session is gone) */
  origin: string | null | undefined
  originTitle: string | null | undefined
  links: readonly Link[]
  itemTitle: (id: string) => string
  sessionTitle: (id: string) => string | null
  canEdit: boolean
  busy: boolean
  confirmingDelete: boolean
  onNavigate: (hash: string) => void
  onEdit: () => void
  onOpenOnMac: (mode: 'editor' | 'reveal' | 'default') => void
  onCopy: (what: 'mention' | 'path') => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onDelete: () => void
}

/**
 * The top of the artifact page. One calm line says what it is and where it came
 * from; one primary action sits beside the title (Edit for a note, Download for
 * a file) and everything else is in the ⋯ menu, so the file gets the screen.
 */
export function ArtifactHeader(p: Props) {
  const a = p.artifact
  const isMd = a.format === 'md'
  const others = p.links
    .map((l) => (l.fromKind === 'artifact' && l.fromId === a.id ? { kind: l.toKind, id: l.toId } : { kind: l.fromKind, id: l.fromId }))
    .filter((o) => o.id !== p.origin && o.kind !== 'artifact')
  const shown = others.slice(0, MAX_LINKS)
  const more = others.length - shown.length
  const mac = onThisMac()

  return (
    <header className="apHead">
      <div className="apTitleRow">
        <h1 className="display md apTitle">{a.title}</h1>
        <div className="apActions">
          {p.confirmingDelete ? (
            <>
              <span className="apConfirm">Delete this artifact? Git keeps its history.</span>
              <button type="button" className="btn sm ghost" onClick={p.onCancelDelete} disabled={p.busy}>
                Cancel
              </button>
              <button type="button" className="btn sm danger" onClick={p.onDelete} disabled={p.busy}>
                {p.busy ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              {p.canEdit && (
                <button type="button" className="btn sm" onClick={p.onEdit} title="Full-page editor (⌘S saves)">
                  <Pencil size={13} aria-hidden="true" /> Edit
                </button>
              )}
              {!isMd && (
                <a className="btn sm" href={artifactRawUrl(a.id, { v: p.version, download: true })} download title="Save this version as a file">
                  <Download size={13} aria-hidden="true" /> Download
                </a>
              )}
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="btn sm icon ghost apMore" aria-label="More actions" title="More actions">
                    <MoreHorizontal size={15} aria-hidden="true" />
                  </button>
                </MenuTrigger>
                <MenuContent className="apMenu" align="end">
                  {/* these open on the Mac's screen: no use to a phone */}
                  {mac && (
                    <>
                      <MenuItem className="apMenuItem" disabled={p.busy} onSelect={() => p.onOpenOnMac('editor')}>
                        <ExternalLink size={14} aria-hidden="true" />
                        <span className="name">Open in editor</span>
                      </MenuItem>
                      {!isMd && (
                        <MenuItem className="apMenuItem" disabled={p.busy} onSelect={() => p.onOpenOnMac('default')}>
                          <ExternalLink size={14} aria-hidden="true" />
                          <span className="name">Open with the default app</span>
                        </MenuItem>
                      )}
                      <MenuItem className="apMenuItem" disabled={p.busy} onSelect={() => p.onOpenOnMac('reveal')}>
                        <FolderOpen size={14} aria-hidden="true" />
                        <span className="name">Reveal in Finder</span>
                      </MenuItem>
                      <MenuSeparator />
                    </>
                  )}
                  <MenuItem className="apMenuItem" onSelect={() => p.onCopy('mention')}>
                    <AtSign size={14} aria-hidden="true" />
                    <span className="name">Copy @mention for a chat</span>
                  </MenuItem>
                  {mac && (
                    <MenuItem className="apMenuItem" onSelect={() => p.onCopy('path')}>
                      <Copy size={14} aria-hidden="true" />
                      <span className="name">Copy path</span>
                    </MenuItem>
                  )}
                  {isMd && p.latest && (
                    <MenuItem className="apMenuItem" asChild>
                      <a href={artifactRawUrl(a.id, { v: p.version, download: true })} download>
                        <Download size={14} aria-hidden="true" />
                        <span className="name">Download</span>
                      </a>
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem className="apMenuItem apDanger" onSelect={p.onAskDelete}>
                    <Trash2 size={14} aria-hidden="true" />
                    <span className="name">Delete…</span>
                  </MenuItem>
                </MenuContent>
              </Menu>
            </>
          )}
        </div>
      </div>

      <div className="apMeta">
        <span className="apFmt">{formatLabel(a.format)}</span>
        {p.latest && <span>{fmtBytes(a.size)}</span>}
        {(p.newest > 1 || !p.latest) && (
          <span>
            v{p.version}
            {!p.latest && ` of ${p.newest}`}
          </span>
        )}
        <span>{a.author === 'model' ? 'Junior' : 'You'}</span>
        <time title={new Date(a.updated).toLocaleString()}>{artifactAgoLong(a.updated)}</time>
        {p.origin &&
          (p.originTitle ? (
            <button type="button" className="apFrom" onClick={() => p.onNavigate(p.origin!)} title="Open the session that published it">
              <MessagesSquare size={12} aria-hidden="true" />
              <span className="t">{p.originTitle}</span>
            </button>
          ) : (
            <span>from a deleted session</span>
          ))}
        {shown.map((o) => (
          <button
            key={`${o.kind}:${o.id}`}
            type="button"
            className="apFrom"
            onClick={() => p.onNavigate(o.kind === 'item' ? itemHash(o.id) : o.id)}
            title={o.kind === 'item' ? 'Open the work item' : 'Open the session'}
          >
            {o.kind === 'item' ? <Inbox size={12} aria-hidden="true" /> : <MessagesSquare size={12} aria-hidden="true" />}
            <span className="t">{o.kind === 'item' ? p.itemTitle(o.id) : (p.sessionTitle(o.id) ?? o.id.slice(0, 8))}</span>
          </button>
        ))}
        {more > 0 && <span>+{more} more</span>}
        {a.refs.map((r) => (
          <span key={r} className="apRef">
            {r}
          </span>
        ))}
        {a.warning && (
          <span className="apWarn" title={a.warning}>
            {isMd ? 'frontmatter did not parse' : 'its details file did not parse'}
          </span>
        )}
      </div>
    </header>
  )
}
