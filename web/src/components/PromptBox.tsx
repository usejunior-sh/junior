import { ArrowUp, LoaderCircle, Paperclip, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  mentionToken,
  type EffortLevel,
  type FastModeDisabledReason,
  type FastModeState,
  type ImageAttachment,
  type Mention,
  type MentionKind,
  type PermissionMode,
  type SessionMode,
  type ProviderId,
} from '../../../shared/protocol.js'
import { useAttachments } from '../attachments.js'
import { activeCommand, insertCommand, useCommandSearch, useCommands, type CommandHit } from '../commands.js'
import {
  MENTION_TABS,
  activeMention,
  insertMention,
  setMentionKind,
  useMentionSearch,
  useMentions,
  type MentionHit,
} from '../mentions.js'
import { nextMode } from '../permissionModes.js'
import { AttachmentStrip } from './AttachmentStrip.js'
import { FastModeToggle } from './FastModeToggle.js'
import { MentionPicker, flatHits } from './MentionPicker.js'
import { CommandPill } from './CommandPill.js'
import { SlashPicker } from './SlashPicker.js'
import { ModelPopover } from './ModelPopover.js'
import { AutonomyPicker } from './AutonomyPicker.js'
import { ModePicker } from './ModePicker.js'
import { nextSessionMode } from '../sessionModes.js'

type Props = {
  /** The header row: which project, which branch, which folder. */
  head: ReactNode
  /** The folder `@file` mentions are searched in and resolved against. */
  cwd: string
  text: string
  onTextChange: (text: string) => void
  placeholder: string
  /** When this changes the box is refocused with the caret at the end. */
  focusKey?: string
  /** Called with the trimmed text and whatever is attached: images, `@` mentions, uploaded file ids. */
  onSubmit: (text: string, images?: ImageAttachment[], mentions?: Mention[], files?: string[]) => void
  sendTitle: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  fastModeState?: FastModeState
  fastModeDisabledReason?: FastModeDisabledReason
  permissionMode?: PermissionMode
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  /** The agent this box sends to; shows the agent rail in the model picker. */
  provider?: ProviderId
  /** A draft can switch agents; a live session's rail is locked (omit this). */
  onProviderChange?: (provider: ProviderId) => void
  onFastModeChange: (fastMode: boolean) => void
  onPermissionModeChange: (mode: PermissionMode) => void
  /** What Junior does before it starts (Junior decides / Plan first / Goal), new sessions only; with it, Shift+Tab cycles this instead of the permission mode. */
  mode?: SessionMode
  onModeChange?: (mode: SessionMode) => void
  /** A read-only chip where the mode picker would be, a running session's "Planning". */
  status?: ReactNode
  /** A turn is in flight: offer the interrupt button. */
  running?: boolean
  onInterrupt?: () => void
  /** Mentions the box opens with (a dispatched draft): their tokens are already in `text`. */
  initialMentions?: Mention[]
  /** Keys the image tray so it survives the box unmounting (session id or draft id). */
  draftKey?: string
  /** A send is already on its way (a worktree being made): send is locked and spins until it lands or fails. */
  busy?: boolean
  /** Draw send as something else once it can send (Junior's face on a new session); `hover` = the pointer is on it. */
  sendFace?: (hover: boolean) => ReactNode
}

/**
 * The prompt box, shared by the draft tab and the live session so the two are
 * the same object in two places: a card headed by where it runs, a tray of
 * attached images and `@` mentions, the message, and the session's knobs as
 * pills underneath with the one bright control on the page, send.
 *
 * Typing `@` opens the mention picker over the box: files under the folder,
 * artifacts, work items, sessions. One query across all of them, narrowed by
 * the picker's tabs. The picker never takes focus; the box's key handler moves
 * the selection and the tabs while the keystrokes keep narrowing the query.
 *
 * Typing `/` as the first character opens the command picker the same way,
 * over the commands and skills this folder's Claude Code actually has. Picking
 * one only writes text, the CLI expands `/name args` itself when the message
 * lands, so unlike a mention there is nothing to attach and nothing to
 * resolve.
 */
export function PromptBox({
  head,
  cwd,
  text,
  onTextChange,
  placeholder,
  focusKey,
  onSubmit,
  sendTitle,
  model,
  effort,
  fastMode,
  fastModeState,
  fastModeDisabledReason,
  permissionMode,
  onModelChange,
  provider,
  onProviderChange,
  onFastModeChange,
  onPermissionModeChange,
  mode,
  onModeChange,
  status,
  running,
  onInterrupt,
  initialMentions,
  draftKey,
  busy,
  sendFace,
}: Props) {
  const box = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  // Modes are Claude's (plan mode is the SDK's); another agent shows only its permission chip.
  const modeOn = !!onModeChange && (provider ?? 'claude') === 'claude'
  const [dragging, setDragging] = useState(false)
  const attach = useAttachments(draftKey)
  const canSend = (!!text.trim() || attach.images.length > 0 || attach.files.length > 0) && !attach.uploading
  const faceOn = !!sendFace && canSend
  const [sendHover, setSendHover] = useState(false)
  const mentions = useMentions(text, initialMentions)

  // the `@` picker
  const [caret, setCaret] = useState(0)
  // Escape closes the picker for the token being typed; a new `@` reopens it.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [sel, setSel] = useState(0)
  const active = useMemo(() => activeMention(text, caret), [text, caret])
  const pickerOpen = active !== null && dismissedAt !== active.start
  const groups = useMentionSearch(pickerOpen ? active : null, cwd, mentions.mentions)
  const hits = useMemo(() => flatHits(groups), [groups])

  useEffect(() => setSel(0), [active?.query, active?.kind])
  useEffect(() => {
    if (active === null) setDismissedAt(null)
  }, [active])

  // the `/` picker
  // A command is only ever the whole start of a message, so a `/` name and an
  // `@` token can never both be under the caret. The two pickers are mutually
  // exclusive by construction rather than by a rule kept in step here.
  const cmdActive = useMemo(() => activeCommand(text, caret), [text, caret])
  // The folder's list is fetched the first time a `/` is typed against it
  // rather than on mount: a composer nobody runs a command in costs nothing,
  // and on a folder with no live session the list costs a subprocess.
  const [everSlashed, setEverSlashed] = useState(false)
  const [cmdDismissed, setCmdDismissed] = useState(false)
  const [cmdSel, setCmdSel] = useState(0)
  const { commands, loading: cmdLoading } = useCommands(cwd, everSlashed)
  const cmdOpen = cmdActive !== null && !cmdDismissed
  const cmdHits = useCommandSearch(cmdOpen ? cmdActive : null, commands)

  useEffect(() => setCmdSel(0), [cmdActive?.query])
  useEffect(() => {
    if (cmdActive) setEverSlashed(true)
    // Escape closes the menu for the command being typed; clearing the `/`
    // is what re-arms it, exactly as the `@` picker treats its own token.
    else setCmdDismissed(false)
  }, [cmdActive])

  const syncCaret = useCallback(() => {
    const el = box.current
    if (el) setCaret(el.selectionStart ?? el.value.length)
  }, [])

  /** Rewrite the text and land the caret once React has painted the new value. */
  const rewrite = useCallback(
    (next: { text: string; caret: number }) => {
      onTextChange(next.text)
      requestAnimationFrame(() => {
        const el = box.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
        setCaret(next.caret)
      })
    },
    [onTextChange],
  )

  const pick = useCallback(
    (h: MentionHit) => {
      if (!active) return
      mentions.add(h)
      rewrite(insertMention(text, active, h))
    },
    [active, text, mentions, rewrite],
  )

  /** Picking a command only writes text: there is nothing to attach. */
  const pickCommand = useCallback(
    (c: CommandHit) => {
      if (!cmdActive) return
      rewrite(insertCommand(text, cmdActive, c))
    },
    [cmdActive, text, rewrite],
  )

  /** A tab in the picker: retarget the token at one kind, keeping the query. */
  const pickKind = useCallback(
    (kind: MentionKind | null) => {
      if (!active) return
      rewrite(setMentionKind(text, active, kind))
    },
    [active, text, rewrite],
  )

  /** Tab / shift-tab walk the picker's tabs, wrapping at both ends. */
  const cycleKind = useCallback(
    (step: number) => {
      if (!active) return
      const i = MENTION_TABS.indexOf(active.kind)
      pickKind(MENTION_TABS[(i + step + MENTION_TABS.length) % MENTION_TABS.length])
    },
    [active, pickKind],
  )

  /**
   * The chip and the token are one thing, so dropping the chip is a text edit
   * and nothing else. Every copy of the token goes, and the tray follows.
   */
  const removeMention = useCallback(
    (m: Mention) => {
      const token = mentionToken(m)
      let next = text
      for (let i = next.indexOf(token); i >= 0; i = next.indexOf(token)) {
        next = next.slice(0, i) + next.slice(i + token.length).replace(/^ /, '')
      }
      onTextChange(next)
    },
    [text, onTextChange],
  )

  // the box
  const autosize = useCallback(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 320) + 'px'
  }, [])

  useEffect(autosize, [text, autosize])

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.focus()
    // Land the caret at the end: a dispatched draft arrives prefilled.
    el.setSelectionRange(el.value.length, el.value.length)
    setCaret(el.value.length)
  }, [focusKey])

  function submit() {
    if (busy) return
    const trimmed = text.trim()
    const images = attach.payload()
    const files = attach.fileIds()
    const picked = mentions.payload()
    if ((!trimmed && !images && !files) || attach.uploading) return
    onSubmit(trimmed, images, picked, files)
    attach.clear()
    mentions.clear()
    requestAnimationFrame(autosize)
  }

  return (
    <div id="composer">
      <div
        className={'frame card' + (dragging ? ' dragging' : '')}
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
        <div className="cardHead">{head}</div>

        <AttachmentStrip
          images={attach.images}
          files={attach.files.map((f) => ({ id: f.id, name: f.name, bytes: f.bytes, uploading: !f.uploadId }))}
          mentions={mentions.mentions}
          error={attach.error}
          onRemove={attach.remove}
          onRemoveMention={removeMention}
        />

        <MentionPicker
          open={pickerOpen}
          groups={groups}
          kind={active?.kind ?? null}
          onKind={pickKind}
          selected={sel}
          onHover={setSel}
          onPick={pick}
        >
          <SlashPicker
            open={cmdOpen}
            hits={cmdHits}
            loading={cmdLoading}
            selected={cmdSel}
            onHover={setCmdSel}
            onPick={pickCommand}
          >
            <div className="boxWrap">
              <CommandPill text={text} commands={commands} boxRef={box} />
              <textarea
                id="box"
                ref={box}
                autoFocus
                rows={1}
                value={text}
                placeholder={placeholder}
                onPaste={attach.onPaste}
                onChange={(e) => {
                  onTextChange(e.target.value)
                  setCaret(e.target.selectionStart ?? e.target.value.length)
                }}
                onSelect={syncCaret}
                onClick={syncCaret}
                onKeyUp={(e) => {
                  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') syncCaret()
                }}
                onKeyDown={(e) => {
                  if (cmdOpen) {
                    if (e.key === 'ArrowDown' && cmdHits.length) {
                      e.preventDefault()
                      setCmdSel((s) => (s + 1) % cmdHits.length)
                      return
                    }
                    if (e.key === 'ArrowUp' && cmdHits.length) {
                      e.preventDefault()
                      setCmdSel((s) => (s - 1 + cmdHits.length) % cmdHits.length)
                      return
                    }
                    // Enter and Tab both take the selection: Enter because it is
                    // the key everyone tries, Tab because completing a name is
                    // what Tab does everywhere else a name is being typed.
                    if ((e.key === 'Enter' || e.key === 'Tab') && cmdHits.length) {
                      e.preventDefault()
                      pickCommand(cmdHits[Math.min(cmdSel, cmdHits.length - 1)])
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setCmdDismissed(true)
                      return
                    }
                  }
                  if (pickerOpen) {
                    if (e.key === 'ArrowDown' && hits.length) {
                      e.preventDefault()
                      setSel((s) => (s + 1) % hits.length)
                      return
                    }
                    if (e.key === 'ArrowUp' && hits.length) {
                      e.preventDefault()
                      setSel((s) => (s - 1 + hits.length) % hits.length)
                      return
                    }
                    if (e.key === 'Enter' && hits.length) {
                      e.preventDefault()
                      pick(hits[Math.min(sel, hits.length - 1)])
                      return
                    }
                    // Tab walks the kind tabs rather than attaching, Enter already
                    // attaches, and the tabs are otherwise mouse-only.
                    if (e.key === 'Tab') {
                      e.preventDefault()
                      cycleKind(e.shiftKey ? -1 : 1)
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setDismissedAt(active?.start ?? null)
                      return
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  } else if (e.key === 'Tab' && e.shiftKey) {
                    // Claude Code's own gesture, and the composer is where the
                    // hands already are, so it lives here rather than in the
                    // global map, which ignores keys typed into a text field.
                    e.preventDefault()
                    if (modeOn) onModeChange!(nextSessionMode(mode))
                    else onPermissionModeChange(nextMode(permissionMode, (provider ?? 'claude') === 'claude'))
                  }
                }}
              />
            </div>
          </SlashPicker>
        </MentionPicker>

        <div className="statusline">
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
          <button
            className="chip attachBtn"
            onClick={() => filePicker.current?.click()}
            title="Attach file (or paste / drop it) · type @ to mention project files, work items, sessions · type / for commands"
            aria-label="Attach file"
          >
            <Paperclip aria-hidden="true" />
          </button>
          <ModelPopover
            model={model}
            effort={effort}
            onModelChange={onModelChange}
            provider={provider}
            onProviderChange={onProviderChange}
          />
          {modeOn && <ModePicker mode={mode} onChange={onModeChange!} />}
          {status}
          <AutonomyPicker mode={permissionMode} onChange={onPermissionModeChange} hooks={(provider ?? 'claude') === 'claude'} />
          <span className="spacer" />
          {/* Fast mode is a Claude serving tier; other agents have no such switch. */}
          {(provider ?? 'claude') === 'claude' && (
            <FastModeToggle
              model={model}
              fastMode={fastMode}
              state={fastModeState}
              reason={fastModeDisabledReason}
              onChange={onFastModeChange}
            />
          )}
          {running && onInterrupt && (
            <button id="stopBtn" onClick={onInterrupt} title="Interrupt the current turn" aria-label="Stop">
              <Square size={11} aria-hidden="true" />
            </button>
          )}
          <button
            id="sendBtn"
            onClick={submit}
            disabled={busy || !canSend}
            title={busy ? 'Starting…' : attach.uploading ? 'Uploading…' : sendTitle}
            aria-busy={busy || undefined}
            className={busy ? 'busy' : faceOn ? 'face' : undefined}
            onPointerEnter={() => setSendHover(true)}
            onPointerLeave={() => setSendHover(false)}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
            ) : faceOn ? (
              sendFace(sendHover)
            ) : (
              <ArrowUp size={15} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
