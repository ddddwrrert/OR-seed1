/**
 * Survival that keeps candidates by the per-seed objective.
 *
 * A candidate that holds both easy-seed floors ranks above one that does not.
 * Among those, the higher mean log-quality on hard seeds wins, then the mean
 * log-lift over the parent. Official fitness is not consulted.
 *
 * When the ledger does not exist, this delegates to top-k by merit.
 *
 * @module dsh-evolve-loop/seed/survive
 */

import { DEFAULT_K, survive as topK } from '../providers/survive.js'
import { EASY_FLOOR, assess, compareRank, loadState, readFloor } from './ledger.js'

export const name = 'seed-balance'

/**
 * @param {object} population
 * @param {object} evolve
 */
export async function survive(population, evolve) {
  const state = await loadState(evolve.files)
  if (!state) return topK(population, evolve)
  const floor = await readFloor(evolve.files, state.floor ?? EASY_FLOOR)
  const { k } = await evolve.context()
  const rows = await population.rows()
  const ranked = rows
    .filter(row => row.survival === 'yes')
    .map(row => assess(state, row.id, floor))
    .sort(compareRank)
  const keep = new Set(ranked.slice(0, k ?? DEFAULT_K).map(row => row.id))
  await population.write(rows.map(row => (
    row.survival === 'yes' && !keep.has(row.id) ? { ...row, survival: 'no' } : row
  )))
}

export default { name, survive }
