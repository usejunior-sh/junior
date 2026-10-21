/**
 * What the stage shows when there's no page on it: nothing opened yet, a page
 * that didn't load, or a tab coming back. Drawn by us, in the stage, with the
 * native view hidden, so a dead dev server reads as ours, not Chromium's.
 */
import { Globe, RotateCw } from 'lucide-react'
import type { BrowserProfile } from '../../../../shared/protocol.js'
import { pageErrorView, shortUrl } from '../../browserUrl.js'

export function EmptyState({
  profile,
  lastUrl,
  sites,
  signin,
  onOpen,
}: {
  profile: BrowserProfile | null
  /** the tab's remembered page, to reopen */
  lastUrl: string | null
  /** sites the profile holds logins for */
  sites: string[]
  /** a profile's sign-in tab, not a chat's */
  signin: boolean
  onOpen: (url: string) => void
}) {
  return (
    <div className="bpEmpty">
      <p className="bpLead">Open a page</p>
      <p>
        {signin
          ? 'Type a URL above and sign in. Junior uses these logins when you name this profile.'
          : 'Type a URL above, or pick one below. Junior opens pages here when it checks its work.'}
      </p>
      {lastUrl && (
        <button type="button" className="btn ghost bpReopen" onClick={() => onOpen(lastUrl)}>
          <RotateCw size={13} aria-hidden="true" />
          <span>Reopen</span>
          <span className="mono h">{shortUrl(lastUrl)}</span>
        </button>
      )}
      {sites.length > 0 && (
        <>
          <div className="bpGroup">{`Sites in ${profile?.name ?? 'this profile'}`}</div>
          <ul className="bpSites">
            {sites.slice(0, 5).map((s) => (
              <li key={s}>
                <button type="button" className="bpSiteRow" onClick={() => onOpen(`https://${s}`)}>
                  <Globe size={13} aria-hidden="true" />
                  <span className="mono">{s}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export function ErrorState({
  code,
  url,
  onReload,
  onEdit,
  onTerminal,
  onAskJunior,
}: {
  code: string
  url: string
  onReload: () => void
  onEdit: () => void
  /** a chat's pane only: open a terminal in its project, to start the server */
  onTerminal?: () => void
  /** a chat's pane only: draft "start the dev server" into its composer */
  onAskJunior?: () => void
}) {
  const v = pageErrorView(code, url)
  const edit = v.kind === 'dns' || v.kind === 'cert'
  // An address reads poorly in the display serif: it is set in mono inside the lead.
  const at = v.host ? v.lead.indexOf(v.host) : -1
  return (
    <div className="bpEmpty" role="alert">
      <p className="bpLead">
        {at < 0 ? (
          v.lead
        ) : (
          <>
            {v.lead.slice(0, at)}
            <span className="mono">{v.host}</span>
            {v.lead.slice(at + v.host.length)}
          </>
        )}
      </p>
      {v.line && <p>{v.line}</p>}
      {v.kind !== 'blocked' && (
        <div className="bpBtns">
          {edit ? (
            <button type="button" className="btn sm" onClick={onEdit}>
              Edit address
            </button>
          ) : (
            <button type="button" className="btn sm" onClick={onReload}>
              Reload
            </button>
          )}
          {v.kind === 'refused-local' && onTerminal && (
            <button type="button" className="btn sm" onClick={onTerminal}>
              Open a terminal
            </button>
          )}
          {v.kind === 'refused-local' && onAskJunior && (
            <button type="button" className="btn sm ghost" onClick={onAskJunior}>
              Ask Junior to start it
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** A page on its way: a revived tab ("Reopening …") or a first load ("Opening …"). */
export function RevivingState({ url, verb = 'Reopening' }: { url: string; verb?: 'Reopening' | 'Opening' }) {
  return (
    <div className="bpEmpty">
      <p className="bpWait mono">
        {verb} {verb === 'Opening' ? hostOf(url) : shortUrl(url)}…
      </p>
    </div>
  )
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
