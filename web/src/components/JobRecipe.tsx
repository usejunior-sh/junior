import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JobRecipeResponse } from '../../../shared/protocol.js'
import { useReturnFocus } from '../ui/returnFocus.js'
import { copiedText, wontParseText } from '../../../core/job/recipe-copy.js'

/** "Copying…" shows only once the fetch has taken this long. */
const SLOW_MS = 300
/** The copied line goes after this long. */
const CLEAR_MS = 6000

/** The job page's line under the head while copying a recipe. `edit` = offer "Edit the job". */
export type RecipeStatus = { kind: 'busy' | 'ok' | 'error'; text: string; edit?: boolean }

type Fetched = JobRecipeResponse & { status?: number }

/**
 * "Copy as recipe" on the job page (job-recipe-ui). The ⋯ menu's open
 * prefetches `GET /api/jobs/recipe`, so the copy itself is instant; a recipe
 * that won't parse is never copied, and a refused clipboard opens the
 * fallback dialog with the text to select by hand. `onGone` reloads the page
 * when the job was deleted under it.
 */
export function useJobRecipe(jobId: string, onGone: () => void) {
  const pending = useRef<Promise<Fetched> | null>(null)
  const [status, setStatus] = useState<RecipeStatus | null>(null)
  const [fallback, setFallback] = useState<string | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(clearTimer.current), [])

  const prefetch = useCallback(() => {
    pending.current = fetch(`/api/jobs/recipe?id=${encodeURIComponent(jobId)}`)
      .then(async (r) => ({ ...((await r.json()) as JobRecipeResponse), status: r.status }))
      .catch((err: unknown): Fetched => ({ ok: false, error: String(err) }))
  }, [jobId])

  const clear = useCallback(() => {
    clearTimeout(clearTimer.current)
    setStatus(null)
  }, [])

  const copy = useCallback(async () => {
    clear()
    if (!pending.current) prefetch()
    const req = pending.current!
    // the next copy reads the file again: an edit since then shows
    pending.current = null
    const slow = setTimeout(() => setStatus({ kind: 'busy', text: 'Copying…' }), SLOW_MS)
    const b = await req
    clearTimeout(slow)
    if (!b.ok) {
      if (b.status === 404) {
        setStatus(null)
        onGone()
      } else setStatus({ kind: 'error', text: b.error })
      return
    }
    if (b.errors.length) {
      setStatus({ kind: 'error', text: wontParseText(b.errors), edit: true })
      return
    }
    try {
      await navigator.clipboard.writeText(b.text)
      setStatus({ kind: 'ok', text: copiedText(b.scrubbed) })
      clearTimer.current = setTimeout(() => setStatus(null), CLEAR_MS)
    } catch {
      setStatus(null)
      setFallback(b.text)
    }
  }, [clear, prefetch, onGone])

  return { status, prefetch, copy, clear, fallback, closeFallback: () => setFallback(null) }
}

/** The clipboard said no: the recipe, preselected in a read-only box, to copy by hand. */
export function RecipeFallbackDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  const box = useRef<HTMLTextAreaElement>(null)
  const returnFocus = useReturnFocus(text !== null)
  return (
    <Dialog.Root open={text !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content
          className="uiDialog projModal projAddDialog recipeDialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            box.current?.focus()
            box.current?.select()
          }}
          onCloseAutoFocus={returnFocus}
        >
          <Dialog.Title asChild>
            <h3>Copy this recipe</h3>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="wsIntro">Junior couldn't reach the clipboard. Select the text and copy it.</p>
          </Dialog.Description>
          <textarea ref={box} readOnly value={text ?? ''} aria-label="Job recipe" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
          <div className="row">
            <Dialog.Close asChild>
              <button type="button" className="go">
                Done
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
