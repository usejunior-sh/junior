/**
 * In place of the composer, for a session whose worktree was removed: it has
 * no folder to run in. Two ways on (.docs/worktrees-ux.html §0, "Removed is
 * history"): bring the worktree back at the same folder — Claude Code keys a
 * transcript by folder, so only that resumes this conversation — or start a
 * new session in the main folder that points back at this one.
 */
import { FolderX, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { Checkout, OpenCheckoutResponse } from '../../../shared/protocol.js'
import { checkoutLabel } from '../checkouts.js'

type Props = {
  checkout: Checkout
  /** start a new session in the project's main folder, carrying this one as context */
  onContinueInMain: () => void
}

export function GoneCheckoutBar({ checkout, onContinueInMain }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function recreate() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/checkouts/${encodeURIComponent(checkout.id)}/recreate`, { method: 'POST' })
      const b = (await res.json()) as OpenCheckoutResponse
      // Success needs nothing here: the checkouts broadcast marks it active and the composer returns.
      if (!b.ok) setError(b.error)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div id="composer">
      <div className="frame card goneBar" role="status">
        <p className="d">
          <FolderX size={14} className="ic" aria-hidden="true" />
          <span>
            <span className="br">{checkoutLabel(checkout)}</span> was removed — this session has no folder to run in.
          </span>
        </p>
        <div className="acts">
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            title="A new session in the project's main folder, with this one attached for context"
            onClick={onContinueInMain}
          >
            Continue in main folder
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy}
            title="Bring the worktree back at the same folder and pick this conversation up where it left off"
            onClick={() => void recreate()}
          >
            {busy && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
            {busy ? 'Recreating…' : 'Recreate worktree'}
          </button>
        </div>
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  )
}
