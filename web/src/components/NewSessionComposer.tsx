import * as RadioGroup from '@radix-ui/react-radio-group'
import { CalendarCheck, Check, Folder, GitBranch, ListChecks, LoaderCircle, Plus, Repeat, Target, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  MAX_MENTIONS_PER_MESSAGE,
  mentionToken,
  type BranchResponse,
  type CreateStep,
  type EffortLevel,
  type ImageAttachment,
  type Mention,
  type PermissionMode,
  type Project,
  type ProjectsResponse,
  type ProviderId,
  type SessionMode,
} from '../../../shared/protocol.js'
import { branchFromTitle, plausibleBranch } from '../../../shared/branch.js'
import type { Draft } from '../drafts.js'
import { useCheckouts, useSessions } from '../hooks.js'
import { readSessionDefaults, writeSessionDefaults } from '../sessionDefaults.js'
import { DEFAULT_MODE } from '../permissionModes.js'
import { PromptBox } from './PromptBox.js'
import { defaultProjectOf } from './ProjectPicker.js'
import { CheckoutPicker } from './CheckoutPicker.js'
import { PromptHead } from './PromptHead.js'
import { JuniorFace } from './JuniorFace.js'
import { usePersona, useYouName } from '../junior.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { sessionAsk } from '../../../core/junior/greeting.js'
import type { Mood } from '../../../core/junior/mood.js'
import { matchItem, refsIn, shortRef } from '../../../core/junior/today.js'
import { offerFor } from '../../../core/junior/offers.js'

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** How long the face nods "On it." before the session opens. */
const HANDOFF_MS = 520
/** No keystroke for this long, with something typed: Junior is thinking it over. */
const PAUSE_MS = 1400

/** Examples the empty box cycles through after the ones made from your own inbox. */
const EXAMPLES = [
  'Fix the failing test and show me the diff first',
  'Read up on the auth flow and write me a note',
  'Open the app at 390px and check the settings page',
  'Draft release notes from this week’s merged PRs',
  'Find why the build got slower and fix it',
]

/**
 * The empty box's placeholder: examples that type themselves out, hold, erase
 * and give way to the next. Reduced motion swaps whole lines every few seconds.
 * `lines` must be stable between renders.
 */
function useRotating(lines: readonly string[], on: boolean): string {
  const [shown, setShown] = useState('')
  useEffect(() => {
    if (!on || !lines.length) return
    let i = 0
    if (reducedMotion()) {
      setShown(lines[0])
      const t = setInterval(() => {
        i = (i + 1) % lines.length
        setShown(lines[i])
      }, 4000)
      return () => clearInterval(t)
    }
    let n = 0
    let held = 0
    let phase: 'type' | 'hold' | 'erase' = 'type'
    const t = setInterval(() => {
      const line = lines[i]
      if (phase === 'type') {
        n++
        if (n >= line.length) phase = 'hold'
      } else if (phase === 'hold') {
        if (++held >= 55) phase = 'erase'
      } else {
        n = Math.max(0, n - 3)
        if (n === 0) {
          i = (i + 1) % lines.length
          held = 0
          phase = 'type'
        }
      }
      setShown(line.slice(0, n))
    }, 40)
    return () => clearInterval(t)
  }, [on, lines])
  return shown
}

/**
 * Junior's line, typed in once: `text` grows a character at a time until it is
 * all there. Reduced motion shows it whole. A new `text` types again.
 */
function useTyped(text: string): string {
  const [n, setN] = useState(() => (reducedMotion() ? text.length : 0))
  useEffect(() => {
    if (reducedMotion()) {
      setN(text.length)
      return
    }
    setN(0)
    let i = 0
    const t = setInterval(() => {
      i++
      setN(i)
      if (i >= text.length) clearInterval(t)
    }, 24)
    return () => clearInterval(t)
  }, [text])
  return text.slice(0, n)
}

export type NewSession = {
  title: string
  cwd: string
  firstMessage: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  permissionMode?: PermissionMode
  /** What Junior does before it starts; absent = normal */
  mode?: SessionMode
  /** The agent the session runs on for life; absent = Claude. */
  provider?: ProviderId
  images?: ImageAttachment[]
  mentions?: Mention[]
  /** the work item this session is dispatched for (recorded as a link) */
  itemId?: string
  /** an existing worktree to run in */
  checkoutId?: string
  /** a new worktree to make, then run in */
  worktree?: { branch: string }
}

type Props = {
  /** The draft this tab edits; text and folder round-trip through it so they survive a tab switch. */
  draft: Draft
  onChange: (patch: { text?: string; cwd?: string; label?: string; checkoutId?: string; newBranch?: string }) => void
  onCreate: (s: NewSession) => void
  /** the last send failed (e.g. the worktree couldn't be made) — a new object per failure */
  error?: { message: string } | null
  /** a send that makes a worktree: the step the server is on */
  step?: CreateStep | null
}

const STEPS: { step: CreateStep; label: (branch: string) => string }[] = [
  { step: 'worktree', label: (b) => `Creating worktree ${b}` },
  { step: 'files', label: () => 'Copying node_modules and .env' },
  { step: 'session', label: () => 'Starting the session' },
]

/** A send that makes a worktree, as a checklist: done, doing, to do — with a running clock. */
function MakingWorktree({ branch, step }: { branch: string; step: CreateStep | null }) {
  const [started] = useState(Date.now)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [])
  const at = step ? STEPS.findIndex((s) => s.step === step) : 0
  return (
    <div className="makingWt" role="status" aria-live="polite">
      <ol>
        {STEPS.map((s, i) => (
          <li key={s.step} className={i < at ? 'done' : i === at ? 'now' : 'todo'}>
            {i < at ? (
              <Check size={12} aria-hidden="true" />
            ) : i === at ? (
              <LoaderCircle size={12} className="spin" aria-hidden="true" />
            ) : (
              <span className="dotTodo" aria-hidden="true" />
            )}
            {s.label(branch)}
          </li>
        ))}
      </ol>
      <span className="secs">{((now - started) / 1000).toFixed(1)}s</span>
    </div>
  )
}


/** The first line names the session; `@` tokens read as their labels, not their ids. */
function titleFrom(text: string, mentions: readonly Mention[] = []): string {
  let line = text.trim().split('\n')[0]
  for (const m of mentions) line = line.split(mentionToken(m)).join(`@${m.label}`)
  return line.slice(0, 80)
}


/** A draft tab: the composer that becomes a session on first send. */
export function NewSessionComposer({ draft, onChange, onCreate, error, step }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  const checkouts = useCheckouts()
  const sessions = useSessions()
  // A send that makes a worktree takes a moment (git, then a node_modules clone); say so until it lands or fails.
  const [making, setMaking] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  useEffect(() => {
    if (error) setMaking(null)
  }, [error])
  // No folder chosen yet → the default project. Until projects load the
  // server picks it: an empty cwd on send means "the default project".
  const fallback = defaultProjectOf(projects)
  // "New job" / "New goal": a chat with Junior that sets one up — no checkout to pick, it names its own project.
  // Opened as one, or picked from the starters under the box.
  const [job, setJob] = useState(draft.intent === 'job')
  // Mode (Normal / Plan / Goal): "Turn into a goal" opens on Goal. A goal's first message goes out marked
  // as one (the server says so to the model), so it carries no "New goal:" prefix of its own.
  const [mode, setMode] = useState<SessionMode>(draft.intent === 'goal' ? 'goal' : 'normal')
  const goal = mode === 'goal'
  const prefix = job ? 'New job: ' : ''
  const cwd = draft.cwd ?? fallback?.path ?? '~'
  // The project's live checkouts; the picker shows for git projects only (main has a branch, or worktrees exist).
  const project = projects.find((p) => p.path === cwd)
  const projectCheckouts = project ? checkouts.filter((c) => c.projectId === project.id && c.state === 'active') : []
  const mainCo = projectCheckouts.find((c) => c.kind === 'main')
  const canPick = !!mainCo && (mainCo.branch !== null || projectCheckouts.length > 1)
  const pickedCo = canPick && draft.newBranch === undefined ? projectCheckouts.find((c) => c.id === draft.checkoutId && c.kind === 'worktree') : undefined
  const isNew = canPick && draft.newBranch !== undefined
  // A dispatched item asks where it runs, up front; the head's picker stays in step with it.
  const suggestBranch = () => draft.branchHint ?? branchFromTitle(draft.label ?? draft.text)
  // The item's own worktree, read live rather than trusted from the draft — a draft can outlive the moment it was made.
  const continueCo = projectCheckouts.find(
    (c) => c.kind === 'worktree' && (c.id === draft.continueIn || (!!draft.itemId && c.itemId === draft.itemId)),
  )
  // Git gives a branch one folder: a "new" branch that already has a worktree just runs there.
  const typedBranch = isNew ? (draft.newBranch ?? '').trim() : ''
  const sameBranchCo = typedBranch ? projectCheckouts.find((c) => c.kind === 'worktree' && c.branch === typedBranch) : undefined
  const where = isNew ? 'new' : pickedCo ? (pickedCo.id === continueCo?.id ? 'continue' : '') : 'main'
  const pickWhere = (v: string) => {
    setLocalError(null)
    if (v === 'main') onChange({ checkoutId: undefined, newBranch: undefined })
    else if (v === 'continue' && continueCo) onChange({ checkoutId: continueCo.id, newBranch: undefined })
    else if (v === 'new') onChange({ checkoutId: undefined, newBranch: draft.newBranch ?? suggestBranch() })
  }
  // The last pick here is the default for the next new session — a per-browser
  // preference (see sessionDefaults.ts), which the Sessions settings tab edits too.
  // Read on mount, not at module load: the page lives for days in the Mac app,
  // so a load-time read would pin every new draft to the first pick.
  const [defaults] = useState(readSessionDefaults)
  const [model, setModel] = useState<string | undefined>(defaults.model)
  const [effort, setEffort] = useState<EffortLevel | undefined>(defaults.effort)
  const [fastMode, setFastMode] = useState(defaults.fastMode)
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(defaults.permissionMode ?? DEFAULT_MODE)
  // Every draft starts on Claude. The saved defaults are Claude's (its model
  // ids, its fast mode), so they are neither carried into another agent nor
  // overwritten by a pick made there.
  const [provider, setProvider] = useState<ProviderId>('claude')
  const onClaude = provider === 'claude'
  const persona = usePersona()
  const you = useYouName()

  // Junior's line in the bubble: a greeting by time of day, then the question; "On it." once you send.
  const [handoff, setHandoff] = useState(false)
  useEffect(() => {
    if (error) setHandoff(false)
  }, [error])
  const { greet, ask } = useMemo(() => sessionAsk(Date.now(), persona.voice, you), [persona.voice, you])
  const question = job ? 'Tell me about the job.' : goal ? 'Tell me about the goal.' : draft.label ? 'Anything I should know before I start?' : ask
  const said = useTyped(handoff ? 'On it.' : `${greet} ${question}`)

  // The face: listens while you type, thinks when you pause, nods when you send.
  const [typing, setTyping] = useState(false)
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(pauseTimer.current), [])
  const hasText = !!draft.text.trim()
  const mood: Mood = handoff ? 'done' : making ? 'working' : !hasText ? 'hello' : typing ? 'listen' : 'think'
  const look = handoff ? null : hasText && typing ? { x: 0, y: 1 } : hasText ? { x: 0.55, y: -0.6 } : null

  // "I'll pull in…": refs typed in the message that name a real work item ride along as @item mentions.
  const inbox = useInbox()
  useEffect(() => {
    if (!inbox.loaded && !inbox.loading) void inboxStore.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The empty box cycles examples: what Junior would do with your top inbox items first, then general ones.
  const topKey = inbox.items
    .filter((i) => i.kind !== 'digest' && i.group !== 'fyi')
    .slice(0, 3)
    .map((i) => i.id)
    .join('|')
  const examples = useMemo(() => {
    const now = Date.now()
    const own = inbox.items
      .filter((i) => i.kind !== 'digest' && i.group !== 'fyi')
      .slice(0, 3)
      .map((i) => offerFor(i, now).title)
    return [...own, ...EXAMPLES]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topKey])
  const example = useRotating(examples, onClaude && !job && !goal && !draft.label && !hasText)

  const [dropped, setDropped] = useState<string[]>([])
  const pulled = useMemo(() => {
    const out: { id: string; title: string; ref: string }[] = []
    for (const r of refsIn(draft.text)) {
      const hit = matchItem(r, inbox.items)
      const item = hit && inbox.items.find((i) => i.id === hit.id)
      if (!item || item.id === draft.itemId || dropped.includes(item.id) || out.some((o) => o.id === item.id)) continue
      out.push({ id: item.id, title: item.title, ref: shortRef(item) })
    }
    return out
  }, [draft.text, inbox.items, dropped, draft.itemId])

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  // The header names the branch the session will start on.
  useEffect(() => {
    let live = true
    setBranch(null)
    void fetch(`/api/git/branch?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json() as Promise<BranchResponse>)
      .then((b) => {
        if (live && b.ok) setBranch(b.branch)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [cwd])

  return (
    <div id="newSessionHome" className={onClaude ? 'junior' : undefined} style={{ '--junior': persona.colour } as CSSProperties}>
      <div className={`glow ${onClaude ? 'junior' : 'blue'}`} aria-hidden="true" />
      {onClaude ? (
        // Junior is Claude here: it asks, its face beside the line, and the face reacts to you.
        <div className={`nsWho${handoff ? ' handoff' : ''}`}>
          <span className="nsFace">
            <JuniorFace mood={mood} size={56} motion="follow" look={look} />
          </span>
          <h2 className="nsLine" aria-label={handoff ? 'On it.' : `${greet} ${question}`}>
            <span aria-hidden="true">
              {handoff ? (
                said
              ) : (
                <>
                  <span className="g">{said.slice(0, greet.length)}</span>
                  {said.slice(greet.length)}
                </>
              )}
            </span>
          </h2>
        </div>
      ) : (
        // A connected agent (Codex) gets the plain heading.
        <h2>{job ? 'Tell me about the job.' : goal ? 'Tell me about the goal.' : draft.label ? 'Dispatching.' : 'What are we working on?'}</h2>
      )}
      {draft.itemId && canPick && mainCo && !goal && (
        <div className="runIn">
          <span className="lbl" id={`runin-${draft.id}`}>
            Run in
          </span>
          <RadioGroup.Root className="seg" aria-labelledby={`runin-${draft.id}`} value={where} onValueChange={pickWhere}>
            <RadioGroup.Item value="main" className={`segBtn${where === 'main' ? ' active' : ''}`} title={mainCo.path}>
              <Folder size={11} aria-hidden="true" /> Current folder{mainCo.branch ? ` · ${mainCo.branch}` : ''}
            </RadioGroup.Item>
            {continueCo && (
              <RadioGroup.Item value="continue" className={`segBtn wt${where === 'continue' ? ' active' : ''}`} title={continueCo.path}>
                <GitBranch size={11} aria-hidden="true" /> Continue in {continueCo.branch ?? 'its worktree'}
              </RadioGroup.Item>
            )}
            <RadioGroup.Item value="new" className={`segBtn wt${where === 'new' ? ' active' : ''}`} title="A new branch and folder for this item">
              <Plus size={11} aria-hidden="true" /> New worktree
            </RadioGroup.Item>
          </RadioGroup.Root>
        </div>
      )}
      <PromptBox
        draftKey={draft.id}
        head={
          <PromptHead
            projects={projects}
            cwd={cwd}
            branch={branch}
            // A worktree belongs to one project: changing project drops it, keeps a new branch's name.
            onPick={(path) => onChange({ cwd: path, checkoutId: undefined })}
            checkout={
              canPick && project && !job && !goal ? (
                <CheckoutPicker
                  projectName={project.name}
                  checkouts={projectCheckouts}
                  checkoutId={draft.checkoutId}
                  newBranch={draft.newBranch}
                  onPick={(pick) => {
                    setLocalError(null)
                    onChange({ checkoutId: pick.checkoutId, newBranch: pick.newBranch })
                  }}
                  suggest={suggestBranch}
                  sessionsIn={(id) => sessions.filter((x) => x.checkoutId === id).length}
                />
              ) : undefined
            }
            where={sameBranchCo ? sameBranchCo.path : isNew ? 'a new worktree, made when you send' : pickedCo?.path}
          />
        }
        cwd={cwd}
        text={draft.text}
        onTextChange={(text) => {
          onChange({ text })
          setTyping(true)
          clearTimeout(pauseTimer.current)
          pauseTimer.current = setTimeout(() => setTyping(false), PAUSE_MS)
        }}
        placeholder={
          job
            ? 'What should it do, how often, and what must it never do? e.g. “Every weekday at 9, find PRs waiting on my review”'
            : goal
              ? 'What is the outcome, and how will we know it’s done? e.g. “CI green on main, the flaky test fixed”'
              : mode === 'plan'
                ? 'What should Junior plan? It reads and plans, and edits nothing until you approve the plan.'
                : onClaude
                ? draft.label
                  ? `Tell ${persona.name} what to work on — a bug, a feature, a question…`
                  : `Try: ${example}`
                : 'Describe what you want to work on — a bug, a feature, a question…'
        }
        focusKey={draft.id}
        sendTitle="Start the session (Enter)"
        busy={!!making || handoff}
        // Send, once there's something to send, is a pill with Junior in it: "Send ↵" keeps it unmistakable, the face
        // only blinks (looking straight out) so the big face by the greeting stays the one that's alive.
        sendFace={
          onClaude
            ? (hover) => (
                <>
                  <JuniorFace mood={hover ? 'listen' : 'hello'} size={18} motion="wander" look={{ x: 0, y: 0 }} decorative />
                  <span>Send</span>
                  <kbd aria-hidden="true">↵</kbd>
                </>
              )
            : undefined
        }
        initialMentions={draft.mentions}
        onSubmit={(text, images, picked) => {
          const typedIn = pulled.filter((p) => !picked?.some((m) => m.kind === 'item' && m.ref === p.id)).map((p) => ({ kind: 'item' as const, ref: p.id, label: p.title }))
          const mentions = [...(picked ?? []), ...typedIn].slice(0, MAX_MENTIONS_PER_MESSAGE)
          const newBranch = isNew ? (draft.newBranch?.trim() || branchFromTitle(text)) : ''
          const existing = isNew ? projectCheckouts.find((c) => c.kind === 'worktree' && c.branch === newBranch) : undefined
          if (isNew && !existing && !plausibleBranch(newBranch)) {
            setLocalError(newBranch ? `"${newBranch}" isn't a branch name git will take` : 'Name the branch for the new worktree')
            return
          }
          setLocalError(null)
          const go = () => {
            if (isNew && !existing) setMaking(newBranch)
            onCreate({
              title: prefix ? `${prefix}${titleFrom(text, mentions)}` : goal ? `Goal: ${draft.label ?? titleFrom(text, mentions)}` : (draft.label ?? titleFrom(text, mentions)),
              cwd: draft.cwd ?? fallback?.path ?? '',
              firstMessage: `${prefix}${text}`,
              model,
              effort,
              fastMode: onClaude && fastMode,
              permissionMode,
              ...(onClaude && !job && mode !== 'normal' ? { mode } : {}),
              ...(onClaude ? {} : { provider }),
              images,
              mentions,
              ...(draft.itemId ? { itemId: draft.itemId } : {}),
              ...(existing
                ? { checkoutId: existing.id }
                : isNew
                  ? { worktree: { branch: newBranch } }
                  : pickedCo
                    ? { checkoutId: pickedCo.id }
                    : {}),
            })
          }
          // Junior nods "On it." first; the session opens as the nod ends.
          if (onClaude && !reducedMotion()) {
            setHandoff(true)
            setTimeout(go, HANDOFF_MS)
          } else go()
        }}
        model={model}
        effort={effort}
        fastMode={fastMode}
        permissionMode={permissionMode}
        onModelChange={(m, e) => {
          setModel(m)
          setEffort(e)
          if (onClaude) writeSessionDefaults({ model: m, effort: e })
        }}
        provider={provider}
        onProviderChange={(p) => {
          // Back on Claude: its saved defaults, re-read. Elsewhere: that agent's default model.
          const d = p === 'claude' ? readSessionDefaults() : undefined
          setProvider(p)
          setModel(d?.model)
          setEffort(d?.effort)
        }}
        onFastModeChange={(on) => {
          setFastMode(on)
          writeSessionDefaults({ fastMode: on })
        }}
        onPermissionModeChange={(m) => {
          setPermissionMode(m)
          writeSessionDefaults({ permissionMode: m })
        }}
        {...(job ? {} : { mode, onModeChange: setMode })}
      />
      {onClaude && !draft.itemId && !hasText && !handoff && !making && (
        // Starters, not modes: each only sets up the box (a job chat, Plan first, a goal) or fills it in.
        // Any session can still become any of these from what you say.
        <div className="nsStarters">
          <button type="button" className={job ? 'on job' : undefined} aria-pressed={job} onClick={() => {
            setJob(!job)
            setMode('normal')
          }}>
            <Repeat size={12} aria-hidden="true" /> Set up a job
          </button>
          <button type="button" className={goal ? 'on goal' : undefined} aria-pressed={goal} onClick={() => {
            setJob(false)
            setMode(goal ? 'normal' : 'goal')
          }}>
            <Target size={12} aria-hidden="true" /> Start a goal
          </button>
          <button type="button" className={mode === 'plan' ? 'on plan' : undefined} aria-pressed={mode === 'plan'} onClick={() => {
            setJob(false)
            setMode(mode === 'plan' ? 'normal' : 'plan')
          }}>
            <ListChecks size={12} aria-hidden="true" /> Plan something
          </button>
          <button type="button" onClick={() => onChange({ text: 'Pick up the next item on today’s plan' })}>
            <CalendarCheck size={12} aria-hidden="true" /> Pick up today’s next item
          </button>
        </div>
      )}
      {pulled.length > 0 && (
        <div className="nsPull" aria-live="polite">
          <span className="nsPullLb">{onClaude ? "I'll pull in" : 'Attaching'}</span>
          {pulled.map((p) => (
            <span key={p.id} className="chip" title={p.title}>
              <b>{p.ref}</b>
              <span className="t">{p.title}</span>
              <button type="button" aria-label={`Don't attach ${p.ref}`} title="Don't attach" onClick={() => setDropped((d) => [...d, p.id])}>
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      {(localError || (error && !making)) && (
        <p className="composeError" role="alert">
          {localError ?? error?.message}
        </p>
      )}
      {sameBranchCo && !making && (
        <p className="composeNote">
          {typedBranch} already has a worktree — this session runs there.{' '}
          {continueCo?.id === sameBranchCo.id ? 'It was made for this item.' : ''}
        </p>
      )}
      {making && <MakingWorktree branch={making} step={step ?? null} />}

    </div>
  )
}
