import { describe, expect, it } from 'vitest'
import {
  EASY_FLOOR,
  assess,
  assignBands,
  chooseParent,
  easyFailures,
  holdsEasy,
  logRatio,
  quality,
  recordEvaluation,
  seedChampion,
} from '../src/seed/ledger.js'
import { workerBrief, mutate } from '../src/seed/mutate.js'

function memoryFiles() {
  const store = new Map<string, string>()
  return {
    store,
    async write(path: string, text: string) {
      store.set(path, text)
      return path
    },
    async read(path: string) {
      return store.get(path)
    },
  }
}

function evalDoc(metrics: object, fitness = 1) {
  return `${JSON.stringify({ fitness, metrics })}\n`
}

describe('quality and log improvement', () => {
  it('divides a higher-is-better raw score by the seed magnitude', () => {
    expect(quality(40, 10, true)).toBe(4)
    expect(quality(20, 10, true)).toBe(2)
  })

  it('inverts a lower-is-better raw score', () => {
    expect(quality(10, 100, false)).toBe(10)
    expect(quality(5, 100, false)).toBe(20)
  })

  it('treats a non-positive raw score as quality 0', () => {
    expect(quality(0, 10, true)).toBe(0)
    expect(quality(-3, 10, false)).toBe(0)
    expect(quality(Number.NaN, 10, true)).toBe(0)
  })

  it('ranks a doubled quality above a huge raw gap that barely moves quality', () => {
    const small = logRatio(quality(40, 1, true), quality(20, 1, true))
    const huge = logRatio(quality(1.01e6, 1e6, true), quality(1e6, 1e6, true))
    expect(small).toBeCloseTo(Math.log(2))
    expect(huge).toBeCloseTo(Math.log(1.01))
    expect(40 - 20).toBeLessThan(1.01e6 - 1e6)
    expect(small).toBeGreaterThan(huge)
  })
})

describe('bands and easy floors', () => {
  it('splits 50 seeds into 16 hard, 18 middle, and 16 easy, low difficulty first', () => {
    const difficulty = Array.from({ length: 50 }, (_, index) => index)
    const bands = assignBands(difficulty)
    expect(bands.hard).toHaveLength(16)
    expect(bands.mid).toHaveLength(18)
    expect(bands.easy).toHaveLength(16)
    expect(bands.hard[0]).toBe(0)
    expect(bands.easy[bands.easy.length - 1]).toBe(49)
    expect(bands.band[0]).toBe('hard')
    expect(bands.band[49]).toBe('easy')
  })

  it('requires both the parent floor and the baseline floor on every easy seed', () => {
    const difficulty = [0.1, 0.5, 0.9]
    const { band } = assignBands(difficulty)
    const parent = [0.2, 0.5, 1]
    expect(band).toEqual(['hard', 'mid', 'easy'])

    const belowParent = [0.4, 0.5, 0.96]
    expect(holdsEasy(belowParent, parent, difficulty, band, EASY_FLOOR)).toBe(false)
    expect(easyFailures(belowParent, parent, difficulty, band, EASY_FLOOR).map(item => item.seed)).toEqual([2])

    const parentAlreadyLow = [0.2, 0.5, 0.5]
    const aboveParentBelowBaseline = [0.3, 0.5, 0.55]
    expect(0.55).toBeGreaterThan(EASY_FLOOR * 0.5)
    expect(0.55).toBeLessThan(EASY_FLOOR * 0.9)
    expect(holdsEasy(aboveParentBelowBaseline, parentAlreadyLow, difficulty, band, EASY_FLOOR)).toBe(false)

    const both = [0.4, 0.5, 0.88]
    expect(holdsEasy(both, parentAlreadyLow, difficulty, band, EASY_FLOOR)).toBe(true)
  })
})

describe('parent choice', () => {
  function stateWith(dropperQ: number[], holderQ: number[]) {
    const difficulty = [0.1, 0.5, 0.9]
    const bands = assignBands(difficulty)
    return {
      frozen: true,
      floor: EASY_FLOOR,
      higherIsBetter: true,
      difficulty,
      magnitude: [10, 10, 10],
      ...bands,
      picks: 4,
      nicheIndex: 0,
      candidates: {
        c000000: { parent: null, q: difficulty, accepted: [true, true, true] },
        dropper: { parent: 'c000000', q: dropperQ, accepted: [true, true, true] },
        holder: { parent: 'c000000', q: holderQ, accepted: [true, true, true] },
      },
    }
  }

  it('rejects a niche parent that misses an easy floor, even when it leads the hard seed', () => {
    const state = stateWith([0.99, 0.5, 0.5], [0.4, 0.5, 0.95])
    expect(assess(state, 'dropper', EASY_FLOOR).holdsEasy).toBe(false)
    expect(assess(state, 'holder', EASY_FLOOR).holdsEasy).toBe(true)
    const choice = chooseParent(state, ['dropper', 'holder'], () => 0.99)
    expect(choice).toMatchObject({ id: 'holder', niche: true, seed: 0, picks: 5 })
  })

  it('ranks a floor-holder above a higher hard-seed gain that dropped an easy seed', () => {
    const state = stateWith([0.99, 0.5, 0.5], [0.4, 0.5, 0.95])
    const champion = seedChampion(state)
    expect(champion?.id).toBe('holder')
  })
})

describe('ledger freeze', () => {
  const baselineMetrics = {
    combined_score: 5,
    higher_is_better: true,
    case_scores: [1, 5, 9],
    case_accepted: [true, true, true],
    case_magnitude: [10, 10, 10],
  }

  it('freezes difficulty from the baseline and ignores a later magnitude', async () => {
    const files = memoryFiles()
    await files.write('evals/c000000.json', evalDoc({ ...baselineMetrics }))
    const state = await recordEvaluation(files, 'c000000', null)
    expect(state?.difficulty).toEqual([0.1, 0.5, 0.9])
    expect(state?.magnitude).toEqual([10, 10, 10])
    expect(state?.band).toEqual(['hard', 'mid', 'easy'])

    await files.write('evals/c000001.json', evalDoc({
      combined_score: 9,
      higher_is_better: true,
      case_scores: [9, 9, 9],
      case_accepted: [true, true, true],
      case_magnitude: [99, 99, 99],
    }))
    const next = await recordEvaluation(files, 'c000001', 'c000000')
    expect(next?.difficulty).toEqual([0.1, 0.5, 0.9])
    expect(next?.magnitude).toEqual([10, 10, 10])
    expect(next?.magnitudeDisagreements).toBe(1)
    expect(next?.candidates.c000001.q).toEqual([0.9, 0.9, 0.9])
    expect(seedChampion(next)?.id).toBe('c000001')
  })

  it('records a rejected seed as quality 0', async () => {
    const files = memoryFiles()
    await files.write('evals/c000000.json', evalDoc({
      combined_score: 0,
      higher_is_better: true,
      case_scores: [100, 8, 9],
      case_accepted: [false, true, true],
      case_magnitude: [10, 10, 10],
    }))
    const state = await recordEvaluation(files, 'c000000', null)
    expect(state?.difficulty[0]).toBe(0)
    expect(state?.candidates.c000000.q[0]).toBe(0)
  })

  it('does not create a ledger when case_scores are absent', async () => {
    const files = memoryFiles()
    await files.write('evals/c000000.json', evalDoc({ combined_score: 10 }))
    expect(await recordEvaluation(files, 'c000000', null)).toBeNull()
    expect(files.store.has('seed-ledger/state.json')).toBe(false)
  })

  it('freezes a resumed run from the baseline file, not from the child', async () => {
    const files = memoryFiles()
    await files.write('evals/c000000.json', evalDoc({ ...baselineMetrics }))
    await files.write('evals/c000001.json', evalDoc({
      combined_score: 9,
      higher_is_better: true,
      case_scores: [9, 9, 9],
      case_accepted: [true, true, true],
      case_magnitude: [10, 10, 10],
    }))
    const state = await recordEvaluation(files, 'c000001', 'c000000')
    expect(state?.difficulty).toEqual([0.1, 0.5, 0.9])
    expect(state?.candidates.c000000.q).toEqual([0.1, 0.5, 0.9])
    expect(state?.candidates.c000001.q).toEqual([0.9, 0.9, 0.9])
  })

  it('applies a revised floor without moving difficulty', async () => {
    const files = memoryFiles()
    await files.write('evals/c000000.json', evalDoc({ ...baselineMetrics }))
    await recordEvaluation(files, 'c000000', null)
    await files.write('evals/c000001.json', evalDoc({
      combined_score: 4,
      higher_is_better: true,
      case_scores: [4, 5, 8.5],
      case_accepted: [true, true, true],
      case_magnitude: [10, 10, 10],
    }))
    const strict = await recordEvaluation(files, 'c000001', 'c000000')
    expect(assess(strict, 'c000001', EASY_FLOOR).holdsEasy).toBe(false)
    await files.write('seed-ledger/floor.json', `${JSON.stringify({ easy: 0.9 })}\n`)
    const loosened = await recordEvaluation(files, 'c000001', 'c000000')
    expect(loosened?.difficulty).toEqual([0.1, 0.5, 0.9])
    expect(loosened?.floor).toBe(0.9)
    expect(assess(loosened, 'c000001', loosened!.floor).holdsEasy).toBe(true)
  })
})

describe('worker brief', () => {
  it('states both easy floors and does not prescribe an algorithm', () => {
    const difficulty = [0.1, 0.5, 0.9]
    const bands = assignBands(difficulty)
    const state = {
      frozen: true,
      floor: EASY_FLOOR,
      difficulty,
      magnitude: [10, 10, 10],
      ...bands,
      candidates: {
        c000000: { parent: null, q: [0.1, 0.5, 0.9], accepted: [true, false, true] },
      },
    }
    const brief = workerBrief(state, 'c000000', EASY_FLOOR)
    expect(brief).toContain('floor_vs_parent')
    expect(brief).toContain('floor_vs_baseline')
    expect(brief).toContain('fallback')
    expect(brief).toContain('current input')
    expect(brief).toContain('#EVOLVE_START')
    expect(brief).not.toMatch(/simulated annealing|beam search|temperature/i)
    expect(workerBrief(null, 'c000000', EASY_FLOOR)).toBeNull()
  })

  it('sends the per-seed brief and keeps the worker reply, and uses the original instruction when there is no ledger', async () => {
    const files = memoryFiles()
    await files.write('evals/c000000.json', evalDoc({
      combined_score: 5,
      higher_is_better: true,
      case_scores: [1, 5, 9],
      case_accepted: [true, true, true],
      case_magnitude: [10, 10, 10],
    }))
    await recordEvaluation(files, 'c000000', null)
    let instruction = ''
    const evolve = {
      files,
      async allocate() { return { id: 'c000001', dir: 'candidates/c000001' } },
      async spawnWorker(_dir: string, text: string) {
        instruction = text
        return { text: 'kept several constructions', stopReason: 'end' }
      },
      population: () => ({ rows: async () => [{ id: 'c000000', fitness: 3 }] }),
      currentRun: () => ({ signal: { aborted: false } }),
    }
    const candidate = await mutate({ parent: 'c000000' }, evolve)
    expect(candidate).toEqual({ id: 'c000001', dir: 'candidates/c000001' })
    expect(instruction).toContain('floor_vs_baseline')
    expect(instruction).not.toContain('official fitness was')
    expect(files.store.get('seed-ledger/notes/c000001.txt')).toBe('kept several constructions')

    const bare = memoryFiles()
    let fallback = ''
    await mutate({ parent: 'c000000' }, {
      files: bare,
      async allocate() { return { id: 'c000001', dir: 'candidates/c000001' } },
      async spawnWorker(_dir: string, text: string) {
        fallback = text
        return { text: 'unused', stopReason: 'end' }
      },
      population: () => ({ rows: async () => [{ id: 'c000000', fitness: 10 }] }),
      currentRun: () => ({ signal: { aborted: false } }),
    })
    expect(fallback).toContain("The parent candidate's official fitness was 10.")
    expect(bare.store.has('seed-ledger/notes/c000001.txt')).toBe(false)
  })
})
