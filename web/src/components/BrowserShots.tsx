/**
 * The screenshots a browser tool call saved, right under the call — the
 * transcript keeps the bytes out of the event log, so they come from disk
 * (`[shot #n]` in the result names the file). Click one to see it full size.
 */
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { BROWSER_SHOT_RE } from '../../../shared/protocol.js'
import { shotSrc } from '../browser.js'
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

export function BrowserShots({ sessionId, tools }: { sessionId: string; tools: readonly TranscriptItem[] }) {
  const shots = shotsOf(tools)
  const [open, setOpen] = useState<Shot | null>(null)
  if (!shots.length) return null
  return (
    <>
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
