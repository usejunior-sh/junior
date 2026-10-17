/**
 * The `AskUserQuestion` tool call, read out of a permission request.
 *
 * The tool arrives on the same channel as every other permission prompt, but
 * its input *is* the question, showing it as raw JSON with Allow/Deny buttons
 * asks the reader to answer a multiple-choice question by approving a blob. So
 * it gets parsed here and rendered as the choices it actually is.
 */
export type AskOption = { label: string; description?: string }

export type AskQuestion = {
  question: string
  header?: string
  options: AskOption[]
  multiSelect: boolean
}

/** The label the tool documents as always available, on top of the listed ones. */
export const OTHER = 'Other'

/**
 * Returns the questions when `input` really is a well-formed AskUserQuestion
 * call, and null otherwise. A malformed one falls back to the plain
 * permission card rather than rendering a card with nothing to click.
 */
export function parseQuestions(input: Record<string, unknown>): AskQuestion[] | null {
  const raw = input.questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: AskQuestion[] = []
  for (const q of raw) {
    if (typeof q !== 'object' || q === null) return null
    const { question, header, options, multiSelect } = q as Record<string, unknown>
    if (typeof question !== 'string' || !question) return null
    if (!Array.isArray(options) || options.length === 0) return null
    const parsed: AskOption[] = []
    for (const o of options) {
      if (typeof o !== 'object' || o === null) return null
      const { label, description } = o as Record<string, unknown>
      if (typeof label !== 'string' || !label) return null
      parsed.push({ label, description: typeof description === 'string' ? description : undefined })
    }
    questions.push({
      question,
      header: typeof header === 'string' && header ? header : undefined,
      options: parsed,
      multiSelect: multiSelect === true,
    })
  }
  return questions
}
