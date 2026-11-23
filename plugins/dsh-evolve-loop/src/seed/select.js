/**
 * Parent selection that ranks by per-seed quality.
 *
 * Official fitness is not a weight. When the ledger does not exist, this
 * delegates to fitness-proportional selection, so tasks without per-seed
 * scores keep the original behavior.
 *
 * @module dsh-evolve-loop/seed/select
 */

import { select as fitnessSelect } from '../providers/select.js'
import { EASY_FLOOR, chooseParent, loadState, readFloor, saveSelection } from './ledger.js'

export const name = 'seed-balance'

/**
 * @param {object} population
 * @param {object} evolve
 * @returns {Promise<string>}
 */
export async function select(population, evolve) {
  const state = await loadState(evolve.files)
  if (!state) return fitnessSelect(population, evolve)
  const floor = await readFloor(evolve.files, state.floor ?? EASY_FLOOR)
  const rows = await population.rows()
  const aliveIds = rows.filter(row => row.survival === 'yes').map(row => row.id)
  const choice = chooseParent({ ...state, floor }, aliveIds)
  if (!choice) return fitnessSelect(population, evolve)
  await saveSelection(evolve.files, choice, floor)
  return choice.id
}

export default { name, select }
