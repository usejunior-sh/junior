import * as Dialog from '@radix-ui/react-dialog'
import { X, Link2, Paperclip, Flag, Folder } from 'lucide-react'
import { useRef, useState, useEffect } from 'react'
import { RepoScopeEditor } from '../RepoScope.js'
import { type ScoredItem, type Project, type ItemImage, type FileRef, itemImageUrl, type ItemImageEdit, type ManualItemResponse } from '../../../../shared/protocol.js'
import { withWorkspace } from '../../workspaceUrl.js'
import { useAttachments } from '../../attachments.js'
import { AttachmentStrip } from '../AttachmentStrip.js'
import { projectColor } from '../../tabs.js'
import { DatePopover } from '../Calendar.js'
import { dayInput } from '../../dueDay.js'
import { PRIORITY_VALUES, PRIORITY_LABEL } from '../../itemUi.js'
import { Select, SelectItem } from '../../ui/Select.js'
import { choosesProject, ProjectIdPicker, defaultProjectOf } from '../ProjectPicker.js'
import { useReturnFocus } from '../../ui/returnFocus.js'

// Item composer: add or edit a manual work item. Title, description, link,
// project, priority, plus screenshots, which are the point: a brief or a
// dispatched session reads the images the same way it reads the description,
// so "here is what's broken" can be a paste rather than a paragraph.
//
// Both dialogs here are Radix Dialogs. Escape closes them; a click on the
// scrim does nothing, as with the native showModal() they replaced: a stray
// click must not drop a typed item or an unsaved repo scope.

const keepOpen = (e: Event) => e.preventDefault()

export function ItemComposer({
  open,
  editing,
  projects,
  onClose,
  onSaved,
  onSavedMore,
}: {
  open: boolean
  editing: ScoredItem | null
  projects: Project[]
  onClose: () => void
  onSaved: () => void
  /** Saved with "Add more" on: refresh the inbox, but keep the composer open. */
  onSavedMore: () => void
}) {
  const titleInput = useRef<HTMLInputElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState(0)
  const [due, setDue] = useState('')
  const [description, setDescription] = useState('')
  const [url, setUrl] = useState('')
  const [linkOpen, setLinkOpen] = useState(false)
  /** images the item already holds (edit only), dropping one here deletes it on save */
  const [kept, setKept] = useState<ItemImage[]>([])
  /** files the item already holds (edit only), dropped here the same way */
  const [keptFiles, setKeptFiles] = useState<FileRef[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [addMore, setAddMore] = useState(false)
  const attach = useAttachments()
  const returnFocus = useReturnFocus(open)

  // Reseed the fields each time the composer opens (not while it stays open).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTitle(editing?.title ?? '')
      setProjectId(editing?.projectId ?? '')
      setPriority(editing?.priority ?? 0)
      setDue(dayInput(editing))
      setDescription(editing?.description ?? editing?.note ?? '')
      setUrl(editing?.url ?? '')
      setLinkOpen(!!editing?.url)
      setKept(editing?.images ?? [])
      setKeptFiles(editing?.files ?? [])
      attach.clear()
      setError(null)
    }
    wasOpen.current = open
  }, [open, editing])

  // One tray, two origins: what the item already holds and what is being
  // pasted now. The strip does not care which is which; removal does.
  const thumbs = [
    ...kept.map((i) => ({ id: i.id, url: editing ? withWorkspace(itemImageUrl(editing.id, i.id)) : '', name: i.name })),
    ...attach.images,
  ]
  const stripFiles = [
    ...keptFiles.map((f) => ({ id: f.id, name: f.name, bytes: f.bytes })),
    ...attach.files.map((f) => ({ id: f.id, name: f.name, bytes: f.bytes, uploading: !f.uploadId })),
  ]
  const attached = thumbs.length + stripFiles.length
  const removeThumb = (id: string) => {
    if (kept.some((i) => i.id === id)) setKept((prev) => prev.filter((i) => i.id !== id))
    else if (keptFiles.some((f) => f.id === id)) setKeptFiles((prev) => prev.filter((f) => f.id !== id))
    else attach.remove(id)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      // The complete desired set: refs to keep, then the new pastes.
      const images: ItemImageEdit[] = [
        ...kept.map((i) => ({ id: i.id })),
        ...(attach.payload() ?? []),
      ]
      // Files go by id: the ones the item holds, then this sitting's uploads. Always the full set on an edit.
      const files = [...keptFiles.map((f) => f.id), ...(attach.fileIds() ?? [])]
      const payload = {
        title,
        projectId: projectId || undefined,
        priority,
        description: description.trim() || undefined,
        url: url.trim() || undefined,
        // An edit sends the day only when it changed: null clears it.
        ...(editing ? (due !== dayInput(editing) ? { due: due || null } : {}) : due ? { due } : {}),
        images,
        ...(editing || files.length > 0 ? { files } : {}),
      }
      const path = editing ? `/api/items/manual?id=${encodeURIComponent(editing.id)}` : '/api/items/manual'
      const res = await fetch(path, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as ManualItemResponse
      if (!body.ok) {
        setError(body.error)
      } else if (addMore && !editing) {
        // keep the composer open for the next one; clear all but the project
        onSavedMore()
        setTitle('')
        setDescription('')
        setUrl('')
        setLinkOpen(false)
        setPriority(0)
        setDue('')
        attach.clear()
        setError(null)
        titleInput.current?.focus()
      } else {
        onSaved()
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content
          className="uiDialog itemComposer"
          aria-describedby={undefined}
          onInteractOutside={keepOpen}
          onOpenAutoFocus={(e) => {
            // The default lands on the first tabbable, the X; the title is where you start.
            e.preventDefault()
            titleInput.current?.focus()
          }}
          onCloseAutoFocus={returnFocus}
        >
          <form
            className={dragging ? 'dragging' : undefined}
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
            // ⌘↵ saves from any field: the description is where you live, and
            // reaching for the button to save a two-line to-do is a tax.
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && title.trim() && !saving && !attach.uploading) {
                e.preventDefault()
                void save()
              }
            }}
            onPaste={attach.onPaste}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              setDragging(false)
              void attach.add(e.dataTransfer.files)
            }}
          >
            <div className="composerHead">
              <div className="crumbs">
                <span className="crumb">Inbox</span>
                <span className="crumbSep">›</span>
                <Dialog.Title asChild>
                  <span className="crumb now">{editing ? 'Edit work item' : 'New work item'}</span>
                </Dialog.Title>
              </div>
              <button type="button" className="composerClose" onClick={onClose} aria-label="Close">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <input
              ref={titleInput}
              className="titleInput"
              placeholder="What needs doing?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="descInput"
              rows={4}
              placeholder="Context, acceptance criteria, or a pasted screenshot — the brief reads all of it."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />

            {linkOpen && (
              <label className="linkRow">
                <Link2 size={13} aria-hidden="true" />
                <input
                  type="url"
                  placeholder="https://…"
                  value={url}
                  autoFocus={!editing?.url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
            )}

            <div className="composerAttachments">
              <AttachmentStrip images={thumbs} files={stripFiles} error={attach.error} onRemove={removeThumb} />
              {attached === 0 && !attach.error && (
                <button type="button" className="dropHint" onClick={() => filePicker.current?.click()}>
                  <Paperclip size={12} aria-hidden="true" />
                  Paste, drop, or click to attach a file or screenshot
                </button>
              )}
            </div>

            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void attach.add(e.target.files)
                // Reset, so picking the same file twice in a row still fires.
                e.target.value = ''
              }}
            />

            <div className="pillRow">
              <Select
                className={`pill prio${priority}`}
                title="Priority"
                aria-label="Priority"
                icon={<Flag size={12} aria-hidden="true" />}
                value={String(priority)}
                onValueChange={(v) => setPriority(Number(v))}
              >
                {PRIORITY_VALUES.map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    {v === 0 ? 'Priority' : PRIORITY_LABEL[v]}
                  </SelectItem>
                ))}
              </Select>
              <DatePopover className="pill" value={due} onChange={setDue} />
              {choosesProject(projects) && (
              <ProjectIdPicker
                projects={projects}
                value={projectId || defaultProjectOf(projects)?.id || ''}
                allowNone={false}
                onChange={(id) => id && setProjectId(id)}
              >
                {(current) => (
                  <button type="button" className={`pill${current ? ' set' : ''}`} title="Project" aria-label="Project">
                    {current ? (
                      <span className="pdot" style={{ background: projectColor(current.id) }} aria-hidden="true" />
                    ) : (
                      <Folder size={12} aria-hidden="true" />
                    )}
                    {current?.name ?? 'Project'}
                  </button>
                )}
              </ProjectIdPicker>
              )}
              <button
                type="button"
                className={`pill add${attached ? ' set' : ''}`}
                onClick={() => filePicker.current?.click()}
                title="Attach a file or screenshot — or just paste or drop it"
                aria-label="Attach file"
              >
                <Paperclip size={12} aria-hidden="true" />
                {attached > 0 ? `${attached} file${attached === 1 ? '' : 's'}` : 'File'}
              </button>
              {!linkOpen && (
                <button type="button" className="pill add" onClick={() => setLinkOpen(true)} title="Add a link">
                  <Link2 size={12} aria-hidden="true" />
                  Link
                </button>
              )}
            </div>

            {error && <div className="msg error">{error}</div>}

            <div className="composerFoot">
              {!editing && (
                <label className="addMore" title="Keep this open to add another after saving">
                  <input type="checkbox" checked={addMore} onChange={(e) => setAddMore(e.target.checked)} />
                  <span className="switch" aria-hidden="true" />
                  Add more
                </label>
              )}
              <div className="footActions">
                <span className="hint">⌘↵</span>
                <button type="button" className="cancel" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="go" disabled={saving || attach.uploading || !title.trim()}>
                  {saving ? 'Saving…' : attach.uploading ? 'Uploading…' : editing ? 'Save changes' : 'Add item'}
                </button>
              </div>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// Repo picker: which repos the GitHub source is scoped to, per workspace.
// Empty = no GitHub items (scope is opt-in per workspace, .docs/workspaces.md).

export function RepoPicker({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: (count: number) => void
}) {
  const returnFocus = useReturnFocus(open)

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="projOverlay" />
        <Dialog.Content className="uiDialog repoDialog" onInteractOutside={keepOpen} onCloseAutoFocus={returnFocus}>
          <Dialog.Title asChild>
            <h3>Connected repos</h3>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="pickerSub">
              The GitHub source only pulls from checked repos, and this scope is per workspace. Nothing
              checked = no GitHub items here.
            </p>
          </Dialog.Description>
          <RepoScopeEditor onSaved={onSaved} onCancel={onClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
