

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
