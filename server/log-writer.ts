/**
 * The log file's write queue: log() hands it lines, and it appends them in
 * batches off the hot path. A line costs an array push, not a synchronous
 * file append on the main thread.
 *
 * - A short timer flushes the queue with one async append per file.
 * - Only one append is in flight at a time, so lines land in the order they
 *   were logged. Lines logged during a write wait for the next batch.
 * - flushSync() is for the process 'exit' handler only. It writes the queue,
 *   and also the batch still in flight, since process.exit doesn't wait for
 *   it. That batch can then land twice; a duplicate line beats a lost last
 *   line, and the boot replay skips repeated seqs.
 *
 * The I/O is injected, so tests drive it with a fake writer and a fake timer.
 */

export interface LogSink {
  append(file: string, text: string): Promise<void>
  appendSync(file: string, text: string): void
}

export interface LogWriterOptions {
  sink: LogSink
  /** How long a line may wait before its batch is written. */
  delayMs?: number
  /** Schedules a flush; returns a cancel. Defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Lines held at most while the disk is slow; the oldest are dropped past it. */
  maxPending?: number
}

export interface LogWriter {
  /** Queue one line (without its newline) for `file`. */
  write(file: string, line: string): void
  /** Write everything queued now; resolves once the queue is empty on disk. */
  flush(): Promise<void>
  /** Write the queue and the in-flight batch synchronously (exit handler only). */
  flushSync(): void
  /** Lines queued and not yet handed to the sink. */
  pending(): number
}

interface Line {
  file: string
  line: string
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

/** Consecutive lines for the same file joined into one append, order kept. */
export function groupByFile(lines: Line[]): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const { file, line } of lines) {
    const last = out[out.length - 1]
    if (last && last.file === file) last.text += line + '\n'
    else out.push({ file, text: line + '\n' })
  }
  return out
}

export function createLogWriter(opts: LogWriterOptions): LogWriter {
  const { sink } = opts
  const delayMs = opts.delayMs ?? 100
  const schedule = opts.schedule ?? defaultSchedule
  const maxPending = opts.maxPending ?? 10_000

  let queue: Line[] = []
  let inFlight: Line[] | null = null
  let cancelTimer: (() => void) | null = null
  let running: Promise<void> | null = null

  const arm = () => {
    if (cancelTimer || inFlight) return
    cancelTimer = schedule(() => {
      cancelTimer = null
      void drain()
    }, delayMs)
  }

  // Write batches until the queue is empty. One caller runs it at a time.
  const drain = (): Promise<void> => {
    if (running) return running
    running = (async () => {
      while (queue.length) {
        const batch = queue
        queue = []
        inFlight = batch
        for (const { file, text } of groupByFile(batch)) {
          try {
            await sink.append(file, text)
          } catch {
            // never let logging crash the daemon; this batch is lost
          }
        }
        inFlight = null
      }
    })().finally(() => {
      running = null
    })
    return running
  }

  return {
    write(file, line) {
      queue.push({ file, line })
      if (queue.length > maxPending) queue.splice(0, queue.length - maxPending)
      arm()
    },
    flush() {
      cancelTimer?.()
      cancelTimer = null
      return drain()
    },
    flushSync() {
      cancelTimer?.()
      cancelTimer = null
      const lines = [...(inFlight ?? []), ...queue]
      inFlight = null
      queue = []
      for (const { file, text } of groupByFile(lines)) {
        try {
          sink.appendSync(file, text)
        } catch {
          // best effort on the way out
        }
      }
    },
    pending: () => queue.length,
  }
}
