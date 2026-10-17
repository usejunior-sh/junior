/**
 * Junior's body shapes (Settings → About me → Shape). Each is the face's front
 * path in the face's own viewBox (-4 -4 112 110); the darker underside is the
 * same outline nudged down and right, so every shape keeps the slab's sense of
 * depth. Every outline leaves room for the eyes (y≈56, x 37 and 63) and the
 * brows (y≈40), which don't move between shapes. Pure and browser-safe.
 */

export type Shape = 'slab' | 'pebble' | 'squircle' | 'pill' | 'bun' | 'cloud' | 'ghost' | 'blob'

/** In picker order; the first is the default. */
export const SHAPES: ReadonlyArray<readonly [shape: Shape, label: string]> = [
  ['slab', 'Slab'],
  ['pebble', 'Pebble'],
  ['squircle', 'Squircle'],
  ['pill', 'Pill'],
  ['bun', 'Bun'],
  ['cloud', 'Cloud'],
  ['ghost', 'Ghost'],
  ['blob', 'Blob'],
]

export const DEFAULT_SHAPE: Shape = 'slab'
export const isShape = (v: unknown): v is Shape => SHAPES.some(([s]) => s === v)

const FRONT: Record<Shape, string> = {
  slab: 'M17 9 C39 5 65 5 83 11 C92 14 94 23 94 39 C94 57 93 73 87 82 C83 89 73 90 53 90 C33 90 19 90 12 84 C6 78 5 62 5 44 C5 26 7 13 17 9 Z',
  pebble: 'M48 4 C75 3 95 21 94 47 C93 74 77 92 50 91 C23 90 5 74 6 47 C7 21 22 5 48 4 Z',
  squircle: 'M50 5 C84 5 94 15 94 48 C94 81 84 90 50 90 C16 90 6 81 6 48 C6 15 16 5 50 5 Z',
  pill: 'M50 2 C72 2 86 16 86 36 L86 62 C86 82 72 94 50 94 C28 94 14 82 14 62 L14 36 C14 16 28 2 50 2 Z',
  bun: 'M50 14 C82 14 100 30 100 56 C100 80 84 90 50 90 C16 90 0 80 0 56 C0 30 18 14 50 14 Z',
  cloud: 'M20 30 C20 12 40 6 50 14 C58 4 82 6 84 24 C98 28 100 48 94 58 C100 72 88 90 70 88 C60 94 40 94 30 88 C12 90 2 74 8 60 C0 48 4 32 20 30 Z',
  ghost: 'M50 4 C76 4 92 20 92 46 L92 84 C88 93 80 93 75 86 C70 93 62 93 57 86 C52 93 44 93 39 86 C34 93 26 93 21 86 C16 93 10 93 8 84 L8 46 C8 20 24 4 50 4 Z',
  blob: 'M44 6 C66 0 92 12 94 36 C96 58 92 82 70 90 C50 97 22 92 10 76 C0 62 4 38 14 22 C22 10 32 8 44 6 Z',
}

/** The slab's underside was drawn by hand; the rest are their front nudged by this much. */
const SLAB_BACK = 'M22 15 C44 11 70 11 88 17 C97 20 99 30 99 46 C99 64 98 80 92 89 C88 96 78 97 58 97 C38 97 24 97 17 91 C11 85 10 69 10 51 C10 33 12 19 22 15 Z'
const DEPTH = { x: 5, y: 6 }

/** Every coordinate pair in an absolute-command path, moved by (dx, dy). */
function nudge(d: string, dx: number, dy: number): string {
  return d.replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${Number(x) + dx} ${Number(y) + dy}`)
}

/** The two paths the face draws for a shape: its underside, then its front. */
export function shapePaths(shape: Shape): { back: string; front: string } {
  const s = isShape(shape) ? shape : DEFAULT_SHAPE
  return { front: FRONT[s], back: s === 'slab' ? SLAB_BACK : nudge(FRONT[s], DEPTH.x, DEPTH.y) }
}
