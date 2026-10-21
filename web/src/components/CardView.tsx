/**
 * A send's card body by its spec (core/cards, artifact 6cc4c9e2): the layout
 * the spec picked, each arg in the slot it named, read from the args the
 * card already holds. Every arg shows: the ones no slot took sit under
 * "All fields". The edit is typed the same way: one box per field, a switch
 * for a fixed set, and "Edit raw" for the args as JSON. What you approve is
 * the args, never the spec.
 */
import * as Collapsible from '@radix-ui/react-collapsible'
import * as RadioGroup from '@radix-ui/react-radio-group'
import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { applyEdits, editText, fieldText, isOptions, type CardPlan, type FieldEdit } from '../../../core/cards/spec.js'

type Args = Record<string, unknown>

/** A value that reads as JSON (an object, a list of objects) sits in a code block. */
const isJsonish = (v: unknown) => !!v && typeof v === 'object' && !(Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))

function Value({ v, className = '' }: { v: unknown; className?: string }) {
  return isJsonish(v) ? <pre className={`ajson ${className}`}>{fieldText(v)}</pre> : <span className={className}>{fieldText(v)}</span>
}

/** Where it goes: "channel C0123 · thread 1729.1", above the body, never as it. */
function Target({ plan, args }: { plan: CardPlan; args: Args }) {
  if (!plan.target.length) return null
  return (
    <div className="cTarget mono">
      {plan.target.map((k) => (
        <span key={k}>
          <span className="cLabel">{plan.labels[k]}</span> {fieldText(args[k])}
        </span>
      ))}
    </div>
  )
}

function Chips({ plan, args }: { plan: CardPlan; args: Args }) {
  if (!plan.chips.length) return null
  return (
    <div className="cChips">
      {plan.chips.map((k) => (
        <span key={k} className="cChip mono">
          {plan.labels[k]}: {fieldText(args[k])}
        </span>
      ))}
    </div>
  )
}

/** Label · value rows: the generic layout's body, and "All fields". */
function Rows({ plan, args, keys }: { plan: CardPlan; args: Args; keys: readonly string[] }) {
  return (
    <dl className="akv cRows">
      {keys.map((k) => (
        <div key={k} className="cRow">
          <dt>{plan.labels[k]}</dt>
          <dd>
            <Value v={args[k]} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The args no slot took, folded away under "All fields (n)"; the generic layout shows them open. */
function Rest({ plan, args }: { plan: CardPlan; args: Args }) {
  const [open, setOpen] = useState(false)
  if (!plan.rest.length) return null
  if (plan.layout === 'generic') return <Rows plan={plan} args={args} keys={plan.rest} />
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="cRest">
      <Collapsible.Trigger asChild>
        <button type="button" className="alink mute cMore">
          {open ? 'Fewer fields' : `All fields (${plan.rest.length} more)`}
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Rows plan={plan} args={args} keys={plan.rest} />
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

/** The draft as it will land: target, then the layout's own reading order. */
export function CardBody({ plan, args }: { plan: CardPlan; args: Args }) {
  const subject = plan.subject ? <div className="cSubject">{fieldText(args[plan.subject])}</div> : null
  const body = plan.body ? <Value v={args[plan.body]} className="cText" /> : null
  return (
    <div className={`cBody l-${plan.layout}`}>
      <div className="cWhere mono">{plan.name}</div>
      <Target plan={plan} args={args} />
      {plan.layout === 'message' ? (
        <div className="cMsg">{body}</div>
      ) : (
        <>
          <Chips plan={plan} args={args} />
          {subject}
          {body}
        </>
      )}
      {plan.layout === 'message' && <Chips plan={plan} args={args} />}
      <Rest plan={plan} args={args} />
    </div>
  )
}

/** One box for one field, by how it edits. */
function FieldInput({ k, label, edit, value, onChange, first }: { k: string; label: string; edit: FieldEdit; value: string; onChange: (v: string) => void; first: boolean }) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => {
    if (first) ref.current?.focus()
  }, [first])
  const id = `cf-${k}`
  let control
  if (isOptions(edit) || edit === 'boolean') {
    const options = isOptions(edit) ? edit.map(String) : ['true', 'false']
    control = (
      <RadioGroup.Root className="seg wrap" aria-labelledby={id} value={value} onValueChange={onChange} orientation="horizontal">
        {options.map((o) => (
          <RadioGroup.Item key={o} value={o} className="segBtn">
            {o}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    )
  } else if (edit === 'line' || edit === 'number' || edit === 'list') {
    control = <input ref={ref} aria-labelledby={id} inputMode={edit === 'number' ? 'decimal' : undefined} value={value} onChange={(e) => onChange(e.target.value)} />
  } else {
    control = (
      <textarea
        ref={ref}
        aria-labelledby={id}
        className={edit === 'json' ? 'ajsonEdit' : undefined}
        value={value}
        spellCheck={edit !== 'json'}
        rows={Math.min(14, Math.max(edit === 'json' ? 2 : 4, value.split('\n').length + 1, Math.ceil(value.length / 70)))}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <div className="afieldEdit">
      <span id={id} className="mono">
        {label}
      </span>
      {control}
    </div>
  )
}

/**
 * Edit, then approve: the placed fields first, the rest under "All fields".
 * Each comes back in its own type (core/cards applyEdits); "Edit raw" is the
 * args as JSON, checked to be an object. The server checks it again.
 */
export function CardEdit({ plan, args, busy, onCancel, onApprove }: { plan: CardPlan; args: Args; busy: boolean; onCancel: () => void; onApprove: (args: Args) => void }) {
  const placed = [...plan.target, ...(plan.subject ? [plan.subject] : []), ...(plan.body ? [plan.body] : []), ...plan.chips]
  const keys = plan.layout === 'generic' ? [...placed, ...plan.rest] : placed
  const restKeys = plan.layout === 'generic' ? [] : plan.rest
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(args).map((k) => [k, editText(args[k], plan.edit[k])])))
  const [raw, setRaw] = useState<string | null>(null)
  const [showRest, setShowRest] = useState(false)
  const [bad, setBad] = useState<string | null>(null)
  const set = (k: string) => (v: string) => {
    setValues((s) => ({ ...s, [k]: v }))
    setBad(null)
  }

  function approve() {
    if (raw !== null) {
      try {
        const v = JSON.parse(raw) as unknown
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the args must be a JSON object')
        return onApprove(v as Args)
      } catch (err) {
        return setBad(err instanceof Error ? err.message : String(err))
      }
    }
    const r = applyEdits(args, plan.edit, values)
    if (!r.ok) return setBad(r.error)
    onApprove(r.args)
  }

  // The text a person reads takes the focus; with none, the first field does.
  const focus = plan.body ?? plan.subject ?? keys[0]
  const field = (k: string) => <FieldInput key={k} k={k} label={plan.labels[k] ?? k} edit={plan.edit[k] ?? 'line'} value={values[k] ?? ''} onChange={set(k)} first={k === focus} />
  return (
    <div className="aedit cEdit">
      {raw !== null ? (
        <textarea
          className="ajsonEdit mono"
          value={raw}
          spellCheck={false}
          autoFocus
          rows={Math.min(18, raw.split('\n').length + 1)}
          onChange={(e) => {
            setRaw(e.target.value)
            setBad(null)
          }}
          aria-label="Arguments as JSON"
        />
      ) : (
        <>
          {keys.map(field)}
          {restKeys.length > 0 &&
            (showRest ? (
              restKeys.map(field)
            ) : (
              <button type="button" className="alink mute cMore" onClick={() => setShowRest(true)}>
                All fields ({restKeys.length} more)
              </button>
            ))}
        </>
      )}
      {bad && <div className="astubErr">{bad}</div>}
      <div className="averbs">
        <button type="button" className="btn sm primary" disabled={busy} onClick={approve}>
          <Check size={12} aria-hidden="true" /> {plan.verb} edited
        </button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn sm ghost amore"
          onClick={() => {
            setBad(null)
            // Raw starts from your field edits when they hold together, else from the draft.
            const edited = applyEdits(args, plan.edit, values)
            setRaw((r) => (r === null ? JSON.stringify(edited.ok ? edited.args : args, null, 2) : null))
          }}
        >
          {raw === null ? 'Edit raw' : 'Edit fields'}
        </button>
      </div>
    </div>
  )
}
