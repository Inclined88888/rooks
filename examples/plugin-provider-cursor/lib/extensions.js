// @ts-check
/**
 * Cursor's own blocking requests, answered with Rooks's cards (`AcpAgentSpec.extensionRequests`). Cursor waits on
 * both until the client replies; without these handlers Rooks would answer "method not found".
 *
 * Shapes from https://cursor.com/docs/cli/acp ("Cursor extension methods", read 30/10/2026). NOT observed on a real
 * `cursor-agent`: see README.md, "Known limits".
 *
 * @typedef {import('@rooks/sdk/provider').AcpExtensionHandler} AcpExtensionHandler
 * @typedef {import('@rooks/sdk/provider').AcpCardQuestion} AcpCardQuestion
 */

/** @param {unknown} value */
const record = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null)
/** @param {unknown} value */
const text = (value) => (typeof value === 'string' && value.trim() ? value : null)

/** @param {string} reason */
const skipped = (reason) => ({ outcome: { outcome: 'skipped', reason } })

/**
 * `cursor/ask_question`: `{ toolCallId, title?, questions: [{ id, prompt, options: [{ id, label }], allowMultiple? }] }`
 * → `{ outcome: { outcome: 'answered', answers: [{ questionId, selectedOptionIds }] } | 'skipped' | 'cancelled' }`.
 *
 * Cursor's answer has no place for words: when the person typed some, the whole answer goes back as a `skipped`
 * whose `reason` says it, so the agent reads the remark instead of a bare pick.
 * @type {AcpExtensionHandler}
 */
export async function askQuestion(params, cards) {
  const p = record(params)
  const raw = Array.isArray(p?.questions) ? p.questions : []
  /** @type {AcpCardQuestion[]} */
  const questions = []
  for (const item of raw) {
    const q = record(item)
    const id = text(q?.id)
    const prompt = text(q?.prompt)
    if (!q || !id || !prompt) return skipped('the question could not be read')
    const options = (Array.isArray(q.options) ? q.options : []).map(record)
    if (options.some((o) => !o || !text(o.id) || !text(o.label))) return skipped('an option could not be read')
    questions.push({
      id,
      question: prompt,
      ...(questions.length === 0 && text(p?.title) ? { header: /** @type {string} */ (p?.title).slice(0, 40) } : {}),
      options: options.map((o) => ({ id: /** @type {string} */ (o?.id), label: /** @type {string} */ (o?.label) })),
      ...(q.allowMultiple === true ? { multiSelect: true } : {}),
    })
  }
  if (questions.length === 0) return skipped('no question was sent')

  const got = await cards.ask(questions, { id: text(p?.toolCallId) })
  if (got.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } }
  if (got.outcome === 'unanswered') return skipped(got.reason)
  const answers = questions.map((q) => ({ questionId: q.id, selectedOptionIds: [...(got.value[q.id]?.selected ?? [])] }))
  const typed = questions.filter((q) => got.value[q.id]?.text)
  if (typed.length === 0) return { outcome: { outcome: 'answered', answers } }
  const words = questions.map((q) => {
    const answer = got.value[q.id]
    const picked = (q.options ?? []).filter((o) => answer?.selected.includes(o.id)).map((o) => o.label)
    return `${q.question} — ${[picked.length ? `picked ${picked.join(', ')}` : 'nothing picked', answer?.text ? `wrote: ${answer.text}` : ''].filter(Boolean).join('; ')}`
  })
  return skipped(`The person answered in their own words. ${words.join(' | ')}`)
}

/**
 * `cursor/create_plan`: `{ toolCallId, name?, overview?, plan, todos: [{ id, content, status }], phases? }`
 * → `{ outcome: { outcome: 'accepted' } | { outcome: 'rejected', reason? } | { outcome: 'cancelled' } }`.
 * Nobody to ask (an unattended mission) is a rejection whose reason tells the agent what to do instead.
 * @type {AcpExtensionHandler}
 */
export async function createPlan(params, cards) {
  const p = record(params)
  const plan = text(p?.plan)
  if (!p || !plan) return { outcome: { outcome: 'rejected', reason: 'the plan could not be read' } }
  const steps = (Array.isArray(p.todos) ? p.todos : []).map((todo) => text(record(todo)?.content)).filter(/** @param {string | null} s @returns {s is string} */ (s) => s !== null)
  const got = await cards.approvePlan(
    { title: text(p.name) ?? 'Cursor proposes a plan', plan: [text(p.overview), plan].filter(Boolean).join('\n\n'), steps },
    { id: text(p.toolCallId) },
  )
  if (got.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } }
  if (got.outcome === 'unanswered') return { outcome: { outcome: 'rejected', reason: got.reason } }
  if (got.value.approved) return { outcome: { outcome: 'accepted' } }
  return { outcome: { outcome: 'rejected', reason: got.value.note ?? 'The person rejected the plan.' } }
}

export const CURSOR_EXTENSIONS = Object.freeze({
  'cursor/ask_question': askQuestion,
  'cursor/create_plan': createPlan,
})
