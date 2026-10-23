/**
 * The pane's address field. At rest it reads like Chrome's: a mark for what
 * kind of page it is, the host in ink, the path in ash, the query folded
 * away. Focused, it is the full URL, selected; Enter goes, Esc puts it back.
 */
import { useEffect, useImperativeHandle, useRef, useState, type FormEvent, type Ref } from 'react'
import { Laptop, Lock, TriangleAlert } from 'lucide-react'
import { addressParts, completeUrl } from '../../browserUrl.js'

export type AddressFieldHandle = { focus: () => void }

export function AddressField({
  url,
  onGo,
  ref,
}: {
  url: string
  onGo: (url: string) => void
  ref?: Ref<AddressFieldHandle>
}) {
  const input = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(url)

  useEffect(() => {
    if (!editing) setText(url)
  }, [url, editing])

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), [])

  const go = (e: FormEvent) => {
    e.preventDefault()
    const raw = text.trim()
    if (!raw) return
    setEditing(false)
    input.current?.blur()
    onGo(completeUrl(raw))
  }

  const parts = addressParts(url)
  const atRest = !editing && parts !== null

  return (
    // A URL is no edit of yours to lose on a reload (reloadGuard.ts).
    <form className={`bpUrl${editing ? ' on' : ''}`} onSubmit={go} data-reload-exempt="">
      {atRest && (
        <button type="button" className="bpUrlRest mono" tabIndex={-1} aria-hidden="true" onMouseDown={(e) => e.preventDefault()} onClick={() => input.current?.focus()}>
          {parts.mark === 'secure' && <Lock size={12} className="bpMark" aria-hidden="true" />}
          {/* the words fold away on a narrow pane; the icon keeps them as its tooltip */}
          {parts.mark === 'local' && (
            <span className="bpMark" title="On this Mac">
              <Laptop size={12} aria-hidden="true" />
              <span className="t">local</span>
            </span>
          )}
          {parts.mark === 'insecure' && (
            <span className="bpMark warn" title="Not secure: this page isn't encrypted.">
              <TriangleAlert size={12} aria-hidden="true" />
              <span className="t">Not secure</span>
            </span>
          )}
          <span className="bpHost">{parts.host}</span>
          <span className="bpPath">
            {parts.path}
            {parts.query ? '…' : ''}
          </span>
        </button>
      )}
      <input
        ref={input}
        className={`mono${atRest ? ' rest' : ''}`}
        value={text}
        placeholder="Type a URL"
        spellCheck={false}
        autoComplete="off"
        aria-label="Address"
        onFocus={(e) => {
          setEditing(true)
          setText(url)
          const el = e.currentTarget
          requestAnimationFrame(() => el.select())
        }}
        onBlur={() => setEditing(false)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            setText(url)
            e.currentTarget.blur()
          }
        }}
      />
    </form>
  )
}
