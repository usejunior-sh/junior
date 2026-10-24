/**
 * "Ready because…" as chips (.docs/overnight-2026-10-24/designs/ready-because-ui.md):
 * the four facts the babysit watch read on a PR (core/babysit/ready.ts), each
 * a small mono pill that links to its evidence on GitHub, so you don't open
 * the PR to check.
 *
 *   ReadyChips    the open card's Ready line: four linked pills, then the
 *                 evidence for any that aren't passing
 *   ReadySummary  the closed row's one inert pill: "Ready", or the first
 *                 thing left plus "+N". Inert because the row is a button
 *
 * Orange only on the `needs` tone: something left, on an item on Needs you.
 * The words, tones and links are decided in core; this file only draws them.
 */
import { Check, CircleDashed, X } from 'lucide-react'
import { chipHref, chipTone, readyLine, readySummary, showsEvidence, type ChipTone, type Readiness, type ReadyCheck } from '../../../core/babysit/ready.js'

const Glyph = ({ tone }: { tone: ChipTone }) => {
  const Icon = tone === 'ok' ? Check : tone === 'wait' ? CircleDashed : X
  return <Icon className="g" size={11} strokeWidth={2.25} aria-hidden="true" />
}

function Chip({ c, needsYou }: { c: ReadyCheck; needsYou: boolean }) {
  const tone = chipTone(c, needsYou)
  const href = chipHref(c)
  const body = (
    <>
      <Glyph tone={tone} />
      <span className="l">{c.label}</span>
    </>
  )
  if (!href)
    // no link to follow: the evidence line under the chips says it instead
    return (
      <span className={`rdyChip t-${tone}`} title={c.evidence}>
        {body}
      </span>
    )
  return (
    <a className={`rdyChip t-${tone}`} href={href} target="_blank" rel="noreferrer" title={c.evidence} aria-label={`${c.label}. ${c.evidence} Open on GitHub.`}>
      {body}
    </a>
  )
}

/**
 * The four chips in line order; `evidence` adds a sentence under them for
 * each one not passing. A chip with no link always shows its evidence, even
 * compact: a title alone never reaches a touch screen.
 */
export function ReadyChips({ ready, needsYou = false, evidence = true }: { ready: Readiness; needsYou?: boolean; evidence?: boolean }) {
  const lines = ready.checks.filter((c) => (evidence ? showsEvidence(c) : !chipHref(c)))
  return (
    <span className="rdyWrap">
      <ul className="rdy" role="list" aria-label={ready.ready ? 'Ready because' : 'Not ready'}>
        {ready.checks.map((c) => (
          <li key={c.id}>
            <Chip c={c} needsYou={needsYou} />
          </li>
        ))}
      </ul>
      {lines.map((c) => (
        <span key={c.id} className="rdyEv">
          {c.evidence}
        </span>
      ))}
    </span>
  )
}

/** The closed row's pill. Visual only: the row's own label carries the full line. */
export function ReadySummary({ ready }: { ready: Readiness }) {
  const s = readySummary(ready)
  return (
    <span className="rdySum">
      <span className={`rdyChip sm t-${s.tone}`} aria-hidden="true">
        <Glyph tone={s.tone} />
        <span className="l">{s.label}</span>
      </span>
      {s.more > 0 && (
        <span className="rdyMore" aria-hidden="true">
          +{s.more}
        </span>
      )}
      <span className="sr-only">{readyLine(ready)}</span>
    </span>
  )
}
