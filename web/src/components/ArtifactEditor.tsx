/**
 * The artifact editor: the whole content area, for writing at length. A modal
 * is the wrong shape for that. It fights the page for height, a stray Escape
 * loses the text, and there is no room to see what the markdown renders as.
 *
 * One component for creating and editing. Three layouts (write · split ·
 * preview), a live preview rendered by the same Markdown component sessions
 * use, ⌘S to save, and an unsaved draft parked in localStorage so a reload,
 * a tab switch or a crash never costs the text. Heavy editing can still
 * happen in the user's own editor; this is for the notes you write here.
 */
import { Columns2, Eye, PenLine } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown.js'

type Layout = 'write' | 'split' | 'preview'

type Props = {
  /** the artifact id, or 'new', keys the parked draft */
  draftKey: string
  initialTitle: string
  initialBody: string
  /** what the page shows above the editor: "New note" or the file path */
  crumb: string
  saveLabel: string
  onSave: (title: string, body: string) => Promise<string | null>
  onCancel: () => void
}

const LAYOUT_KEY = 'junior.artifactEditor.layout'
const draftKeyFor = (k: string) => `junior.artifactDraft.${k}`

function readLayout(): Layout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY)
    return v === 'write' || v === 'split' || v === 'preview' ? v : 'split'
  } catch {
    return 'split'
  }
}

function readDraft(key: string): { title: string; body: string } | null {
  try {
    const raw = localStorage.getItem(draftKeyFor(key))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && typeof (parsed as { body?: unknown }).body === 'string') {
      const d = parsed as { title?: unknown; body: string }
      return { title: typeof d.title === 'string' ? d.title : '', body: d.body }
    }
  } catch {
    // blocked storage: the editor still works for this page load
  }
  return null
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)

export function ArtifactEditor({ draftKey, initialTitle, initialBody, crumb, saveLabel, onSave, onCancel }: Props) {
  // A parked draft wins over what the file says. It is the newer keystrokes.
  const parked = useMemo(() => readDraft(draftKey), [draftKey])
  const [title, setTitle] = useState(parked?.title || initialTitle)
  const [body, setBody] = useState(parked?.body ?? initialBody)
  const [layout, setLayout] = useState<Layout>(readLayout)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restored, setRestored] = useState(parked !== null && (parked.body !== initialBody || parked.title !== initialTitle))
  const area = useRef<HTMLTextAreaElement>(null)

  const dirty = title !== initialTitle || body !== initialBody

  // Park every keystroke (debounced) so nothing is lost; clear once saved or discarded.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        if (dirty) localStorage.setItem(draftKeyFor(draftKey), JSON.stringify({ title, body }))
        else localStorage.removeItem(draftKeyFor(draftKey))
      } catch {
        // storage blocked
      }
    }, 300)
    return () => window.clearTimeout(t)
  }, [draftKey, title, body, dirty])

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout)
    } catch {
      // storage blocked
    }
  }, [layout])

  // Land in the body when the title is already there; in the title when it is not.
  useEffect(() => {
    const el = initialTitle || parked?.title ? area.current : document.querySelector<HTMLInputElement>('.artEditTitle')
    el?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = useCallback(async () => {
    if (saving) return
    if (!title.trim()) {
      setError('Give it a title.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const err = await onSave(title.trim(), body)
      if (err) setError(err)
      else {
        try {
          localStorage.removeItem(draftKeyFor(draftKey))
        } catch {
          // storage blocked
        }
      }
    } finally {
      setSaving(false)
    }
  }, [saving, title, body, onSave, draftKey])

  const cancel = useCallback(() => {
    try {
      localStorage.removeItem(draftKeyFor(draftKey))
    } catch {
      // storage blocked
    }
    onCancel()
  }, [draftKey, onCancel])

  // ⌘S saves from anywhere in the editor; Escape leaves only when nothing would be lost.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      } else if (e.key === 'Escape' && !dirty) {
        e.preventDefault()
        cancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [save, cancel, dirty])

  // Tab indents inside the body instead of leaving the box. It is a text editor, briefly.
  function onBodyKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Tab' || e.shiftKey) return
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart: s, selectionEnd: en } = el
    const next = body.slice(0, s) + '  ' + body.slice(en)
    setBody(next)
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
  }

  return (
    <div className="artEditor">
      <div className="artEditBar">
        <span className="crumb" title={crumb}>
          {crumb}
        </span>
        <span className="spacer" />
        <div className="seg" role="tablist" aria-label="Layout">
          {(
            [
              ['write', PenLine, 'Write'],
              ['split', Columns2, 'Split'],
              ['preview', Eye, 'Preview'],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={layout === id}
              className={`segBtn${layout === id ? ' active' : ''}`}
              onClick={() => setLayout(id)}
              title={label}
            >
              <Icon size={13} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
        <span className="meta mono">
          {words(body)} words{dirty ? ' · unsaved' : ''}
        </span>
        <button type="button" className="btn sm ghost" onClick={cancel} disabled={saving}>
          {dirty ? 'Discard' : 'Close'}
        </button>
        <button type="button" className="btn sm primary" onClick={() => void save()} disabled={saving || !dirty || !title.trim()} title="⌘S">
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>

      {restored && (
        <div className="notice artRestored">
          Restored an unsaved draft from this browser.{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setTitle(initialTitle)
              setBody(initialBody)
              setRestored(false)
            }}
          >
            Use the saved version instead
          </button>
        </div>
      )}

      <input
        className="artEditTitle"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        aria-label="Title"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            area.current?.focus()
          }
        }}
      />

      <div className={`artEditPanes ${layout}`}>
        {layout !== 'preview' && (
          <textarea
            ref={area}
            className="artEditBody"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onBodyKey}
            placeholder={'Write in markdown. Facts, preferences, links — anything a session should be able to read.\n\nA session reads this with @artifact:.'}
            spellCheck
            aria-label="Body"
          />
        )}
        {layout !== 'write' && (
          <div className="artEditPreview">
            {body.trim() ? <Markdown text={body} /> : <div className="artEmpty">Nothing to preview yet.</div>}
          </div>
        )}
      </div>

      {error && <div className="msg error">{error}</div>}
      <div className="keysHint">
        <kbd>⌘S</kbd> save · <kbd>Tab</kbd> indent · <kbd>Esc</kbd> close when nothing is unsaved · drafts are kept in this browser until saved
      </div>
    </div>
  )
}
