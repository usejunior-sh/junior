/**
 * Junior's face: the brand's J key (brand v2,
 * .docs/junior-goals-teams/junior-brand-v2.html), round eyes that catch the
 * light and a small mouth. Expressions are states, hello, listen, think,
 * working, needs, done, stuck, asleep, and ease into each other. The persona's
 * shape and colour still apply: the key is the default shape, sky its colour.
 *
 * Motion: `follow` tracks the pointer (the Junior page only), `wander`
 * glances and blinks, `still` moves only when the mood changes (the rail).
 * Reduced motion turns all of it off. Below 48px the eye highlights go and
 * the eyes and mouth draw a little bigger, so the face survives at 16px.
 *
 * React renders the skeleton once; one shared animation frame loop moves
 * every face that needs it, writing attributes directly, so a face never
 * re-renders React at 60fps.
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { MOOD_LABEL, type Mood } from '../../../core/junior/mood.js'
import { shapePaths, type Shape } from '../../../core/junior/shapes.js'
import { usePersona } from '../junior.js'

type Eye = { x: number; y: number; w: number; h: number }
/** The mouth: one quadratic stroke, from a smile to a line to a dot. */
type Mouth = { x1: number; y1: number; cx: number; cy: number; x2: number; y2: number; w: number }
/** happy = eyes become up-arcs; shut = down-arcs; led = the orange needs-you light; zz = asleep; press = key down */
type Geo = { eyes: [Eye, Eye]; mouth: Mouth; happy: number; shut: number; led: number; zz: number; press: number }

const C = (x: number, y: number, r: number): Eye => ({ x, y, w: r * 2, h: r * 2 })
const M = (x1: number, y1: number, cx: number, cy: number, x2: number, y2: number, w = 5.5): Mouth => ({ x1, y1, cx, cy, x2, y2, w })
const dot = (x: number, y: number): Mouth => M(x - 0.5, y, x, y, x + 0.5, y, 9)
const G = (eyes: [Eye, Eye], mouth: Mouth, more: Partial<Omit<Geo, 'eyes' | 'mouth'>> = {}): Geo => ({ eyes, mouth, happy: 0, shut: 0, led: 0, zz: 0, press: 0, ...more })

// The brand sheet's eight moods, in the key's 128-unit grid.
const MOODS: Record<Mood, Geo> = {
  hello: G([C(49, 55, 10.5), C(79, 55, 10.5)], M(56.5, 76, 64, 83, 71.5, 76)),
  listen: G([C(49, 53, 12), C(79, 53, 12)], dot(64, 79)),
  think: G([C(53, 50, 10), C(83, 50, 10)], M(60, 79, 65.5, 79, 71, 79)),
  working: G([{ x: 49, y: 58, w: 20, h: 13 }, { x: 79, y: 58, w: 20, h: 13 }], M(58, 78, 64, 78, 70, 78)),
  needs: G([C(52, 51, 11), C(82, 51, 11)], dot(64, 79), { led: 1 }),
  done: G([C(49, 56, 10), C(79, 56, 10)], M(54, 74, 64, 86, 74, 74, 6), { happy: 1, press: 6 }),
  stuck: G([C(49, 57, 8.5), C(79, 57, 8.5)], M(54, 80, 64, 75, 74, 80, 4.5)),
  asleep: G([C(49, 56, 10), C(79, 56, 10)], M(60, 79, 64, 79, 68, 79, 4.5), { shut: 1, zz: 1 }),
}

const clone = (g: Geo): Geo => ({ ...g, eyes: [{ ...g.eyes[0] }, { ...g.eyes[1] }], mouth: { ...g.mouth } })

// Colour: the persona's body colour; underside and brows derived from it.

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

/** The brand's sky key, exactly. */
const SKY = { top: '#a9cdfc', body: '#80b2f6', skirt: '#2f63c9', eye: '#0b1530' }

/** Top, body, skirt and eyes from one colour (the key's top); sky is the brand's own. */
export function facePalette(colour: string) {
  const top = /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : SKY.top
  if (top === SKY.top) return SKY
  const [h, s, l] = hexToHsl(top)
  return {
    top,
    body: hslToHex(h, clamp(s * 0.93, 0, 1), clamp(l - 0.1, 0.2, 0.85)),
    skirt: hslToHex((h + 6) % 360, clamp(s * 0.66, 0, 1), clamp(l * 0.59, 0.18, 0.55)),
    eye: hslToHex((h + 10) % 360, clamp(s * 0.67, 0, 1), 0.12),
  }
}

// Motion: one loop for every face on the page.

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

type Els = {
  svg: SVGSVGElement
  back: SVGPathElement
  /** body + top + face: what moves down when the key is pressed */
  key: SVGGElement
  front: SVGGElement
  face: SVGGElement
  eyes: SVGRectElement[]
  shines: SVGCircleElement[]
  arcs: SVGPathElement[]
  mouth: SVGPathElement
  led: SVGGElement
  zz: SVGGElement
}

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
  /** eyes and mouth scaled about the face's centre (1 = the Junior page's); small faces read better bigger */
  features = 1
  /** below 48px: no highlights, bigger eyes, a thicker mouth (the brand's icon.svg) */
  small = false
  /** the thinnest line, in viewBox units, that still draws about a pixel */
  line = 1
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
    for (let i = 0; i < 2; i++) ease(this.cur.eyes[i], t.eyes[i], ['x', 'y', 'w', 'h'])
    ease(this.cur.mouth, t.mouth, ['x1', 'y1', 'cx', 'cy', 'x2', 'y2', 'w'])
    ease(this.cur as unknown as Record<string, number>, t as unknown as Record<string, number>, ['happy', 'shut', 'led', 'zz', 'press'])

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
    const { els, cur } = this
    const gx = this.gaze.x
    const gy = this.gaze.y
    const k = this.features * (this.small ? 1.14 : 1)
    // Scaled about (64, 64), between the eyes and the mouth, so the features grow in place.
    const grow = k === 1 ? '' : ` translate(64 64) scale(${k}) translate(-64 -64)`
    els.key.setAttribute('transform', `translate(0 ${cur.press})`)
    els.face.setAttribute('transform', `translate(${gx * 8 * this.reach} ${gy * 6 * this.reach})${grow}`)
    els.front.setAttribute('transform', `translate(${gx * 2.5} ${gy * 2})`)
    els.back.setAttribute('transform', `translate(${-gx * 3} ${-gy * 2})`)
    const blink = this.blinkP >= 0 ? 1 - 0.88 * Math.sin(Math.PI * this.blinkP) : 1
    const open = Math.max(0, 1 - cur.happy - cur.shut)
    const arcW = Math.max(5.5, this.line)
    cur.eyes.forEach((e, i) => {
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
      el.setAttribute('opacity', String(open))
      // the highlight: up and left in the eye, gone when the eye narrows, shuts or is small
      const r = Math.min(w, h) / 2
      const sh = els.shines[i]
      sh.setAttribute('cx', String(x - r * 0.33))
      sh.setAttribute('cy', String(y - r * 0.38))
      sh.setAttribute('r', String(r * 0.3))
      sh.setAttribute('opacity', String(this.small || h < w * 0.8 ? 0 : open))
      const a = els.arcs[i]
      const up = `M${x - 9} ${y + 4} Q${x} ${y - 8} ${x + 9} ${y + 4}`
      const down = `M${x - 9} ${y} Q${x} ${y + 6} ${x + 9} ${y}`
      a.setAttribute('d', cur.happy >= cur.shut ? up : down)
      a.setAttribute('stroke-width', String(arcW))
      a.setAttribute('opacity', String(Math.max(cur.happy, cur.shut)))
    })
    const m = cur.mouth
    els.mouth.setAttribute('d', `M${m.x1} ${m.y1} Q${m.cx} ${m.cy} ${m.x2} ${m.y2}`)
    els.mouth.setAttribute('stroke-width', String(Math.max(m.w, this.small ? 7.5 : 0, this.line)))
    els.led.setAttribute('opacity', String(cur.led))
    els.zz.setAttribute('opacity', String(cur.zz))
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
  /** override the persona's shape (the About me shape picker) */
  shape?: Shape
  /** decorative = hidden from assistive tech (a label beside it already names it) */
  decorative?: boolean
  /** look here instead of at the pointer: x, y in -1…1 (down = +y); null = back to the pointer */
  look?: { x: number; y: number } | null
  /** how far the eyes travel when they look somewhere; 1 = the Junior page's, more for small faces */
  reach?: number
  /** eyes and mouth scaled about the face's centre; 1 = the Junior page's, more for small faces */
  features?: number
  className?: string
}

/** Junior's face at any size. Colour, shape and name come from the workspace's persona. */
export const JuniorFace = memo(function JuniorFace({ mood = 'hello', size = 40, motion = 'wander', colour, shape, decorative, className, look = null, reach = 1, features = 1 }: Props) {
  const persona = usePersona()
  const svg = useRef<SVGSVGElement>(null)
  const ctl = useRef<FaceCtl | null>(null)
  const p = facePalette(colour ?? persona.colour)
  const body = shapePaths(shape ?? persona.shape)
  const small = size < 48
  // Lines in viewBox units, never thinner than about one screen pixel.
  const line = 112 / size

  // Build the controller once the skeleton is in the DOM (before paint, so the
  // eyes never flash empty); drop it with the face.
  useLayoutEffect(() => {
    const el = svg.current
    if (!el) return
    const q = <T extends Element>(sel: string) => [...el.querySelectorAll<T & Element>(sel)] as T[]
    const one = <T extends Element>(part: string) => el.querySelector<T & Element>(`[data-part="${part}"]`)! as T
    const els: Els = {
      svg: el,
      back: one<SVGPathElement>('back'),
      key: one<SVGGElement>('key'),
      front: one<SVGGElement>('front'),
      face: one<SVGGElement>('face'),
      eyes: q<SVGRectElement>('[data-part="eye"]'),
      shines: q<SVGCircleElement>('[data-part="shine"]'),
      arcs: q<SVGPathElement>('[data-part="arc"]'),
      mouth: one<SVGPathElement>('mouth'),
      led: one<SVGGElement>('led'),
      zz: one<SVGGElement>('zz'),
    }
    const c = new FaceCtl(els, mood, motion)
    ctl.current = c
    c.small = small
    c.line = line
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
    c.small = small
    c.line = line
    c.render()
  }, [reach, features, motion, small, line])

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
      viewBox="8 10 112 112"
      width={size}
      height={size}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      style={{ overflow: 'visible', display: 'block', flex: 'none' }}
    >
      <g transform={body.frame}>
        <path data-part="back" d={body.back} fill={p.skirt} />
      </g>
      <g data-part="key">
        <g data-part="front">
          <g transform={body.frame}>
            <path d={body.front} fill={body.top ? p.body : p.top} />
          </g>
          {body.top && <path d={body.top} fill={p.top} />}
        </g>
        <g data-part="face">
          {[0, 1].map((i) => <rect key={`e${i}`} data-part="eye" fill={p.eye} />)}
          {[0, 1].map((i) => <circle key={`s${i}`} data-part="shine" fill="#fff" />)}
          {[0, 1].map((i) => <path key={`a${i}`} data-part="arc" fill="none" strokeLinecap="round" stroke={p.eye} opacity={0} />)}
          <path data-part="mouth" fill="none" strokeLinecap="round" stroke={p.skirt} />
        </g>
      </g>
      <g data-part="led" opacity={0}>
        <circle cx={96} cy={31} r={9} fill="#ff6a1f" opacity={0.22} />
        <circle cx={96} cy={31} r={4.5} fill="#ff6a1f" />
      </g>
      <g data-part="zz" opacity={0} fill={p.skirt} fontFamily="Geist Mono, ui-monospace, monospace" fontWeight={500}>
        <text x={92} y={38} fontSize={13}>z</text>
        <text x={101} y={28} fontSize={10}>z</text>
      </g>
    </svg>
  )
})
