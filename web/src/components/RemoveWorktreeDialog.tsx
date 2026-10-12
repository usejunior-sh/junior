import * as Checkbox from '@radix-ui/react-checkbox'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, CircleAlert, CircleCheck, CircleX, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Checkout, RemovalCheck, RemovalCheckResponse, RemoveCheckoutResponse } from '../../../shared/protocol.js'
import { changesStore } from '../changesStore.js'
import { checkoutLabel } from '../checkouts.js'

// ---------------------------------------------------------------------------
// Remove a worktree without losing work (.docs/worktrees-ux.html §10). The
// checks come first: merged into the default branch, nothing uncommitted,
// nothing running. All clear → "Remove worktree" is the primary button.
// Anything at risk → "Keep it" is, and removing anyway is red and set apart.
// ---------------------------------------------------------------------------

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function RemoveWorktreeDialog({ checkout, onClose }: { checkout: Checkout | null; onClose: () => void }) {
  const [check, setCheck] = useState<RemovalCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(true)

  useEffect(() => {
    if (!checkout) return
    setCheck(null)
    setError(null)
    setDeleteBranch(true)
    let live = true
    void fetch(`/api/checkouts/${encodeURIComponent(checkout.id)}/removal`)
      .then((r) => r.json() as Promise<RemovalCheckResponse>)
      .then((b) => {
        if (!live) return
        if (b.ok) setCheck(b.check)
        else setError(b.error)
      })
      .catch((err: unknown) => live && setError(String(err)))
    return () => {
      live = false
    }
  }, [checkout])

  async function remove(force: boolean) {
    if (!checkout) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/checkouts/${encodeURIComponent(checkout.id)}/remove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force, deleteBranch }),
      })
      const b = (await res.json()) as RemoveCheckoutResponse
      if (b.ok) {
        void changesStore.refresh()
        onClose()
      } else {
        setError(b.error)
        if (b.check) setCheck(b.check)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const name = checkout ? checkoutLabel(checkout) : ''
  const base = check?.base ?? 'the default branch'
  const safe = check?.safe ?? false

  return (
    <Dialog.Root open={checkout !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content asChild>
          <dialog open className="projModal projAddDialog rmWorktree">
            <Dialog.Title asChild>
              <h3>{!check || safe ? `Remove ${name}?` : `${name} has work that would be lost`}</h3>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p className="wsIntro">
                {!check
                  ? 'Checking what this worktree holds…'
                  : safe
                    ? 'Nothing here would be lost. The folder goes; its sessions keep their transcripts.'
                    : 'Removing it deletes what is listed below. Its sessions keep their transcripts.'}
              </p>
            </Dialog.Description>
            {check && (
              <ul className="rmChecks">
                <li>
                  {check.unmerged === 0 ? (
                    <CircleCheck size={14} className="ok" aria-hidden="true" />
                  ) : check.unmerged === null ? (
                    <CircleAlert size={14} className="warn" aria-hidden="true" />
                  ) : (
                    <CircleX size={14} className="bad" aria-hidden="true" />
                  )}
                  <span>
                    {check.unmerged === 0
                      ? `Everything is in ${base}`
                      : check.unmerged === null
                        ? `Couldn't compare with ${base}`
                        : `${plural(check.unmerged, 'commit')} not in ${base}`}
                  </span>
                </li>
                <li>
                  {check.uncommitted === 0 ? (
                    <CircleCheck size={14} className="ok" aria-hidden="true" />
                  ) : (
                    <CircleAlert size={14} className="warn" aria-hidden="true" />
                  )}
                  <span>{check.uncommitted === 0 ? 'No uncommitted changes' : `${plural(check.uncommitted, 'uncommitted file')}`}</span>
                </li>
                <li>
                  {check.running === 0 ? (
                    <CircleCheck size={14} className="ok" aria-hidden="true" />
                  ) : (
                    <CircleAlert size={14} className="warn" aria-hidden="true" />
                  )}
                  <span>{check.running === 0 ? 'Nothing running in it' : `${plural(check.running, 'session')} working there — stopped`}</span>
                </li>
              </ul>
            )}
            {checkout?.branch && (
              <label className="checkLine">
                <Checkbox.Root className="cbox" checked={deleteBranch} onCheckedChange={(v) => setDeleteBranch(v === true)}>
                  <Checkbox.Indicator>
                    <Check size={10} aria-hidden="true" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                Delete the local branch <code>{checkout.branch}</code>
              </label>
            )}
            {error && <p className="projError">{error}</p>}
            <div className="row">
              {check && !safe && (
                <button type="button" className="danger" disabled={busy} onClick={() => void remove(true)}>
                  <Trash2 size={12} aria-hidden="true" /> Remove anyway
                </button>
              )}
              {safe ? (
                <>
                  <Dialog.Close asChild>
                    <button type="button" className="cancel" disabled={busy}>
                      Keep it
                    </button>
                  </Dialog.Close>
                  <button type="button" className="go" disabled={busy} onClick={() => void remove(false)}>
                    {busy ? 'Removing…' : 'Remove worktree'}
                  </button>
                </>
              ) : (
                <Dialog.Close asChild>
                  <button type="button" className="go" disabled={busy}>
                    Keep it
                  </button>
                </Dialog.Close>
              )}
            </div>
          </dialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
