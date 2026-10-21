import { ArrowLeft, ChevronRight, LogIn, MoreHorizontal, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { BROWSER_PROFILE_COLORS, DEFAULT_PROFILE, findProfile, profileNameError, signinTabKey } from '../../../../core/browser/profiles.js'
import type { BrowserProfile, BrowserProfileColor, JobsResponse } from '../../../../shared/protocol.js'
import { spanText } from '../../actions.js'
import {
  PROFILE_COLOR_VAR,
  clearProfile,
  createProfile,
  deleteProfile,
  hasBrowser,
  profileSites,
  setDefaultProfile,
  takeDraftIntent,
  updateProfile,
  useBrowserProfiles,
  useBrowserProfilesError,
} from '../../browser.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../../ui/Menu.js'
import { Tooltip } from '../../ui/Tooltip.js'
import { BrowserPane } from '../BrowserPane.js'
import { ConfirmDialog } from '../browser/ConfirmDialog.js'
import { ProfileDot } from '../browser/ProfileMenu.js'
import { Loading, Section } from './shared.js'

// Settings → Browser (.docs/browser.md → Profiles): the machine's profiles,
// each its own cookie jar. You sign in to sites here, once, in a profile's
// sign-in tab; Junior uses whichever profile you name in a chat or a job.

const OUTSIDE_APP = 'Open Triage.app to sign in.'
const DEFAULT_HINT = "This workspace's default. Junior uses it unless you name another."

/** The id says nothing the name doesn't when it is just the name, slugged: show it only when it differs. */
const idIsName = (p: BrowserProfile) => p.id === p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

type Confirm = { kind: 'delete' | 'signout'; profile: BrowserProfile }

export function BrowserTab() {
  const snap = useBrowserProfiles()
  const loadError = useBrowserProfilesError()
  const [draft, setDraft] = useState(takeDraftIntent)
  const [signingIn, setSigningIn] = useState<string | null>(null)
  const [justMade, setJustMade] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sites, setSites] = useState<Record<string, string[]>>({})
  const connected = !!snap?.app.connected

  // Sites come from the jars, which are Triage.app's: read them while it's there.
  const ids = snap?.profiles.map((p) => p.id).join(',') ?? ''
  const [sitesNonce, setSitesNonce] = useState(0)
  useEffect(() => {
    if (!connected || !ids || signingIn) return
    let live = true
    for (const id of ids.split(',')) {
      void profileSites(id).then((b) => {
        if (live) setSites((s) => ({ ...s, [id]: b.ok ? b.sites.map((x) => x.site) : [] }))
      })
    }
    return () => {
      live = false
    }
  }, [connected, ids, signingIn, sitesNonce])

  if (!snap) {
    if (!loadError) return <Loading />
    // An older daemon answers the route with the app's HTML, not JSON.
    return /JSON|Unexpected token/.test(loadError) ? (
      <div className="msg">Restart the triage server to manage profiles. It is running an older build.</div>
    ) : (
      <div className="msg error">Couldn't load profiles: {loadError}</div>
    )
  }

  const signing = signingIn ? snap.profiles.find((p) => p.id === signingIn) ?? null : null
  if (signing) {
    return (
      <div className="bpSignin">
        <div className="bpSigninHead">
          <button type="button" className="btn sm ghost" onClick={() => setSigningIn(null)}>
            <ArrowLeft size={13} aria-hidden="true" />
            Profiles
          </button>
          <ProfileDot profile={signing} />
          <span className="t">Sign in to sites in {signing.name}</span>
        </div>
        <BrowserPane key={signing.id} tabKey={signinTabKey(signing.id)} onClose={() => setSigningIn(null)} />
      </div>
    )
  }

  const startSignin = (id: string) => {
    setJustMade(null)
    setSigningIn(id)
  }

  return (
    <>
      <Section title="Profiles" hint="Each profile has its own cookies. Sign in once and it stays signed in. Every workspace on this Mac shares them.">
        {!hasBrowser ? (
          <div className="msg bpProfMsg">{OUTSIDE_APP} Sites are from the last time it was open.</div>
        ) : !connected ? (
          <div className="msg bpProfMsg">Triage.app isn't open. Sites are from the last time it was.</div>
        ) : null}
        <div className="bpProfiles" role="table" aria-label="Browser profiles">
          <div className="bpProfRow head" role="row">
            <span role="columnheader" aria-label="Colour" />
            <span role="columnheader">profile</span>
            <Tooltip content="Sites with saved cookies. You're usually signed in to these." side="top">
              <span role="columnheader" tabIndex={0}>
                sites
              </span>
            </Tooltip>
            <span role="columnheader">last used</span>
            <span role="columnheader" aria-label="Actions" />
          </div>
          {snap.profiles.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              list={snap.profiles}
              isDefault={p.id === snap.workspaceDefault}
              sites={connected ? sites[p.id] ?? p.sites ?? null : p.sites ?? null}
              sitesAt={connected ? null : p.sitesAt ?? null}
              connected={connected}
              justMade={justMade === p.id}
              onSignin={() => startSignin(p.id)}
              onConfirm={(kind) => setConfirm({ kind, profile: p })}
              onError={setError}
            />
          ))}
          {draft ? (
            <DraftRow
              list={snap.profiles}
              onCancel={() => setDraft(false)}
              onMade={(p) => {
                setDraft(false)
                setJustMade(p.id)
              }}
            />
          ) : (
            <button type="button" className="btn ghost sm bpNewProfile" onClick={() => setDraft(true)}>
              <Plus size={13} aria-hidden="true" />
              New profile
            </button>
          )}
        </div>
        {error && <div className="msg error">{error}</div>}
      </Section>
      <ProfileConfirm
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onDone={(err) => {
          setError(err)
          setSitesNonce((n) => n + 1)
        }}
      />
    </>
  )
}

function ProfileRow({
  profile: p,
  list,
  isDefault,
  sites,
  sitesAt,
  connected,
  justMade,
  onSignin,
  onConfirm,
  onError,
}: {
  profile: BrowserProfile
  list: BrowserProfile[]
  isDefault: boolean
  /** null = never read from the app */
  sites: string[] | null
  /** when a cached list was read (the app is closed now) */
  sitesAt: number | null
  connected: boolean
  justMade: boolean
  onSignin: () => void
  onConfirm: (kind: Confirm['kind']) => void
  onError: (e: string | null) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const save = async (patch: { name?: string; color?: BrowserProfileColor }) => {
    onError(null)
    const b = await updateProfile(p.id, patch)
    if (!b.ok) onError(b.error)
    return b.ok
  }
  const signinBtn = (
    <button type="button" className="btn sm ghost" disabled={!hasBrowser} onClick={onSignin}>
      <LogIn size={13} aria-hidden="true" />
      Sign in to a site
    </button>
  )
  return (
    <>
      <div className="bpProfRow" role="row">
        <span role="cell">
          <ProfileDot profile={p} size={10} />
        </span>
        <span role="cell" className="nm">
          {renaming ? (
            <RenameInput profile={p} list={list} onDone={() => setRenaming(false)} onSave={(name) => save({ name })} />
          ) : (
            <b>
              {p.name}
              {isDefault && (
                <Tooltip content={DEFAULT_HINT} side="top">
                  <span className="projDefault bpDefaultStar" role="img" aria-label={DEFAULT_HINT} tabIndex={0}>
                    ★
                  </span>
                </Tooltip>
              )}
            </b>
          )}
          {!idIsName(p) && (
            <small className="mono" title="The id job files can use">
              {p.id}
            </small>
          )}
        </span>
        <span role="cell" className="bpSiteChips" title={sitesAt ? `As of ${spanText(Date.now() - sitesAt)} ago, when Triage.app was last open` : undefined}>
          {sites === null ? (
            <span className="none">{connected ? '…' : 'Open Triage.app to see sites'}</span>
          ) : sites.length === 0 ? (
            <span className="none">No sites yet</span>
          ) : (
            <>
              {sites.slice(0, 3).map((s) => (
                <span key={s} className="bpSiteChip mono">
                  {s}
                </span>
              ))}
              {sites.length > 3 && <span className="bpSiteChip more mono">+{sites.length - 3}</span>}
            </>
          )}
        </span>
        <span role="cell" className="when mono">
          {p.lastUsedAt ? `${spanText(Date.now() - p.lastUsedAt)} ago` : 'never'}
        </span>
        <span role="cell" className="acts">
          {hasBrowser ? (
            signinBtn
          ) : (
            <Tooltip content={OUTSIDE_APP} side="top" align="end">
              <span>{signinBtn}</span>
            </Tooltip>
          )}
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className="btn sm ghost icon" aria-label={`More for ${p.name}`}>
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent align="end" className="bpProfRowMenu" onCloseAutoFocus={(e) => e.preventDefault()}>
              <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
              <MenuSub>
                <MenuSubTrigger>
                  <span className="bpVpLabel">Colour</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </MenuSubTrigger>
                <MenuSubContent className="bpSwatchMenu">
                  {BROWSER_PROFILE_COLORS.map((c) => (
                    <MenuItem key={c} onSelect={() => void save({ color: c })} aria-label={c}>
                      <span className={`bpSwatch${c === p.color ? ' on' : ''}`} style={{ background: PROFILE_COLOR_VAR[c] }} aria-hidden="true" />
                      <span className="cap">{c}</span>
                    </MenuItem>
                  ))}
                </MenuSubContent>
              </MenuSub>
              <MenuItem
                disabled={isDefault}
                onSelect={() =>
                  void setDefaultProfile(p.id).then((b) => {
                    if (!b.ok) onError(b.error)
                  })
                }
              >
                Make this workspace's default
              </MenuItem>
              <MenuSeparator />
              <MenuItem disabled={!connected} onSelect={() => onConfirm('signout')}>
                Sign out of all sites
              </MenuItem>
              <MenuItem className="danger" disabled={p.id === DEFAULT_PROFILE} onSelect={() => onConfirm('delete')}>
                Delete profile
              </MenuItem>
              {p.id === DEFAULT_PROFILE && <div className="bpMenuNote">Default always stays. Rename it, or sign out of it.</div>}
            </MenuContent>
          </Menu>
        </span>
      </div>
      {justMade && (
        <div className="bpProfNudge">
          <span>Sign in to the sites Junior should use.</span>
          {signinBtn}
        </div>
      )}
    </>
  )
}

/** Rename in place: Enter saves, Esc puts the name back. */
function RenameInput({ profile, list, onSave, onDone }: { profile: BrowserProfile; list: BrowserProfile[]; onSave: (name: string) => Promise<boolean>; onDone: () => void }) {
  const [name, setName] = useState(profile.name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const err = name.trim() === profile.name ? null : profileNameError(name, list, profile.id)
  const commit = async () => {
    if (name.trim() === profile.name) return onDone()
    if (err) return
    if (await onSave(name.trim())) onDone()
  }
  return (
    <input
      ref={ref}
      className="bpProfInput"
      value={name}
      aria-label="Profile name"
      aria-invalid={!!err}
      title={err ?? undefined}
      maxLength={40}
      onChange={(e) => setName(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onDone()
        }
      }}
    />
  )
}

/** New profile: a row to name, a colour, Create. The id is made from the name by the daemon. */
function DraftRow({ list, onCancel, onMade }: { list: BrowserProfile[]; onCancel: () => void; onMade: (p: BrowserProfile) => void }) {
  const used = new Set(list.map((p) => p.color))
  const [name, setName] = useState('')
  const [color, setColor] = useState<BrowserProfileColor>(BROWSER_PROFILE_COLORS.find((c) => !used.has(c)) ?? 'blue')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameErr = name.trim() ? profileNameError(name, list) : null

  const create = async () => {
    if (!name.trim() || nameErr) return
    setBusy(true)
    setError(null)
    const b = await createProfile({ name: name.trim(), color })
    setBusy(false)
    if (b.ok) onMade(b.profile)
    else setError(b.error)
  }

  return (
    <div className="bpProfDraft">
      <ProfileDot profile={{ color }} size={10} />
      <input
        autoFocus
        className="bpProfInput"
        value={name}
        placeholder="Profile name, like Test user"
        aria-label="Profile name"
        aria-invalid={!!nameErr}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void create()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="bpSwatches" role="radiogroup" aria-label="Colour">
        {BROWSER_PROFILE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === color}
            aria-label={c}
            className={`bpSwatch${c === color ? ' on' : ''}`}
            style={{ background: PROFILE_COLOR_VAR[c] }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <button type="button" className="btn primary sm" disabled={busy || !name.trim() || !!nameErr} onClick={() => void create()}>
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button type="button" className="btn sm ghost" onClick={onCancel}>
        Cancel
      </button>
      {(nameErr || error) && <div className="bpProfDraftErr">{nameErr ?? error}</div>}
    </div>
  )
}

/** Delete and Sign out wipe a jar: both ask first. A delete names this workspace's jobs that will pause. */
function ProfileConfirm({ confirm, onClose, onDone }: { confirm: Confirm | null; onClose: () => void; onDone: (error: string | null) => void }) {
  const [jobs, setJobs] = useState<string[]>([])
  const name = confirm?.profile.name ?? ''
  const del = confirm?.kind === 'delete'

  // A job names its profile by id or by name, as its file spells it.
  const target = del ? confirm.profile : null
  useEffect(() => {
    setJobs([])
    if (!target) return
    let live = true
    void fetch('/api/jobs')
      .then((r) => r.json() as Promise<JobsResponse>)
      .then((b) => {
        if (!live || !b.ok) return
        setJobs(b.jobs.filter((j) => j.browser && findProfile([target], j.browser.profile)).map((j) => j.title))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [target])

  return (
    <ConfirmDialog
      open={confirm !== null}
      title={del ? `Delete the ${name} profile?` : `Sign out of every site in ${name}?`}
      body={
        <>
          <p>{del ? 'This signs you out of every site in it. Jobs that use it will pause.' : 'Junior and you will need to sign in again.'}</p>
          {del && jobs.length > 0 && (
            <ul className="bpConfirmJobs" aria-label="Jobs that will pause">
              {jobs.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </>
      }
      confirm={del ? 'Delete profile' : 'Sign out'}
      danger={del}
      onConfirm={async () => {
        if (!confirm) return
        const b = del ? await deleteProfile(confirm.profile.id) : await clearProfile(confirm.profile.id)
        onDone(b.ok ? null : b.error)
      }}
      onClose={onClose}
    />
  )
}
