/**
 * The pane's moving parts that aren't drawing: where the stage is (the native
 * view follows it), how wide the pane is (dragged from its left edge), and
 * whether Junior is driving (steps.ts says what it is doing).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type MutableRefObject } from 'react'
import { browserBridge, type PaneRect } from '../../browser.js'

/** Things of ours that float, and so would end up hidden under the native view. */
const FLOATING = '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/**
 * Where the stage is, reported to Junior.app so the page sits on it. Null
 * while it is hidden, collapsed, covered by one of our popovers, or `hidden`
 * (our own error page, a drag of the split). `inset` shrinks the rect, so a
 * ring drawn on the stage stays outside the page; `bottom` keeps a strip
 * under the page free (the emulated size's caption). `covered` says a
 * popover is why the page is away, so the pane can show its frozen frame.
 */
export function useStageRect(tabKey: string, hidden: boolean, inset: number, bottom = 0, capturing?: MutableRefObject<Promise<unknown> | null>) {
  const ref = useRef<HTMLDivElement>(null)
  const [covered, setCovered] = useState(false)
  const opts = useRef({ hidden, inset, bottom })
  opts.current = { hidden, inset, bottom }
  const reportRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !browserBridge) return
    let last = ''
    const report = () => {
      // Never past the window: the native view would draw outside it.
      const b = el.getBoundingClientRect()
      const right = Math.min(b.right, document.documentElement.clientWidth)
      const low = Math.min(b.bottom, document.documentElement.clientHeight)
      const r = new DOMRect(b.left, b.top, Math.max(0, right - b.left), Math.max(0, low - b.top))
      const { hidden, inset, bottom } = opts.current
      // A dialog the pane sits in (a job run being watched) doesn't cover it.
      const cover = [...document.querySelectorAll(FLOATING)].some((f) => !el.contains(f) && !f.contains(el) && overlaps(f.getBoundingClientRect(), r))
      setCovered(cover)
      // The frozen frame is still being taken: the page stays put until it is, then goes.
      const shot = capturing?.current
      if (cover && shot) {
        void shot.finally(() => {
          if (capturing.current === shot) capturing.current = null
          report()
        })
        return
      }
      const rect: PaneRect | null =
        hidden || cover || r.width < 40 || r.height < 40 || document.visibilityState !== 'visible'
          ? null
          : {
              x: Math.round(r.left + inset),
              y: Math.round(r.top + inset),
              width: Math.round(r.width - inset * 2),
              height: Math.round(r.height - inset * 2 - bottom),
            }
      const key = JSON.stringify(rect)
      if (key === last) return
      last = key
      browserBridge!.setPane(tabKey, rect)
    }
    reportRef.current = report
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    const mo = new MutationObserver(report)
    mo.observe(document.body, { childList: true, subtree: false })
    window.addEventListener('resize', report)
    document.addEventListener('visibilitychange', report)
    // Panels next to us can move the stage without resizing it.
    const tick = setInterval(report, 400)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', report)
      document.removeEventListener('visibilitychange', report)
      clearInterval(tick)
      reportRef.current = () => {}
      browserBridge!.setPane(null, null)
    }
  }, [tabKey])
  useLayoutEffect(() => reportRef.current(), [hidden, inset, bottom])
  return { ref, covered }
}

/**
 * The page as a picture, for while one of our menus hides the live view
 * (design §3.8): taken as the menu's trigger is pressed, so it is ready
 * before the menu paints, and dropped once the page is back.
 */
export function useFrozenFrame(tabKey: string, covered: boolean, capturing: MutableRefObject<Promise<unknown> | null>) {
  const [frame, setFrame] = useState<string | null>(null)
  useEffect(() => {
    if (!covered) setFrame(null)
  }, [covered])
  const freeze = useCallback(() => {
    if (!browserBridge?.capture) return
    // Never hold the page for long: a slow capture just means no frame.
    const shot = Promise.race([
      browserBridge.capture(tabKey).then((png) => setFrame(png ?? null), () => setFrame(null)),
      new Promise((r) => setTimeout(r, 250)),
    ])
    capturing.current = shot
  }, [tabKey, capturing])
  return { frame: covered ? frame : null, freeze }
}

// ── the split: the pane's width, dragged from its left edge ─────────────────

const WIDTH_KEY = 'junior.browserWidth'
const DEFAULT_FRACTION = 0.54
const PANE_MIN = 360
const CHAT_MIN = 380
const STEP = 24

function readFraction(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(n) && n > 0.1 && n < 0.95 ? n : DEFAULT_FRACTION
  } catch {
    return DEFAULT_FRACTION
  }
}

/**
 * The pane's share of the session row, per browser. A drag measures in pixels
 * (pane ≥ 360, chat ≥ 380) and stores a fraction, so a wider window keeps the
 * same split. `dragging` hides the page meanwhile: the pointer would vanish
 * into the native view the moment it crossed it.
 */
export function useSplit(pane: RefObject<HTMLElement | null>) {
  const [fraction, setFraction] = useState(readFraction)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; w: number; min: number; max: number; row: number } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(fraction * 1000) / 1000))
    } catch {
      // storage blocked: the split still applies for this page load
    }
  }, [fraction])

  useEffect(() => {
    document.body.classList.toggle('bpResizing', dragging)
    return () => document.body.classList.remove('bpResizing')
  }, [dragging])

  /** The pane's width now, how wide it may get, and the row it shares. */
  const measure = useCallback(() => {
    const el = pane.current
    const row = el?.parentElement
    if (!el || !row) return null
    const w = el.getBoundingClientRect().width
    const chat = (el.previousElementSibling as HTMLElement | null)?.getBoundingClientRect().width ?? 0
    const rowW = row.getBoundingClientRect().width
    // The floors give way on a narrow row, as the CSS does (session.css).
    return { w, min: Math.min(PANE_MIN, rowW * 0.5), max: w + Math.max(0, chat - Math.min(CHAT_MIN, rowW * 0.46)), row: rowW }
  }, [pane])

  const apply = useCallback((px: number, m: { min: number; max: number; row: number }) => {
    const w = Math.max(m.min, Math.min(m.max, px))
    if (m.row > 0) setFraction(w / m.row)
  }, [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      const m = measure()
      if (!m) return
      e.preventDefault()
      start.current = { x: e.clientX, ...m }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
    },
    [measure],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const s = start.current
      if (!s) return
      // The handle is on the pane's left edge: dragging left widens it.
      apply(s.w - (e.clientX - s.x), s)
    },
    [apply],
  )

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!start.current) return
    start.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // capture already gone
    }
    setDragging(false)
  }, [])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const m = measure()
      if (!m) return
      e.preventDefault()
      apply(m.w + (e.key === 'ArrowLeft' ? STEP : -STEP), m)
    },
    [measure, apply],
  )

  return {
    fraction,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: () => setFraction(DEFAULT_FRACTION),
    },
  }
}

// ── "Junior is driving" ─────────────────────────────────────────────────────

/** How long the strip stays after a browser call ends, so it doesn't flicker between calls. */
const DRIVE_TAIL_MS = 1500

/** True while Junior has a call on this tab, and for a moment after. */
export function useDriving(busy: boolean): boolean {
  const [driving, setDriving] = useState(busy)
  useEffect(() => {
    if (busy) {
      setDriving(true)
      return
    }
    const t = setTimeout(() => setDriving(false), DRIVE_TAIL_MS)
    return () => clearTimeout(t)
  }, [busy])
  return driving
}
