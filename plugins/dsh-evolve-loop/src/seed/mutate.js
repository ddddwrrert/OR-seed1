/**
 * Worker brief for one parent, written from the per-seed ledger.
 *
 * The brief tells the worker which seeds are hard, which easy-seed floors it
 * must hold, and that the program has to cover every seed. It does not name
 * an algorithm, a schedule, or parameter values. The worker chooses the
 * constructions.
 *
 * The reply is saved under run/seed-ledger/notes/. When the ledger does not
 * exist, mutation is the original candidate-builder instruction, including
 * the parent's official fitness.
 *
 * @module dsh-evolve-loop/seed/mutate
 */

import { buildCandidate, mutate as defaultMutate } from '../providers/mutate.js'
import { EASY_FLOOR, assess, loadState, readFloor } from './ledger.js'

export const name = 'seed-balance'

function format(value) {
  if (!Number.isFinite(value)) return 'NA'
  const abs = Math.abs(value)
  if (abs !== 0 && (abs >= 1000 || abs < 0.001)) return value.toExponential(4)
  return value.toPrecision(6)
}

/**
 * Instruction for the worker that will edit `parentId`. Null when this parent
 * has no per-seed record, so the caller uses the original instruction.
 * @param {object|null} state
 * @param {string} parentId
 * @param {number} floor
 * @returns {string|null}
 */
export function workerBrief(state, parentId, floor = EASY_FLOOR) {
  if (!state?.frozen || !state.candidates?.[parentId]) return null
  const parent = assess(state, parentId, floor)
  if (!parent.known) return null
  const difficulty = state.difficulty
  const lines = [
    'Read the task statement and the parent solution in this directory.',
    'The objective of this edit is per-seed quality, not the official average and not a raw point gap.',
    'On each seed, quality q is raw/M when a higher raw score is better, and M/raw when a lower raw score is better. M is that seed\'s magnitude. It was computed from the seed\'s input and this problem\'s score formula, then frozen. A seed that was not accepted has q = 0.',
    'Difficulty D is the baseline program\'s quality on that seed, also frozen. A later program does not change M or D. Alpha is q - D.',
    'Improvement that can be compared across seeds is log(q_child / q_parent). A doubling of quality is the same kind of gain on a seed whose raw score is small and on a seed whose raw score is huge. Do not chase the seed with the largest raw number.',
    `Official fitness remains the evaluator\'s combined score and is recorded separately. It is not the target of this edit. The easy-seed floor for this attempt is ${format(floor)}.`,
    '',
    'Requirements for this one program:',
    '- First make the program produce a feasible solution on every seed. A seed with no accepted solution has quality 0, whatever the other seeds do.',
    '- The program\'s behavior must depend on the current input. One plan with the same decisions on every seed will not raise the seeds that are still behind.',
    '- Keep more than one construction inside this single program. On each seed, choose the construction by that seed\'s own score.',
    '- After a feasible solution exists for the current input, spend the remaining time improving that input.',
    '- On every easy seed, keep the parent\'s behavior as a fallback unless the replacement holds both floors on that seed: q at least the floor times the parent\'s q, and q at least the floor times the baseline\'s q.',
    '- Do not lower an easy seed in order to raise a hard seed. A parent that was chosen because it is strong on a hard seed is still bound by both easy floors.',
    '- This directory is one candidate and one program. You may reason about alternatives. Do not write a second complete program beside this one.',
    '- Edit only the solution code between the #EVOLVE_START and #EVOLVE_END markers. Leave every other file unchanged.',
    '- Do not run the task\'s official evaluator or performance benchmarks. The search loop evaluates this candidate after you finish.',
    '',
  ]

  const failed = []
  for (let index = 0; index < parent.q.length; index += 1) {
    if ((state.candidates[parentId].accepted?.[index] === false) || parent.q[index] === 0) failed.push(index)
  }
  if (failed.length > 0) {
    lines.push(`The parent has quality 0 on seeds ${failed.join(', ')}. Those seeds need a feasible solution before any other improvement.`)
    lines.push('')
  }

  lines.push('Hard seeds, low baseline quality. Columns are the seed index, frozen difficulty D, the parent\'s q, and alpha = q - D.')
  if (state.hard.length === 0) {
    lines.push('(none)')
  }
  for (const index of state.hard) {
    const q = parent.q[index]
    lines.push(`seed ${index}: D=${format(difficulty[index])} parent_q=${format(q)} alpha=${format(q - difficulty[index])}`)
  }
  lines.push('')
  lines.push('Easy seeds. Both floors are required. Columns are the seed index, the parent\'s q, the floor against the parent, and the floor against the baseline.')
  if (state.easy.length === 0) {
    lines.push('(none)')
  }
  for (const index of state.easy) {
    const q = parent.q[index]
    lines.push(
      `seed ${index}: parent_q=${format(q)} floor_vs_parent=${format(floor * q)} floor_vs_baseline=${format(floor * difficulty[index])}`,
    )
  }
  lines.push('')
  lines.push('Seeds that are not listed are the middle band. They must stay feasible. They are not under the easy-seed floor, and they are not a reason to drop an easy seed.')
  return lines.join('\n')
}

/**
 * @param {object} options
 * @param {object} evolve
 * @returns {Promise<{ id: string, dir: string }>}
 */
export async function mutate(options, evolve) {
  if (options?.instruction) return defaultMutate(options, evolve)
  let brief = null
  try {
    const state = await loadState(evolve.files)
    const floor = await readFloor(evolve.files, state?.floor ?? EASY_FLOOR)
    brief = workerBrief(state, options?.parent, floor)
  } catch {
    brief = null
  }
  if (!brief) return defaultMutate(options, evolve)
  const outcome = await buildCandidate({
    ...options,
    instruction: brief,
    name: options?.name ?? 'seed-balance',
  }, evolve)
  const text = outcome.report?.text
  if (typeof text === 'string' && text.trim() !== '') {
    await evolve.files.write(`seed-ledger/notes/${outcome.candidate.id}.txt`, text)
  }
  return outcome.candidate
}

export default { name, mutate, workerBrief }
