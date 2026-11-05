/**
 * What the stage shows when there's no page on it: nothing opened yet, a page
 * that didn't load, or a tab coming back. Drawn by us, in the stage, with the
 * native view hidden, so a dead dev server reads as ours, not Chromium's.
 */
import { Globe, RotateCw } from 'lucide-react'
import { useState } from 'react'
import type { BrowserProfile } from '../../../../shared/protocol.js'
import { pageErrorView, shortUrl } from '../../browserUrl.js'

/**
 * Ports a local dev server usually listens on (Vite, Next, Astro, Angular, Rails,
 * Django, plain http servers). Junior's own (5178, 5188, 5189) are left out:
 * opening Junior inside itself is never what you meant. So is 5000: on a Mac
 * that's usually AirPlay, which answers too.
 */
export const DEV_PORTS = [5173, 5174, 3000, 3001, 4321, 4200, 8080, 8000, 3030] as const

/**
 * The first port that answers on localhost, or null. A no-cors request
 * resolves on any answer and rejects on a refused connection, which is all
 * we need to know; each try gives up after a short wait.
 */
async function findDevServer(): Promise<string | null> {
  const probe = (port: number) =>
    new Promise<string | null>((resolve) => {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 800)
      fetch(`http://localhost:${port}/`, { mode: 'no-cors', signal: ctl.signal })
        .then(() => resolve(`http://localhost:${port}`))
        .catch(() => resolve(null))
        .finally(() => clearTimeout(t))
    })
  const found = await Promise.all(DEV_PORTS.map(probe))
  return found.find(Boolean) ?? null
}

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
  const [detect, setDetect] = useState<'idle' | 'looking' | 'none'>('idle')
  const detectServer = async () => {
    setDetect('looking')
    const url = await findDevServer()
    if (url) onOpen(url)
    setDetect(url ? 'idle' : 'none')
  }
  return (
    <div className="bpEmpty">
      <Globe size={22} className="bpGlobe" aria-hidden="true" />
      <p className="bpLead">{signin ? 'Sign in here' : 'Browse with Junior'}</p>
      <p>
        {signin
          ? 'Type a URL above and sign in. Junior uses these logins when you name this profile.'
          : 'Type a URL, or ask Junior to open a site. Junior can read, click and type.'}
      </p>
      {!signin && (
        <p className="bpDetect">
          {detect === 'none' ? 'No dev server answered on the usual ports.' : 'Preview your app instead?'}{' '}
          <button type="button" className="bpLink" disabled={detect === 'looking'} onClick={() => void detectServer()}>
            {detect === 'looking' ? 'Looking…' : detect === 'none' ? 'Try again' : 'Detect dev server'}
          </button>
        </p>
      )}
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
