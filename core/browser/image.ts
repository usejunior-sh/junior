/**
 * Before/after for the browser's checkpoints: just enough PNG to read Chrome's
 * screenshots and write a diff image, and the diff itself. Zero dependencies —
 * Chrome writes plain 8-bit, non-interlaced RGB(A), so that is all this reads.
 */
import zlib from 'node:zlib'

export type Rgba = { width: number; height: number; data: Uint8Array }

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decodePng(buf: Buffer): Rgba {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')
  let off = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      colorType = body[9]
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) {
        throw new Error(`unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${body[12]})`)
      }
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      out[o] = cur[x * bpp]
      out[o + 1] = cur[x * bpp + 1]
      out[o + 2] = cur[x * bpp + 2]
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255
    }
    prev.set(cur)
  }
  return { width, height, data: out }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(tb))
  return Buffer.concat([len, tb, crc])
}

export function encodePng(img: Rgba): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = img.width * 4
  const raw = Buffer.alloc((stride + 1) * img.height)
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

export type Box = { x: number; y: number; width: number; height: number }

export type ImageDiff = {
  /** share of compared pixels that changed, 0–100 */
  changedPct: number
  /** changed regions in image pixels, largest first, at most 8 */
  boxes: Box[]
  /** the "after" image dimmed, changes in red, regions outlined */
  image: Rgba
  sizeChanged: boolean
}

/** A pixel counts as changed past this summed RGB distance (out of 765): anti-aliasing noise stays out. */
const PIXEL_THRESHOLD = 40
const CELL = 16

/** Compare two screenshots of the same viewport. Different sizes are compared over the overlap. */
export function diffImages(before: Rgba, after: Rgba): ImageDiff {
  const w = Math.min(before.width, after.width)
  const h = Math.min(before.height, after.height)
  const cols = Math.ceil(w / CELL)
  const rows = Math.ceil(h / CELL)
  const cells = new Uint8Array(cols * rows)
  const out = new Uint8Array(after.width * after.height * 4)
  let changed = 0
  for (let y = 0; y < after.height; y++) {
    for (let x = 0; x < after.width; x++) {
      const ao = (y * after.width + x) * 4
      let diff = true
      if (x < w && y < h) {
        const bo = (y * before.width + x) * 4
        const d =
          Math.abs(after.data[ao] - before.data[bo]) +
          Math.abs(after.data[ao + 1] - before.data[bo + 1]) +
          Math.abs(after.data[ao + 2] - before.data[bo + 2])
        diff = d > PIXEL_THRESHOLD
        if (diff) {
          changed += 1
          cells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1
        }
      }
      if (diff) {
        out[ao] = 255
        out[ao + 1] = 40
        out[ao + 2] = 60
      } else {
        // dimmed greyscale of the after image, so the changes stand out
        const g = Math.round((after.data[ao] * 0.3 + after.data[ao + 1] * 0.59 + after.data[ao + 2] * 0.11) * 0.35)
        out[ao] = g
        out[ao + 1] = g
        out[ao + 2] = g
      }
      out[ao + 3] = 255
    }
  }

  // Changed cells → connected regions (8-neighbour), then their bounding boxes.
  const boxes: Box[] = []
  const seen = new Uint8Array(cells.length)
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || seen[i]) continue
    let minC = cols
    let minR = rows
    let maxC = 0
    let maxR = 0
    const stack = [i]
    seen[i] = 1
    while (stack.length) {
      const j = stack.pop()!
      const c = j % cols
      const r = (j - c) / cols
      if (c < minC) minC = c
      if (c > maxC) maxC = c
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr
          const nc = c + dc
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue
          const k = nr * cols + nc
          if (cells[k] && !seen[k]) {
            seen[k] = 1
            stack.push(k)
          }
        }
      }
    }
    boxes.push({
      x: minC * CELL,
      y: minR * CELL,
      width: Math.min(w, (maxC + 1) * CELL) - minC * CELL,
      height: Math.min(h, (maxR + 1) * CELL) - minR * CELL,
    })
  }
  boxes.sort((a, b) => b.width * b.height - a.width * a.height)
  const top = boxes.slice(0, 8)
  for (const b of top) outline(out, after.width, after.height, b)

  return {
    changedPct: w * h ? Math.round((changed / (w * h)) * 10000) / 100 : 0,
    boxes: top,
    image: { width: after.width, height: after.height, data: out },
    sizeChanged: before.width !== after.width || before.height !== after.height,
  }
}

function outline(data: Uint8Array, width: number, height: number, b: Box) {
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const o = (y * width + x) * 4
    data[o] = 255
    data[o + 1] = 200
    data[o + 2] = 0
    data[o + 3] = 255
  }
  for (let t = 0; t < 2; t++) {
    for (let x = b.x - 2; x < b.x + b.width + 2; x++) {
      set(x, b.y - 2 + t)
      set(x, b.y + b.height + t)
    }
    for (let y = b.y - 2; y < b.y + b.height + 2; y++) {
      set(b.x - 2 + t, y)
      set(b.x + b.width + t, y)
    }
  }
}
