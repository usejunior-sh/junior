import { useEffect, useState } from 'react'
import * as Switch from '@radix-ui/react-switch'
import type { BabysitSettings } from '../../../../core/babysit/settings.js'
import { usePickableModels } from '../../models.js'
import { Select, SelectItem } from '../../ui/Select.js'
import { Row, Section } from './shared.js'

type Resp = { ok: true; settings: BabysitSettings } | { ok: false; error: string }

// Babysitting your PRs: on or off, the model per kind of task, and what it may spend.

export function BabysitTab() {
  const [s, setS] = useState<BabysitSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [task, setTask] = useState('')
  const [day, setDay] = useState('')
  const fixModels = usePickableModels(s?.models.fix)
  const rebaseModels = usePickableModels(s?.models.rebase)

  const apply = (b: Resp) => {
    if (!b.ok) return setError(b.error)
    setError(null)
    setS(b.settings)
    setTask(String(b.settings.budget.perTaskUsd))
    setDay(String(b.settings.budget.perDayUsd))
  }
  useEffect(() => {
    void fetch('/api/babysit/settings')
      .then((r) => r.json() as Promise<Resp>)
      .then(apply)
      .catch((e) => setError(String(e)))
  }, [])
  const save = (patch: Partial<BabysitSettings>) =>
    void fetch('/api/babysit/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      .then((r) => r.json() as Promise<Resp>)
      .then(apply)
      .catch((e) => setError(String(e)))

  const money = (v: string, key: 'perTaskUsd' | 'perDayUsd') => {
    const n = Number(v)
    if (s && Number.isFinite(n) && n > 0 && n <= 1000 && n !== s.budget[key]) save({ budget: { ...s.budget, [key]: n } })
    else if (s) (key === 'perTaskUsd' ? setTask : setDay)(String(s.budget[key]))
  }

  const modelPick = (label: string, key: 'fix' | 'rebase', options: ReturnType<typeof usePickableModels>) => (
    <Select className="setSelect" aria-label={label} value={s?.models[key] ?? ''} disabled={!s} onValueChange={(v) => s && save({ models: { ...s.models, [key]: v } })}>
      {options.map((m) => (
        <SelectItem key={m.id} value={m.id}>
          {m.name}
        </SelectItem>
      ))}
      {s && !options.some((m) => m.id === s.models[key]) && <SelectItem value={s.models[key]}>{s.models[key]}</SelectItem>}
    </Select>
  )

  return (
    <>
      <Section
        title="Your PRs"
        hint="Junior watches every PR you open in this workspace’s repos. It fixes red CI and bot comments, rebases, and pushes to your PR branch. It asks before requesting a reviewer."
      >
        <Row label="Babysit my PRs" hint="Off: nothing is read and nothing runs.">
          <Switch.Root className="uiSwitch" checked={s?.enabled ?? false} disabled={!s} onCheckedChange={(on) => save({ enabled: on })} aria-label="Babysit my PRs">
            <Switch.Thumb className="uiSwitchThumb" />
          </Switch.Root>
        </Row>
      </Section>
      <Section title="Models" hint="Each task is a short session on the model its kind calls for.">
        <Row label="CI and bot fixes" hint="Reading a failing log and fixing it.">
          {modelPick('Model for fixes', 'fix', fixModels)}
        </Row>
        <Row label="Rebases" hint="Rebasing on the base branch and checking again.">
          {modelPick('Model for rebases', 'rebase', rebaseModels)}
        </Row>
      </Section>
      <Section title="Budget" hint="A task stops at its cap. At the daily cap, Junior pauses and tells you; queued tasks wait for tomorrow or a higher cap.">
        <Row label="Per task (USD)">
          <input className="setNum" type="number" min={0.25} max={1000} step={0.25} value={task} disabled={!s} onChange={(e) => setTask(e.target.value)} onBlur={() => money(task, 'perTaskUsd')} />
        </Row>
        <Row label="Per day (USD)">
          <input className="setNum" type="number" min={1} max={1000} step={1} value={day} disabled={!s} onChange={(e) => setDay(e.target.value)} onBlur={() => money(day, 'perDayUsd')} />
        </Row>
        {error && <div className="msg error">{error}</div>}
      </Section>
    </>
  )
}
