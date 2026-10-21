/**
 * The screenshots a browser tool call saved, right under the call. The
 * transcript keeps the bytes out of the event log, so they come from disk
 * (`[shot #n]` in the result names the file). Click one to see it full size.
 * A `browser_open` also says which profile it loaded in, and a switch reads
 * as its own line.
 */
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { BROWSER_SHOT_RE } from '../../../shared/protocol.js'
import { profileById, shotSrc, useBrowserProfiles } from '../browser.js'
import { ProfileDot } from './browser/ProfileMenu.js'
import type { TranscriptItem } from '../transcript.js'

type Shot = { key: string; n: number; caption: string }

const ONE_SHOT = /\[shot #\d+\]/

function shotsOf(tools: readonly TranscriptItem[]): Shot[] {
  return tools.flatMap((t) => {
    if (t.kind !== 'tool' || !t.name.startsWith('mcp__browser__') || !t.result || t.result.isError) return []
    const caption = t.result.text.split('\n').find((l) => ONE_SHOT.test(l)) ?? ''
    return [...t.result.text.matchAll(BROWSER_SHOT_RE)].map((m) => ({
      key: `${t.key}:${m[1]}`,
      n: Number(m[1]),
      caption: caption.replace(BROWSER_SHOT_RE, '').trim(),
    }))
  })
}

// What browser_open's result says (server/browser/mcp.ts): `… in the "Work" profile.`
const LOADED_IN = /in the "([^"\n]+)" profile\./
const SWITCHED = /Switched this session's browser to the "([^"\n]+)" profile\./

function profilesOf(tools: readonly TranscriptItem[]): { key: string; name: string; switched: boolean }[] {
  return tools.flatMap((t) => {
    if (t.kind !== 'tool' || t.name !== 'mcp__browser__browser_open' || !t.result || t.result.isError) return []
    const switched = SWITCHED.exec(t.result.text)
    const loaded = LOADED_IN.exec(t.result.text)
    const name = switched?.[1] ?? loaded?.[1]
    return name ? [{ key: t.key, name, switched: !!switched }] : []
  })
}

function ProfileChips({ tools }: { tools: readonly TranscriptItem[] }) {
  const named = profilesOf(tools)
  if (!named.length) return null
  return (
    <>
      {named.map((n) =>
        n.switched ? (
          <div key={n.key} className="bpSwitchNotice mono">
            Browser switched to {n.name}.
          </div>
        ) : (
          <ProfileChip key={n.key} name={n.name} />
        ),
      )}
    </>
  )
}

function ProfileChip({ name }: { name: string }) {
  const snap = useBrowserProfiles()
  const p = snap?.profiles.find((x) => x.name === name) ?? profileById(snap, name.toLowerCase())
  return (
    <div className="bpToolProfile" title={`Browser profile: ${name}`}>
      <ProfileDot profile={p} />
      {name}
    </div>
  )
}

export function BrowserShots({ sessionId, tools }: { sessionId: string; tools: readonly TranscriptItem[] }) {
  const shots = shotsOf(tools)
  const [open, setOpen] = useState<Shot | null>(null)
  const chips = <ProfileChips tools={tools} />
  if (!shots.length) return chips
  return (
    <>
      {chips}
      <div className="shotStrip">
        {shots.map((s) => (
          <button key={s.key} type="button" className="shotThumb" title={s.caption || `Shot #${s.n}`} onClick={() => setOpen(s)}>
            <img src={shotSrc(sessionId, s.n)} alt={s.caption || `Browser screenshot ${s.n}`} loading="lazy" />
            <span className="shotCap mono">#{s.n}{s.caption ? ` · ${s.caption}` : ''}</span>
          </button>
        ))}
      </div>
      <Dialog.Root open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="shotOverlay" />
          <Dialog.Content className="shotLightbox" aria-describedby={undefined}>
            <Dialog.Title className="shotLbTitle mono">{open ? `#${open.n}${open.caption ? ` · ${open.caption}` : ''}` : ''}</Dialog.Title>
            <Dialog.Close className="btn sm ghost icon shotLbClose" aria-label="Close">
              <X size={14} aria-hidden="true" />
            </Dialog.Close>
            {open && <img src={shotSrc(sessionId, open.n)} alt={open.caption || `Browser screenshot ${open.n}`} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
