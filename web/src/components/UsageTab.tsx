/**
 * Usage: what Claude Code has cost on this machine.
 *
 * The numbers come from Claude Code's own transcripts (see `core/usage/`), so
 * this covers every session on the machine, not only the ones started here.
 * Cost is derived from API list prices: on a subscription it is what the same
 * tokens would have cost, which the footnote says out loud rather than
 * dressing an estimate up as a bill. The login filter narrows it to one
 * claude.ai login or one API key (server/usage/logins.ts says how a session
 * is matched to its login).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { USAGE_WINDOWS, type UsageLogin, type UsageResponse, type UsageSummary } from '../../../shared/protocol.js'
import { MAX_SERIES, OTHER, OTHER_KEY, SERIES, modelLabel, money, tokens } from '../usageFormat.js'
import { Select, SelectGroup, SelectItem, SelectLabel, SelectSeparator } from '../ui/Select.js'

type Metric = 'cost' | 'tokens'

const compactMoney = (n: number) =>
  n >= 1000 ? `$${Math.round(n / 100) / 10}k` : n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(1)}`

const count = (n: number) => n.toLocaleString()

/** `2026-09-11` → `Sep 11`. Parsed as local, which is how it was bucketed. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** `/Users/you/Code/x` → `~/Code/x`. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/** The login last picked, '' = all of them. */
const LOGIN_KEY = 'junior.usageLogin'

function readLogin(): string {
  try {
    return localStorage.getItem(LOGIN_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveLogin(id: string) {
  try {
    if (id) localStorage.setItem(LOGIN_KEY, id)
    else localStorage.removeItem(LOGIN_KEY)
  } catch {
    // private mode: the pick lasts this visit
  }
}

export function UsageTab({ refreshNonce }: { refreshNonce: number }) {
  const [days, setDays] = useState<number>(30)
  const [metric, setMetric] = useState<Metric>('cost')
  const [login, setLogin] = useState(readLogin)
  const [logins, setLogins] = useState<UsageLogin[]>([])
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    void fetch(`/api/usage?days=${days}${login ? `&login=${encodeURIComponent(login)}` : ''}`)
      .then((r) => r.json() as Promise<UsageResponse>)
      .then((b) => {
        if (!live) return
        if (!b.ok) return setError(b.error)
        setUsage(b.usage)
        setLogins(b.logins)
        // A login that no longer exists (its workspace went) reads as all of them.
        if ((b.login ?? '') !== login) pickLogin(b.login ?? '')
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [days, login, refreshNonce])

  function pickLogin(id: string) {
    setLogin(id)
    saveLogin(id)
  }

  // Colour is owned by the model, in one fixed order, a narrower window that
  // drops a model must not repaint the ones that remain. Past the sixth hue
  // the tail stacks as one "Other" band rather than inventing colours.
  const colors = useMemo(() => {
    const map = new Map<string, string>([[OTHER_KEY, OTHER]])
    usage?.models.forEach((m, i) => map.set(m.model, i < MAX_SERIES ? SERIES[i] : OTHER))
    return map
  }, [usage])

  const series = useMemo(() => {
    const all = (usage?.models ?? []).map((m) => m.model)
    return all.length > MAX_SERIES ? [...all.slice(0, MAX_SERIES), OTHER_KEY] : all
  }, [usage])

  const tail = useMemo(() => (usage?.models ?? []).slice(MAX_SERIES).map((m) => m.model), [usage])

  if (error) return <div className="usageEmpty">Couldn’t read usage — {error}</div>
  if (!usage && loading) return <div className="pickerLoading">Reading transcripts…</div>
  if (!usage) return null

  const { totals } = usage
  const picked = logins.find((l) => l.id === login)
  const accounts = logins.filter((l) => l.kind === 'account')
  const keys = logins.filter((l) => l.kind === 'api-key')
  const perDay = totals.cost / Math.max(usage.days, 1)
  const cacheShare =
    totals.cacheRead + totals.input + totals.cacheWrite > 0
      ? totals.cacheRead / (totals.cacheRead + totals.input + totals.cacheWrite)
      : 0

  return (
    <div className="usage">
      <div className="usageBar">
        <div className="segmented" role="group" aria-label="Time window">
          {USAGE_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={days === w ? 'on' : ''}
              aria-pressed={days === w}
              onClick={() => setDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Measure">
          <button
            type="button"
            className={metric === 'cost' ? 'on' : ''}
            aria-pressed={metric === 'cost'}
            onClick={() => setMetric('cost')}
          >
            Cost
          </button>
          <button
            type="button"
            className={metric === 'tokens' ? 'on' : ''}
            aria-pressed={metric === 'tokens'}
            onClick={() => setMetric('tokens')}
          >
            Tokens
          </button>
        </div>
        {logins.length > 1 && (
          <Select className="usageLogin" contentClassName="usageLoginMenu" value={login} onValueChange={pickLogin} aria-label="Login">
            <SelectItem value="">All logins</SelectItem>
            <SelectSeparator />
            {[
              { cap: 'claude.ai logins', rows: accounts },
              { cap: 'API keys', rows: keys },
            ].map(
              ({ cap, rows }) =>
                rows.length > 0 && (
                  <SelectGroup key={cap}>
                    <SelectLabel>{cap}</SelectLabel>
                    {rows.map((l) => (
                      <SelectItem key={l.id} value={l.id} description={[l.detail, money(l.cost)].filter(Boolean).join(' · ')}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ),
            )}
          </Select>
        )}
        <span className="usageRange">
          {loading ? 'refreshing…' : `${dayLabel(usage.from)} – ${dayLabel(usage.to)}`}
        </span>
      </div>

      {totals.messages === 0 ? (
        <div className="usageEmpty">{picked ? 'Nothing ran on this login in this window.' : 'No Claude Code usage in this window.'}</div>
      ) : (
        <>
          <div className="tiles">
            <Tile label="Spend" value={money(totals.cost)} sub={`${money(perDay)} a day`} />
            <Tile label="Tokens" value={tokens(totals.tokens)} sub={`${count(totals.messages)} messages`} />
            <Tile label="Sessions" value={count(totals.sessions)} sub={`${usage.projects.length} projects`} />
            <Tile
              label="From cache"
              value={`${Math.round(cacheShare * 100)}%`}
              sub={`${tokens(totals.cacheRead)} read back`}
            />
          </div>

          <DailyChart usage={usage} metric={metric} series={series} tail={tail} colors={colors} />

          <Legend series={series} tail={tail} colors={colors} />

          <section className="usageSection">
            <h3>By model</h3>
            <table className="usageTable">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="n">Messages</th>
                  <th className="n">Input</th>
                  <th className="n">Output</th>
                  <th className="n">Cache w / r</th>
                  <th className="n">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.models.map((m) => (
                  <tr key={m.model}>
                    <td>
                      <span className="swatch" style={{ background: colors.get(m.model) }} aria-hidden="true" />
                      {modelLabel(m.model)}
                      {!m.priced && <span className="unpriced">no price</span>}
                    </td>
                    <td className="n">{count(m.messages)}</td>
                    <td className="n">{tokens(m.input)}</td>
                    <td className="n">{tokens(m.output)}</td>
                    <td className="n">
                      {tokens(m.cacheWrite)} / {tokens(m.cacheRead)}
                    </td>
                    <td className="n strong">{m.priced ? money(m.cost) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="usageSection">
            <h3>By project</h3>
            <table className="usageTable">
              <thead>
                <tr>
                  <th>Folder</th>
                  <th className="n">Sessions</th>
                  <th className="n">Tokens</th>
                  <th className="n">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.projects.slice(0, 12).map((p) => (
                  <tr key={p.path}>
                    <td className="path" title={p.path}>
                      {homely(p.path)}
                    </td>
                    <td className="n">{count(p.sessions)}</td>
                    <td className="n">{tokens(p.tokens)}</td>
                    <td className="n strong">{money(p.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <p className="usageFoot">
        {picked?.kind === 'api-key' ? (
          <>
            Only sessions on this API key. Cost is at API list prices, which is how a key is billed. Older
            sessions count under the key their workspace uses now.
          </>
        ) : picked ? (
          <>
            Only sessions on this claude.ai login{picked.id === 'machine' ? ', including ones started outside Junior' : ''}.
            Cost is the API list price of the same work, not a bill.
          </>
        ) : (
          <>
            Read from Claude Code’s own transcripts, so this counts every session on this machine — including
            ones started outside Junior. Cost is calculated from API list prices; on a Pro or Max plan nothing
            is billed per token, so read it as what the same work would have cost on the API.
          </>
        )}
        {usage.unpricedModels.length > 0 && (
          <>
            {' '}
            No price on file for {usage.unpricedModels.join(', ')} — its tokens are counted, its cost is not.
          </>
        )}{' '}
        <span className="dim">
          {usage.scan.files} transcripts · {usage.scan.reread} re-read · {usage.scan.ms}ms
        </span>
      </p>
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <span className="tileLabel">{label}</span>
      <span className="tileValue">{value}</span>
      <span className="tileSub">{sub}</span>
    </div>
  )
}

function Legend({
  series,
  tail,
  colors,
}: {
  series: string[]
  tail: string[]
  colors: Map<string, string>
}) {
  if (series.length < 2) return null
  return (
    <div className="usageLegend">
      {series.map((m) => (
        <span key={m} className="key" title={m === OTHER_KEY ? tail.map(modelLabel).join(', ') : m}>
          <span className="swatch" style={{ background: colors.get(m) }} aria-hidden="true" />
          {modelLabel(m)}
          {m === OTHER_KEY && <span className="n"> ×{tail.length}</span>}
        </span>
      ))}
    </div>
  )
}

const H = 176
const PAD = { top: 10, right: 6, bottom: 20, left: 46 }
/** `.chartHost`'s own left padding: the tooltip is positioned against it. */
const HOST_PAD = 12
const BAR_MAX = 24
/** A 2px gap in the surface colour separates stacked segments. */
const GAP = 2

/**
 * The smallest round number above the tallest column. A coarse 1/2/5 ladder
 * would put a $260 peak under a $500 ceiling and waste half the plot, so the
 * ladder is fine enough to sit just above the data, and every step halves
 * cleanly, because the middle gridline is the midpoint.
 */
const LADDER = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
function niceMax(v: number): number {
  if (v <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(v))
  const n = v / pow
  return (LADDER.find((step) => n <= step) ?? 10) * pow
}

function DailyChart({
  usage,
  metric,
  series,
  tail,
  colors,
}: {
  usage: UsageSummary
  metric: Metric
  series: string[]
  tail: string[]
  colors: Map<string, string>
}) {
  const host = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)

  // Measure before the first paint: an observer alone leaves one frame at
  // the fallback width, which is a visibly short chart on open.
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const measure = (w: number) => setWidth((prev) => (w > 0 && Math.abs(w - prev) > 1 ? Math.max(320, w) : prev))
    measure(el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) * 2)
    const ro = new ResizeObserver(([entry]) => measure(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const valueOf = (day: UsageSummary['daily'][number]) => (metric === 'cost' ? day.cost : day.tokens)
  /** One band's value: the Other band is the sum of everything past the sixth. */
  const valueFor = (day: UsageSummary['daily'][number], model: string) =>
    model === OTHER_KEY
      ? tail.reduce((sum, id) => sum + (day.byModel[id]?.[metric] ?? 0), 0)
      : (day.byModel[model]?.[metric] ?? 0)
  const format = metric === 'cost' ? money : tokens
  const tick = metric === 'cost' ? compactMoney : tokens

  const rows = usage.daily
  const top = niceMax(Math.max(...rows.map(valueOf), 0))
  const plotW = width - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const band = plotW / Math.max(rows.length, 1)
  const barW = Math.min(BAR_MAX, Math.max(3, band - 6))
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH
  // Label every nth day, always including the last, a 90-day window can't
  // carry 90 legible dates. A regular tick too near the last one is dropped
  // rather than allowed to collide with it.
  const every = Math.max(1, Math.ceil(rows.length / 8))
  const last = rows.length - 1
  const labelled = (i: number) => i === last || (i % every === 0 && last - i >= every / 2)

  const active = hover !== null ? rows[hover] : null
  const tipX = hover === null ? 0 : HOST_PAD + PAD.left + (hover + 0.5) * band

  return (
    <div className="chartHost" ref={host}>
      <svg width={width} height={H} role="img" aria-label={`Daily ${metric} by model`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(top * f)}
              y2={y(top * f)}
              className="grid"
            />
            <text x={PAD.left - 8} y={y(top * f) + 3} className="axis end">
              {f === 0 ? (metric === 'cost' ? '$0' : '0') : tick(top * f)}
            </text>
          </g>
        ))}

        {rows.map((day, i) => {
          const x = PAD.left + i * band + (band - barW) / 2
          let cursor = y(0)
          const stack = series
            .map((model) => ({ model, value: valueFor(day, model) }))
            .filter((s) => s.value > 0)
          return (
            <g key={day.date}>
              {stack.map(({ model, value }, si) => {
                const full = (value / top) * plotH
                // The gap is taken off the top of every segment but the first,
                // so the stack keeps its true height at the baseline.
                const h = Math.max(1, full - (si > 0 ? GAP : 0))
                cursor -= full
                const topmost = si === stack.length - 1
                const r = Math.min(4, h / 2, barW / 2)
                const yTop = cursor + (si > 0 ? GAP : 0)
                return (
                  <path
                    key={model}
                    className="bar"
                    fill={colors.get(model)}
                    d={
                      topmost
                        ? `M${x},${yTop + h} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`
                        : `M${x},${yTop} h${barW} v${h} h${-barW} z`
                    }
                  />
                )
              })}
              {labelled(i) ? (
                <text
                  x={i === last ? Math.min(x + barW / 2, width - PAD.right) : x + barW / 2}
                  y={H - 6}
                  className={'axis ' + (i === last ? 'end' : 'mid')}
                >
                  {dayLabel(day.date)}
                </text>
              ) : null}
              {/* A full-height hit target: the bars themselves are too thin. */}
              <rect
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={plotH}
                className={'hit' + (hover === i ? ' on' : '')}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              />
            </g>
          )
        })}
      </svg>

      {active && (
        <div
          className="chartTip"
          style={{ left: Math.min(Math.max(tipX, 88), width - 88) }}
        >
          <div className="tipHead">
            <b>{dayLabel(active.date)}</b>
            <span>{format(valueOf(active))}</span>
          </div>
          {series
            .map((model) => ({ model, value: valueFor(active, model) }))
            .filter((s) => s.value > 0)
            .reverse()
            .map(({ model, value }) => (
              <div className="tipRow" key={model}>
                <span className="swatch" style={{ background: colors.get(model) }} aria-hidden="true" />
                <span className="name">{modelLabel(model)}</span>
                <span className="v">{format(value)}</span>
              </div>
            ))}
          {valueOf(active) === 0 && <div className="tipRow dim">nothing ran</div>}
        </div>
      )}
    </div>
  )
}
