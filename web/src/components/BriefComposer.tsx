import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { BriefJob, BriefJobsResponse, PlaybookResponse, PlaybooksResponse, ScoredItem, SettingsResponse } from '../../../shared/protocol.js'
import { briefStore } from '../briefStore.js'
import { BRIEF_TYPE_LABEL, KIND_LABEL, playbookLabel } from '../itemUi.js'
import { findModel, useModels, usePickableModels } from '../models.js'
import { Select, SelectItem } from '../ui/Select.js'

type DialogProps = {
  /** the item to brief; null = closed */
  item: ScoredItem | null
  /** the item's newest brief job: a re-brief starts from its playbook and its edited text */
  latest: BriefJob | null
  onClose: () => void
}

/**
 * "Create brief" / "Re-brief": the composer in a modal, so the item page keeps
 * its Brief card as a document and the inbox can brief a row where it stands.
 * With edits or a note in it, only Cancel or Queue closes it. A stray click
 * or Esc never drops a rewritten template.
 */
export function BriefComposerDialog({ item, latest, onClose }: DialogProps) {
  const [dirty, setDirty] = useState(false)
  // Esc with the `/` picker open closes the picker, not the modal.
  const picking = useRef(false)
  // The `/` picker renders inside the modal, not at the end of <body>: the modal blocks
  // scrolling and clicks outside its own element, and the list has to scroll.
  const [frame, setFrame] = useState<HTMLDialogElement | null>(null)
  useEffect(() => setDirty(false), [item?.id])
  const guard = (e: Event) => (dirty || picking.current) && e.preventDefault()
  return (
    <Dialog.Root open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content asChild onEscapeKeyDown={guard} onInteractOutside={guard} onOpenAutoFocus={(e) => e.preventDefault()}>
          <dialog open className="projModal projAddDialog briefModal" ref={setFrame}>
            {item && (
              <>
                <Dialog.Title asChild>
                  <h3>{latest?.status === 'ready' ? 'Re-brief' : 'Create a brief'}</h3>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <p className="bmItem" title={item.title}>
                    <span className="k">{KIND_LABEL[item.kind] ?? item.kind}</span>
                    {item.title}
                  </p>
                </Dialog.Description>
                <BriefComposer key={item.id} item={item} latest={latest} focusSignal={1} portalTo={frame} onQueued={onClose} onCancel={onClose} onDirtyChange={setDirty} onPickingChange={(p) => {
                    picking.current = p
                  }} />
                <p className="sub bmSub">
                  Runs one at a time, in order, under the daily cap. The run reads only — it never posts, pushes or edits — and every
                  run is a session you can open.
                </p>
              </>
            )}
          </dialog>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

type Props = {
  item: ScoredItem
  latest: BriefJob | null
  /** bumped to focus the template */
  focusSignal: number
  /** where the `/` picker renders; default <body> */
  portalTo?: HTMLElement | null
  onQueued: () => void
  onCancel?: () => void
  /** unsaved template edits or a note */
  onDirtyChange: (dirty: boolean) => void
  onPickingChange?: (open: boolean) => void
}

/**
 * The brief composer (Decision 8): the brief's first message, editable. The
 * template's text sits in the box, switch it with the chip or a `/` at the
 * very start, and the note below it is the user's own words to Junior. The
 * edited text runs for this brief only; Save as template writes it back to
 * the playbook file. Nothing spends tokens until Queue brief.
 */
export function BriefComposer({ item, latest, focusSignal, portalTo, onQueued, onCancel, onDirtyChange, onPickingChange }: Props) {
  const [names, setNames] = useState<string[]>([])
  const [playbook, setPlaybook] = useState(latest?.playbook ?? item.kind)
  const [fileBody, setFileBody] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [model, setModel] = useState(latest?.model ?? '')
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  /** a switch that would drop the user's edits, waiting on Replace / Keep mine */
  const [pendingSwitch, setPendingSwitch] = useState<{ name: string; body: string } | null>(null)
  const [confirmSave, setConfirmSave] = useState(false)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const models = useModels()
  const pickable = usePickableModels(model || defaultModel || undefined)

  const edited = fileBody !== null && text !== fileBody
  const dirty = edited || note.trim() !== ''
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  useEffect(() => {
    void fetch('/api/playbooks')
      .then((r) => r.json() as Promise<PlaybooksResponse>)
      .then((b) => b.ok && setNames(b.playbooks.map((p) => p.kind)))
      .catch(() => {})
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<SettingsResponse>)
      .then((b) => b.ok && setDefaultModel(b.settings.briefsDefaultModel))
      .catch(() => {})
  }, [])

  // The first template: a re-brief keeps the sections the user added last time.
  useEffect(() => {
    let live = true
    void readBody(playbook).then((body) => {
      if (!live || body === null) return
      setFileBody(body)
      setText(latest?.playbook === playbook && latest.playbookBody ? latest.playbookBody : body)
    })
    return () => {
      live = false
    }
    // once per mount: later switches go through pick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Waits for the template: the box is disabled, so unfocusable, while it loads.
  const loaded = fileBody !== null
  useEffect(() => {
    if (!focusSignal || !loaded) return
    // Caret at the very start, where a `/` switches the template.
    const el = box.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, 0)
    el.scrollTop = 0
  }, [focusSignal, loaded])

  // Types first (what the brief is), then the kinds (what the item is), the item's own kind leading.
  const options = useMemo(() => {
    const types = Object.keys(BRIEF_TYPE_LABEL).filter((n) => names.includes(n))
    const kinds = names.filter((n) => !(n in BRIEF_TYPE_LABEL)).sort((a, b) => Number(b === item.kind) - Number(a === item.kind))
    const q = query.toLowerCase()
    const match = (n: string) => !q || n.includes(q) || playbookLabel(n).toLowerCase().includes(q)
    return [...types, ...kinds].filter(match)
  }, [names, query, item.kind])

  useEffect(() => setSel(0), [query, picking])
  // Keep the selected row in view as the arrow keys move it.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.mnOpt.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  useEffect(() => {
    onPickingChange?.(picking)
  }, [picking, onPickingChange])

  function openPicker() {
    setQuery('')
    setPicking(true)
    box.current?.focus()
  }

  function closePicker() {
    setPicking(false)
    setQuery('')
  }

  async function pick(name: string) {
    closePicker()
    if (name === playbook && !edited) return
    const body = await readBody(name)
    if (body === null) {
      setError(`Could not read the ${playbookLabel(name)} template.`)
      return
    }
    if (edited) setPendingSwitch({ name, body })
    else apply(name, body)
  }

  function apply(name: string, body: string) {
    setPlaybook(name)
    setFileBody(body)
    setText(body)
    setPendingSwitch(null)
    setConfirmSave(false)
    setSavedTo(null)
    box.current?.focus()
  }

  async function saveTemplate() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/playbooks?kind=${encodeURIComponent(playbook)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      const b = (await res.json()) as PlaybookResponse
      if (!b.ok) return setError(b.error)
      setFileBody(b.body)
      setText(b.body)
      setSavedTo(`playbooks/${playbook}.md`)
      setConfirmSave(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function queue() {
    if (busy || fileBody === null || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/briefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemIds: [item.id],
          playbook,
          ...(edited ? { playbookBody: text } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(model ? { model } : {}),
        }),
      })
      const b = (await res.json()) as BriefJobsResponse
      if (!b.ok) return setError(b.error)
      for (const j of b.jobs) briefStore.apply(j)
      onDirtyChange(false)
      onQueued()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  function onBoxKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void queue()
      return
    }
    const el = e.currentTarget
    if (!picking) {
      // `/` at the very start switches template rather than typing a slash.
      if (e.key === '/' && el.selectionStart === 0 && el.selectionEnd === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        openPicker()
      }
      return
    }
    // While the picker is open the keys drive it; focus never leaves the box.
    if (e.key === 'Escape') closePicker()
    else if (e.key === 'ArrowDown') setSel((i) => Math.min(i + 1, Math.max(options.length - 1, 0)))
    else if (e.key === 'ArrowUp') setSel((i) => Math.max(i - 1, 0))
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (options[sel]) void pick(options[sel])
    } else if (e.key === 'Backspace') {
      if (query) setQuery((q) => q.slice(0, -1))
      else closePicker()
    } else if (/^[a-z0-9-]$/i.test(e.key) && !e.metaKey && !e.ctrlKey) setQuery((q) => q + e.key.toLowerCase())
    else return
    e.preventDefault()
  }

  const defaultModelName = defaultModel ? findModel(models, defaultModel)?.name ?? defaultModel : 'Claude Code default'

  return (
    <div className="briefComposer">
      <Popover.Root open={picking} onOpenChange={(o) => (o ? openPicker() : closePicker())}>
        <div className="bcHead">
          <Popover.Trigger asChild>
            {/* Never takes focus: the picker is driven from the template box, which must keep it. */}
            <button type="button" className="bcChip" title="Switch template (/ at the start of the box)" onMouseDown={(e) => e.preventDefault()}>
              <span className="slash">/</span>
              {playbook}
              <span className="caret" aria-hidden="true">▾</span>
            </button>
          </Popover.Trigger>
          <span className="bcLabel">{playbookLabel(playbook)}{edited ? ' · edited' : ''}</span>
          <span className="bcHint">
            type <kbd>/</kbd> at the start to switch · <kbd>⌘↵</kbd> queue
          </span>
        </div>
        <Popover.Portal container={portalTo ?? undefined}>
          <Popover.Content
            className="mnPop bcPop"
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            // Focus stays in the template box on purpose; only a click elsewhere closes the picker.
            onFocusOutside={(e) => e.preventDefault()}
          >
            {query && <div className="bcQuery">/{query}</div>}
            <div className="mnList" role="listbox" aria-label="Template" ref={list}>
              {options.length === 0 && <div className="mnEmpty">No template matches “{query}”.</div>}
              {options.map((n, i) => {
                const head = i === 0 || (n in BRIEF_TYPE_LABEL) !== (options[i - 1]! in BRIEF_TYPE_LABEL)
                return (
                  <div key={n} className="bcOptWrap">
                    {head && <div className="mnHead">{n in BRIEF_TYPE_LABEL ? 'Brief type' : 'By kind'}</div>}
                    <button
                      type="button"
                      className={'mnOpt' + (i === sel ? ' sel' : '')}
                      role="option"
                      aria-selected={i === sel}
                      onMouseMove={() => setSel(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void pick(n)}
                    >
                      <span className="n">/{n}</span>
                      <span className="d">
                        {playbookLabel(n)}
                        {n === item.kind ? ' · this item' : ''}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="mnFoot">
              <span>
                <kbd>↑↓</kbd> move · <kbd>↵</kbd> use · <kbd>esc</kbd> close
              </span>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {pendingSwitch && (
        <div className="bcConfirm">
          <span>
            Replace your edits with <b>/{pendingSwitch.name}</b>?
          </span>
          <span className="spacer" />
          <button type="button" className="btn xs" onClick={() => apply(pendingSwitch.name, pendingSwitch.body)}>
            Replace
          </button>
          <button type="button" className="btn xs ghost" onClick={() => setPendingSwitch(null)}>
            Keep mine
          </button>
        </div>
      )}

      <textarea
        ref={box}
        className="bcTemplate"
        aria-label="Template"
        spellCheck={false}
        value={fileBody === null ? '' : text}
        placeholder={fileBody === null ? 'Loading the template…' : 'The template is empty — write what the brief should cover.'}
        disabled={fileBody === null}
        onChange={(e) => {
          setText(e.target.value)
          setSavedTo(null)
        }}
        onKeyDown={onBoxKey}
        onBlur={closePicker}
      />

      <div className="bcNote">
        <label htmlFor={`bcNote-${item.id}`}>Your note to Junior</label>
        <textarea
          id={`bcNote-${item.id}`}
          placeholder="e.g. I think it's the OAuth redirect — check staging first."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void queue()
            }
          }}
        />
      </div>

      {confirmSave && (
        <div className="bcConfirm">
          <span>
            Overwrite <b>playbooks/{playbook}.md</b>? Every later {playbookLabel(playbook)} brief starts from this text.
          </span>
          <span className="spacer" />
          <button type="button" className="btn xs" disabled={busy} onClick={() => void saveTemplate()}>
            Save
          </button>
          <button type="button" className="btn xs ghost" onClick={() => setConfirmSave(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <div className="msg error">{error}</div>}

      <div className="bcFoot">
        <Select className="pill" title="Which model runs the brief" aria-label="Model" value={model} onValueChange={setModel}>
          <SelectItem value="">Model: {defaultModelName}</SelectItem>
          {pickable.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </Select>
        {edited && (
          <>
            <button type="button" className="btn sm ghost" onClick={() => fileBody !== null && setText(fileBody)} title="Back to the template file's text">
              Reset
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirmSave(true)} title={`Write this text to playbooks/${playbook}.md`}>
              Save as template
            </button>
          </>
        )}
        {savedTo && <span className="bcSaved">saved to {savedTo}</span>}
        <span className="spacer" />
        {onCancel && (
          <button type="button" className="btn sm ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn sm primary" disabled={busy || fileBody === null || !text.trim()} onClick={() => void queue()}>
          {busy ? 'Queueing…' : 'Queue brief'} <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>
  )
}

async function readBody(name: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/playbooks?kind=${encodeURIComponent(name)}`)
    const b = (await r.json()) as PlaybookResponse
    return b.ok ? b.body : null
  } catch {
    return null
  }
}
