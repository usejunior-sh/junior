/**
 * Junior's face (.docs/junior-goals-teams/junior-face.js, ported): a soft slab
 * with a darker underside, two pill eyes and two brows. Expressions are
 * states — hello, listen, think, working, needs, done, stuck, asleep — and
 * ease into each other.
 *
 * Motion: `follow` tracks the pointer (the Junior page only), `wander`
 * glances and blinks, `still` moves only when the mood changes (the rail).
 * Reduced motion turns all of it off. The face is the same at every size;
 * only its lines thicken below ~24px so the brows never thin out of sight.
 *
 * React renders the skeleton once; one shared animation frame loop moves
 * every face that needs it, writing attributes directly, so a face never
 * re-renders React at 60fps.
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { MOOD_LABEL, type Mood } from '../../../core/junior/mood.js'
import { usePersona } from '../junior.js'

const BACK = 'M22 15 C44 11 70 11 88 17 C97 20 99 30 99 46 C99 64 98 80 92 89 C88 96 78 97 58 97 C38 97 24 97 17 91 C11 85 10 69 10 51 C10 33 12 19 22 15 Z'
const FRONT = 'M17 9 C39 5 65 5 83 11 C92 14 94 23 94 39 C94 57 93 73 87 82 C83 89 73 90 53 90 C33 90 19 90 12 84 C6 78 5 62 5 44 C5 26 7 13 17 9 Z'

type Eye = { x: number; y: number; w: number; h: number; rot: number }
type Brow = { x1: number; y1: number; x2: number; y2: number; bend: number }
type Geo = { eyes: [Eye, Eye]; brows: [Brow, Brow]; happy: number }

const E = (x: number, y: number, w: number, h: number, rot = 0): Eye => ({ x, y, w, h, rot })
const B = (x1: number, y1: number, x2: number, y2: number, bend = -2): Brow => ({ x1, y1, x2, y2, bend })

const MOODS: Record<Mood, Geo> = {
  hello: { happy: 0, eyes: [E(37, 56, 13, 16), E(63, 56, 13, 16)], brows: [B(29, 41, 44, 40), B(56, 40, 71, 41)] },
  listen: { happy: 0, eyes: [E(37, 52, 14.5, 18.5), E(63, 52, 14.5, 18.5)], brows: [B(29, 37, 44, 36), B(56, 36, 71, 37)] },
  think: { happy: 0, eyes: [E(42, 51, 11.5, 14.5), E(68, 51, 11.5, 14.5)], brows: [B(31, 42, 46, 42, 0), B(58, 37, 73, 33, -3)] },
  working: { happy: 0, eyes: [E(37, 57, 18, 10, -4), E(63, 57, 18, 10, 4)], brows: [B(28, 43, 44, 46, 0), B(56, 46, 72, 43, 0)] },
  needs: { happy: 0, eyes: [E(37, 56, 14, 18.5), E(63, 55, 7.5, 19, 0)], brows: [B(29, 41, 44, 41), B(56, 35, 71, 31, -4)] },
  done: { happy: 1, eyes: [E(37, 57, 16, 4), E(63, 57, 16, 4)], brows: [B(29, 40, 44, 39), B(56, 39, 71, 40)] },
  stuck: { happy: 0, eyes: [E(37, 58, 11, 13), E(63, 58, 11, 13)], brows: [B(28, 44, 44, 37, -1), B(56, 37, 72, 44, -1)] },
  asleep: { happy: 0, eyes: [E(37, 59, 15, 3.6), E(63, 59, 15, 3.6)], brows: [B(29, 46, 44, 46, 0), B(56, 46, 71, 46, 0)] },
}

const clone = (g: Geo): Geo => ({ happy: g.happy, eyes: [{ ...g.eyes[0] }, { ...g.eyes[1] }], brows: [{ ...g.brows[0] }, { ...g.brows[1] }] })

// ---------------------------------------------------------------------------
// Colour: the persona's body colour; underside and brows derived from it.
// ---------------------------------------------------------------------------

function hexToHsl(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  const d = mx - mn
  let hh = 0
  let s = 0
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1))
    hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    hh *= 60
    if (hh < 0) hh += 360
  }
  return [hh, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Body, underside, brows and eyes from one colour. */
export function facePalette(body: string) {
  const [h, s, l] = hexToHsl(/^#[0-9a-f]{6}$/i.test(body) ? body : '#b4a0f4')
  return {
    body,
    edge: hslToHex(h, clamp(s * 0.72, 0, 1), clamp(l * 0.6, 0.14, 0.5)),
    brow: hslToHex(h, clamp(s * 0.55, 0, 1), clamp(l - 0.2, 0.2, 0.6)),
    eye: '#0d0b14',
  }
}

// ---------------------------------------------------------------------------
// Motion: one loop for every face on the page.
// ---------------------------------------------------------------------------

export type FaceMotion = 'follow' | 'wander' | 'still'

const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
const reduced = () => reduceQuery?.matches ?? false

let pointer: { x: number; y: number; t: number } | null = null
let pointerBound = false
function bindPointer() {
  if (pointerBound) return
  pointerBound = true
  addEventListener('pointermove', (e) => (pointer = { x: e.clientX, y: e.clientY, t: performance.now() }), { passive: true })
}

type Els = { svg: SVGSVGElement; back: SVGPathElement; front: SVGPathElement; face: SVGGElement; eyes: SVGRectElement[]; arcs: SVGPathElement[]; brows: SVGPathElement[] }

/** One face's state: where it is, where it's going, where it looks. */
class FaceCtl {
  cur: Geo
  target: Geo
  gaze = { x: 0, y: 0 }
  aim = { x: 0, y: 0 }
  /** where to look instead of the pointer (-1…1 each way), or null */
  look: { x: number; y: number } | null = null
  /** how far the eyes travel when they look somewhere (1 = the Junior page's) */
  reach = 1
  /** eyes and brows scaled about the face's centre (1 = the Junior page's); small faces read better bigger */
  features = 1
  nextGlance = performance.now() + 800 + Math.random() * 2000
  blinkAt = performance.now() + 1500 + Math.random() * 3000
  blinkP = -1
  constructor(
    public els: Els,
    mood: Mood,
    public motion: FaceMotion,
  ) {
    this.cur = clone(MOODS[mood])
    this.target = MOODS[mood]
  }

  setMood(m: Mood) {
    this.target = MOODS[m]
    if (reduced()) {
      this.cur = clone(this.target)
      this.render()
    } else wake(this)
  }

  /** One frame; false = settled, and the loop can drop this face until it changes again. */
  tick(now: number, dt: number): boolean {
    const t = this.target
    const k = 1 - Math.exp(-dt * 11)
    let moving = false
    const ease = <T extends Record<string, number>>(a: T, b: T, keys: (keyof T)[]) => {
      for (const f of keys) {
        const d = b[f] - a[f]
        if (Math.abs(d) > 0.01) moving = true
        ;(a[f] as number) += d * k
      }
    }
    for (let i = 0; i < 2; i++) {
      ease(this.cur.eyes[i], t.eyes[i], ['x', 'y', 'w', 'h', 'rot'])
      ease(this.cur.brows[i], t.brows[i], ['x1', 'y1', 'x2', 'y2', 'bend'])
    }
    const dh = t.happy - this.cur.happy
    if (Math.abs(dh) > 0.005) moving = true
    this.cur.happy += dh * k

    const still = this.motion === 'still' || reduced()
    if (!still && this.look) {
      this.aim = { ...this.look }
    } else if (!still && this.motion === 'follow' && pointer && now - pointer.t < 2500) {
      const r = this.els.svg.getBoundingClientRect()
      const dx = pointer.x - (r.left + r.width / 2)
      const dy = pointer.y - (r.top + r.height / 2)
      const d = Math.hypot(dx, dy) || 1
      const m = Math.min(1, d / 420)
      this.aim = { x: (dx / d) * m, y: (dy / d) * m * 0.8 }
    } else if (!still && now > this.nextGlance) {
      const spots = [[0, 0], [0, 0], [-0.9, 0.15], [0.9, -0.05], [0.6, -0.6], [-0.55, 0.5], [0.2, 0.7]]
      const [x, y] = spots[Math.floor(Math.random() * spots.length)]
      this.aim = { x, y }
      this.nextGlance = now + 1800 + Math.random() * 3200
    }
    if (still) this.aim = { x: 0, y: 0 }
    const g = 1 - Math.exp(-dt * 7)
    this.gaze.x += (this.aim.x - this.gaze.x) * g
    this.gaze.y += (this.aim.y - this.gaze.y) * g
    if (Math.abs(this.aim.x - this.gaze.x) > 0.002 || Math.abs(this.aim.y - this.gaze.y) > 0.002) moving = true
    if (!still) {
      if (this.blinkP < 0 && now > this.blinkAt) this.blinkP = 0
      if (this.blinkP >= 0) {
        this.blinkP += dt / 0.14
        if (this.blinkP >= 1) {
          this.blinkP = -1
          this.blinkAt = now + 3000 + Math.random() * 3000
        }
      }
    }
    this.render()
    return !still || moving
  }

  render() {
    const { els } = this
    const gx = this.gaze.x
    const gy = this.gaze.y
    const k = this.features
    // Scaled about (50, 52), between the eyes and the brows, so the features grow in place.
    const grow = k === 1 ? '' : ` translate(50 52) scale(${k}) translate(-50 -52)`
    els.face.setAttribute('transform', `translate(${gx * 10 * this.reach} ${gy * 7 * this.reach})${grow}`)
    els.front.setAttribute('transform', `translate(${gx * 3} ${gy * 2})`)
    els.back.setAttribute('transform', `translate(${-gx * 4} ${-gy * 3})`)
    const blink = this.blinkP >= 0 ? 1 - 0.88 * Math.sin(Math.PI * this.blinkP) : 1
    this.cur.eyes.forEach((e, i) => {
      const side = i === 0 ? -1 : 1
      const persp = 1 + side * gx * 0.1
      const w = e.w * persp
      const h = Math.max(2.2, e.h * persp * blink)
      const { x, y } = e
      const el = els.eyes[i]
      el.setAttribute('x', String(x - w / 2))
      el.setAttribute('y', String(y - h / 2))
      el.setAttribute('width', String(w))
      el.setAttribute('height', String(h))
      el.setAttribute('rx', String(Math.min(w, h) / 2))
      el.setAttribute('transform', `rotate(${e.rot} ${x} ${y})`)
      el.setAttribute('opacity', String(1 - this.cur.happy))
      const s = 8 * 0.75
      const a = els.arcs[i]
      a.setAttribute('d', `M${x - s} ${y + 3} Q${x} ${y - 7 * 0.8} ${x + s} ${y + 3}`)
      a.setAttribute('opacity', String(this.cur.happy))
    })
    els.brows.forEach((el, i) => {
      const b = this.cur.brows[i]
      el.setAttribute('d', `M${b.x1} ${b.y1} Q${(b.x1 + b.x2) / 2} ${(b.y1 + b.y2) / 2 + b.bend} ${b.x2} ${b.y2}`)
    })
  }
}

const active = new Set<FaceCtl>()
let frame = 0
let last = 0

function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  for (const f of active) if (!f.tick(now, dt)) active.delete(f)
  frame = active.size ? requestAnimationFrame(loop) : 0
}

function wake(f: FaceCtl) {
  active.add(f)
  if (!frame) {
    last = performance.now()
    frame = requestAnimationFrame(loop)
  }
}

type Props = {
  mood?: Mood
  /** px, square */
  size?: number
  motion?: FaceMotion
  /** override the persona's colour (the About me swatches preview) */
  colour?: string
  /** decorative = hidden from assistive tech (a label beside it already names it) */
  decorative?: boolean
  /** look here instead of at the pointer: x, y in -1…1 (down = +y); null = back to the pointer */
  look?: { x: number; y: number } | null
  /** how far the eyes travel when they look somewhere; 1 = the Junior page's, more for small faces */
  reach?: number
  /** eyes and brows scaled about the face's centre; 1 = the Junior page's, more for small faces */
  features?: number
  className?: string
}

/** Junior's face at any size. Colour and name come from the workspace's persona. */
export const JuniorFace = memo(function JuniorFace({ mood = 'hello', size = 40, motion = 'wander', colour, decorative, className, look = null, reach = 1, features = 1 }: Props) {
  const persona = usePersona()
  const svg = useRef<SVGSVGElement>(null)
  const ctl = useRef<FaceCtl | null>(null)
  const p = facePalette(colour ?? persona.colour)
  // Lines in viewBox units, never thinner than about one screen pixel.
  const line = Math.max(4.4, 112 / size)

  // Build the controller once the skeleton is in the DOM (before paint, so the
  // eyes never flash empty); drop it with the face.
  useLayoutEffect(() => {
    const el = svg.current
    if (!el) return
    const q = <T extends Element>(sel: string) => [...el.querySelectorAll<T & Element>(sel)] as T[]
    const els: Els = {
      svg: el,
      back: el.querySelector<SVGPathElement>('[data-part="back"]')!,
      front: el.querySelector<SVGPathElement>('[data-part="front"]')!,
      face: el.querySelector<SVGGElement>('[data-part="face"]')!,
      eyes: q<SVGRectElement>('[data-part="eye"]'),
      arcs: q<SVGPathElement>('[data-part="arc"]'),
      brows: q<SVGPathElement>('[data-part="brow"]'),
    }
    const c = new FaceCtl(els, mood, motion)
    ctl.current = c
    c.render()
    if (motion !== 'still' && !reduced()) {
      if (motion === 'follow') bindPointer()
      wake(c)
    }
    return () => {
      active.delete(c)
      ctl.current = null
    }
    // the mood is applied by the effect below; a new size or motion is a new face
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motion])

  useEffect(() => {
    ctl.current?.setMood(mood)
  }, [mood])

  useEffect(() => {
    const c = ctl.current
    if (!c) return
    c.reach = reach
    c.features = features
    c.render()
  }, [reach, features, motion])

  const lx = look?.x
  const ly = look?.y
  useEffect(() => {
    const c = ctl.current
    if (!c) return
    c.look = lx === undefined || ly === undefined ? null : { x: lx, y: ly }
    if (!reduced()) wake(c)
  }, [lx, ly])

  const label = `${persona.name}, ${MOOD_LABEL[mood].toLowerCase()}`
  return (
    <svg
      ref={svg}
      className={className}
      viewBox="-4 -4 112 110"
      width={size}
      height={size}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      style={{ overflow: 'visible', display: 'block', flex: 'none' }}
    >
      <path data-part="back" d={BACK} fill={p.edge} />
      <path data-part="front" d={FRONT} fill={p.body} />
      <g data-part="face">
        {[0, 1].map((i) => <path key={`b${i}`} data-part="brow" fill="none" strokeWidth={line} strokeLinecap="round" stroke={p.brow} />)}
        {[0, 1].map((i) => <rect key={`e${i}`} data-part="eye" fill={p.eye} />)}
        {[0, 1].map((i) => <path key={`a${i}`} data-part="arc" fill="none" strokeWidth={line + 0.2} strokeLinecap="round" stroke={p.eye} opacity={0} />)}
      </g>
    </svg>
  )
})
