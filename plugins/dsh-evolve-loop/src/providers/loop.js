/**
 * Default search loop provider: coordinates baseline evaluation, iterative variation,
 * scoring, recording, and survival. Returns { best_id, best_fitness, remaining }.
 *
 * @module dsh-evolve-loop/providers/loop
 */

import { alive, merit } from '../population.js'
import { loadState, recordEvaluation, seedChampion } from '../seed/ledger.js'

export const name = 'evolve-loop'

/**
 * Execute the evolutionary search loop.
 * Official best_id is still the candidate with the highest merit of fitness.
 * When the per-seed ledger exists, the result also names seed_best_id.
 * @param {object} args - loop arguments (maxBudget, maxPopulation, k, candidates).
 * @param {object} evolve - the evolve service.
 * @returns {Promise<{ best_id: string, best_fitness: number, remaining: number, seed_best_id?: string, seed_best_objective?: number }>}
 */
export async function run(args, evolve) {
  const { maxPopulation, candidates } = await evolve.context()
  const population = evolve.population()
  const runState = evolve.currentRun()

  // 1. Initialize baseline c000000 if population is empty
  let rows = await population.rows()
  if (rows.length === 0) {
    const base = await evolve.copyTask()
    const baseFitness = await evolve.evaluate(base)
    await recordEvaluation(evolve.files, base.id, null)
    await population.append({
      id: base.id,
      parent: null,
      fitness: baseFitness,
      survival: 'yes',
    })
    rows = await population.rows()
  }

  // 2. Search iterations
  const limit = candidates ?? Infinity
  let created = 0

  while ((await evolve.context()).budget.remaining > 0 && created < limit) {
    runState.signal.throwIfAborted()

    // Selection
    const parentId = await evolve.select(population)

    // Mutation & Allocation
    const candidate = await evolve.mutate({ parent: parentId })
    created += 1

    // Evaluation. Official fitness is the number stored on the population row.
    // The ledger, when the evaluator returned per-seed scores, is updated beside it.
    const fitness = await evolve.evaluate(candidate)
    await recordEvaluation(evolve.files, candidate.id, parentId)

    // Recording
    await population.append({
      id: candidate.id,
      parent: parentId,
      fitness,
      survival: 'yes',
    })

    // Survival culling
    rows = await population.rows()
    if (alive(rows).length >= maxPopulation) {
      await evolve.survive(population)
      rows = await population.rows()
    }
  }

  // 3. Determine best candidate overall (by merit: a failed evaluation never wins)
  rows = await population.rows()
  let best = rows[0]
  for (const row of rows) {
    if (best === undefined || merit(row.fitness) > merit(best.fitness)) {
      best = row
    }
  }

  const budget = (await evolve.context()).budget
  const result = {
    best_id: best?.id ?? 'c000000',
    best_fitness: best?.fitness ?? 0,
    remaining: budget.remaining,
  }
  // Omit the seed fields when this task has no per-seed ledger, so a run
  // without case_scores returns the same object as before.
  const champion = seedChampion(await loadState(evolve.files))
  if (champion) {
    result.seed_best_id = champion.id
    result.seed_best_objective = champion.objective
  }
  return result
}

export default { name, run }
