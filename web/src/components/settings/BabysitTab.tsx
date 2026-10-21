import { useEffect, useState } from 'react'
import type { BabysitSettings } from '../../../../core/babysit/settings.js'
import { usePickableModels } from '../../models.js'
import { Select, SelectItem } from '../../ui/Select.js'
import { Row, Section } from './shared.js'

type Resp = { ok: true; settings: BabysitSettings } | { ok: false; error: string }

// Babysitting your PRs and first-pass reviews: the model per kind of task, and what it may spend. What it works on is what you hand off.

export function BabysitTab() {
  const [s, setS] = useState<BabysitSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [task, setTask] = useState('')
  const [day, setDay] = useState('')
  const [review, setReview] = useState('')
  const fixModels = usePickableModels(s?.models.fix)
  const rebaseModels = usePickableModels(s?.models.rebase)
  const reviewModels = usePickableModels(s?.models.review)

  const apply = (b: Resp) => {
    if (!b.ok) return setError(b.error)
    setError(null)
    setS(b.settings)
    setTask(String(b.settings.budget.perTaskUsd))
    setDay(String(b.settings.budget.perDayUsd))
    setReview(String(b.settings.budget.perReviewUsd))
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

  const money = (v: string, key: 'perTaskUsd' | 'perDayUsd' | 'perReviewUsd') => {
    const n = Number(v)
    if (s && Number.isFinite(n) && n > 0 && n <= 1000 && n !== s.budget[key]) save({ budget: { ...s.budget, [key]: n } })
    else if (s) ({ perTaskUsd: setTask, perDayUsd: setDay, perReviewUsd: setReview })[key](String(s.budget[key]))
  }

  const modelPick = (label: string, key: 'fix' | 'rebase' | 'review', options: ReturnType<typeof usePickableModels>) => (
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
        title="What Junior works on"
        hint="Only the PRs you hand off. Press Babysit on your PR, or First pass on a review request. Both are on the Junior page and on each PR’s page. Junior fixes red CI and bot comments, rebases, and pushes to your PR branch. It asks before it requests a reviewer or posts a review. Pause a PR to stop it."
      >
        {null}
      </Section>
      <Section title="Models" hint="Each task is a short session on the model its kind calls for.">
        <Row label="CI and bot fixes" hint="Reading a failing log and fixing it.">
          {modelPick('Model for fixes', 'fix', fixModels)}
        </Row>
        <Row label="Rebases" hint="Rebasing on the base branch and checking again.">
          {modelPick('Model for rebases', 'rebase', rebaseModels)}
        </Row>
        <Row label="Reviews" hint="Reading a PR that asks for your review.">
          {modelPick('Model for reviews', 'review', reviewModels)}
        </Row>
      </Section>
      <Section title="Budget" hint="A task stops at its cap. At the daily cap, Junior pauses and tells you; queued tasks wait for tomorrow or a higher cap.">
        <Row label="Per task (USD)">
          <input className="setNum" type="number" min={0.25} max={1000} step={0.25} value={task} disabled={!s} onChange={(e) => setTask(e.target.value)} onBlur={() => money(task, 'perTaskUsd')} />
        </Row>
        <Row label="Per review (USD)">
          <input className="setNum" type="number" min={0.25} max={1000} step={0.25} value={review} disabled={!s} onChange={(e) => setReview(e.target.value)} onBlur={() => money(review, 'perReviewUsd')} />
        </Row>
        <Row label="Per day (USD)">
          <input className="setNum" type="number" min={1} max={1000} step={1} value={day} disabled={!s} onChange={(e) => setDay(e.target.value)} onBlur={() => money(day, 'perDayUsd')} />
        </Row>
        {error && <div className="msg error">{error}</div>}
      </Section>
    </>
  )
}
