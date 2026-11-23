/**
 * Per-seed ledger for one problem's public seeds.
 *
 * Official fitness stays the evaluator's combined_score. This ledger is a
 * separate measurement. It freezes two numbers from the baseline evaluation
 * and never revises them:
 *
 * - magnitude M_s, copied from the evaluator (the seed's own scale)
 * - difficulty D_s, the baseline's quality q on that seed
 *
 * Quality removes the scale: q = raw/M when higher is better, and q = M/raw
 * when lower is better. A seed that was not accepted has q = 0. Comparable
 * improvement is log(q_child / q_parent), not a raw point gap.
 *
 * Easy seeds are the top third of the frozen difficulties. A child may be
 * preferred, and may be chosen as a niche parent for a hard seed, only when
 * its quality on every easy seed holds both floors: 0.97 of the parent and
 * 0.97 of the baseline. The floor can be revised in seed-ledger/floor.json.
 * Magnitude, difficulty, and the bands cannot.
 *
 * Tasks whose evaluations have no case_scores never create this ledger.
 * Select, survive, and mutate then keep the original behavior.
 *
 * @module dsh-evolve-loop/seed/ledger
 */

export const EASY_FLOOR = 0.97
export const NICHE_EVERY = 5
export const LOG_EPS = 1e-9

export const STATE_PATH = 'seed-ledger/state.json'
export const SUMMARY_PATH = 'seed-ledger/summary.json'
export const FLOOR_PATH = 'seed-ledger/floor.json'

/**
 * Quality on one seed. Non-positive and non-finite raw scores are failures.
 * @param {number} raw
 * @param {number} magnitude
 * @param {boolean} higherIsBetter
 * @returns {number}
 */
export function quality(raw, magnitude, higherIsBetter) {
  const scale = Number(magnitude)
  const unit = Number.isFinite(scale) && scale > 0 ? scale : 1
  const score = Number(raw)
  if (!Number.isFinite(score) || score <= 0) return 0
  return higherIsBetter ? score / unit : unit / score
}

/**
 * Log improvement of `next` over `prev`. A zero is held at a tiny positive
 * floor so a failure is a large finite loss rather than Infinity.
 * @param {number} next
 * @param {number} prev
 * @returns {number}
 */
export function logRatio(next, prev) {
  const left = Math.log(Math.max(Number(next) || 0, LOG_EPS))
  const right = Math.log(Math.max(Number(prev) || 0, LOG_EPS))
  return left - right
}

/**
 * Split seeds into hard, mid, and easy by frozen difficulty, low difficulty first.
 * For 50 seeds this is 16 hard, 18 mid, and 16 easy. Ties keep the lower index first.
 * @param {number[]} difficulty
 * @returns {{ band: string[], hard: number[], mid: number[], easy: number[] }}
 */
export function assignBands(difficulty) {
  const n = difficulty.length
  const hardCut = Math.floor(n / 3)
  const easyCut = Math.ceil((2 * n) / 3)
  const order = difficulty.map((value, index) => ({ value, index }))
  order.sort((left, right) => left.value - right.value || left.index - right.index)
  const band = Array(n)
  const hard = []
  const mid = []
  const easy = []
  order.forEach((item, rank) => {
    const name = rank < hardCut ? 'hard' : rank >= easyCut ? 'easy' : 'mid'
    band[item.index] = name
    if (name === 'hard') hard.push(item.index)
    else if (name === 'easy') easy.push(item.index)
    else mid.push(item.index)
  })
  return { band, hard, mid, easy }
}

function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function spread(values) {
  if (values.length === 0) return 0
  const center = mean(values)
  return Math.sqrt(mean(values.map(value => (value - center) ** 2)))
}

/**
 * Easy seeds where `q` misses the parent floor or the baseline floor.
 * @returns {Array<{ seed: number, q: number, parent_q: number|null, baseline_q: number, parent_floor: number, baseline_floor: number }>}
 */
export function easyFailures(q, parentQ, difficulty, band, floor) {
  const failures = []
  for (let index = 0; index < q.length; index += 1) {
    if (band[index] !== 'easy') continue
    const parentValue = parentQ ? parentQ[index] : difficulty[index]
    const parentFloor = floor * parentValue
    const baselineFloor = floor * difficulty[index]
    if (q[index] + 1e-12 < parentFloor || q[index] + 1e-12 < baselineFloor) {
      failures.push({
        seed: index,
        q: q[index],
        parent_q: parentQ ? parentQ[index] : null,
        baseline_q: difficulty[index],
        parent_floor: parentFloor,
        baseline_floor: baselineFloor,
      })
    }
  }
  return failures
}

/**
 * Both easy floors. The baseline itself holds them: it is the reference.
 * @returns {boolean}
 */
export function holdsEasy(q, parentQ, difficulty, band, floor) {
  return easyFailures(q, parentQ, difficulty, band, floor).length === 0
}

function emptyState() {
  return {
    version: 1,
    frozen: false,
    higherIsBetter: true,
    floor: EASY_FLOOR,
    magnitude: [],
    difficulty: [],
    band: [],
    hard: [],
    mid: [],
    easy: [],
    magnitudeDisagreements: 0,
    picks: 0,
    nicheIndex: 0,
    candidates: {},
  }
}

/**
 * @param {object} files - evolve.files
 * @returns {Promise<object|null>} the frozen ledger, or null when there is none
 */
export async function loadState(files) {
  if (!files?.read) return null
  const text = await files.read(STATE_PATH)
  if (!text) return null
  const state = JSON.parse(text)
  if (!state || state.frozen !== true || !Array.isArray(state.difficulty) || state.difficulty.length === 0) {
    return null
  }
  state.candidates ??= {}
  state.hard ??= []
  state.easy ??= []
  state.mid ??= []
  state.picks ??= 0
  state.nicheIndex ??= 0
  return state
}

/**
 * @param {object} files
 * @param {number} fallback
 * @returns {Promise<number>}
 */
export async function readFloor(files, fallback = EASY_FLOOR) {
  const text = await files?.read?.(FLOOR_PATH)
  if (!text) return fallback
  try {
    const value = Number(JSON.parse(text).easy)
    if (Number.isFinite(value) && value > 0 && value <= 1) return value
  } catch {
    // A broken floor file keeps the previous floor. It does not unlock magnitude or difficulty.
  }
  return fallback
}

function parentQuality(state, row) {
  if (!row?.parent) return null
  const parent = state.candidates[row.parent]
  return parent?.q ?? null
}

/**
 * Recompute one candidate's gates and log objectives from frozen D and the current floor.
 * Stored booleans are not trusted, so a floor edit applies without re-evaluating.
 * @param {object} state
 * @param {string} id
 * @param {number} floor
 */
export function assess(state, id, floor = state?.floor ?? EASY_FLOOR) {
  const row = state?.candidates?.[id]
  const unknown = {
    id,
    known: false,
    holdsEasy: false,
    hardMeanLog: Number.NEGATIVE_INFINITY,
    meanLift: Number.NEGATIVE_INFINITY,
    q: [],
    parent: null,
  }
  if (!state?.frozen || !row || !Array.isArray(row.q) || row.q.length !== state.difficulty.length) {
    return unknown
  }
  const parentQ = parentQuality(state, row)
  const isBaseline = row.parent == null
  const easy = isBaseline || (parentQ
    ? holdsEasy(row.q, parentQ, state.difficulty, state.band, floor)
    : holdsEasy(row.q, null, state.difficulty, state.band, floor))
  const hardMeanLog = mean((state.hard ?? []).map(index => logRatio(row.q[index], state.difficulty[index])))
  const meanLift = !isBaseline && parentQ
    ? mean(row.q.map((value, index) => logRatio(value, parentQ[index])))
    : 0
  return {
    id,
    known: true,
    holdsEasy: easy,
    hardMeanLog,
    meanLift,
    q: row.q,
    parent: row.parent ?? null,
  }
}

function compareFinite(left, right) {
  const leftOk = Number.isFinite(left)
  const rightOk = Number.isFinite(right)
  if (leftOk && rightOk && left !== right) return right - left
  if (leftOk !== rightOk) return leftOk ? -1 : 1
  return 0
}

/** Negative when `a` should rank above `b`. Gate holders come first, then hard-seed log, then lift. */
export function compareRank(a, b) {
  if (a.known !== b.known) return a.known ? -1 : 1
  if (a.holdsEasy !== b.holdsEasy) return a.holdsEasy ? -1 : 1
  const byHard = compareFinite(a.hardMeanLog, b.hardMeanLog)
  if (byHard !== 0) return byHard
  const byLift = compareFinite(a.meanLift, b.meanLift)
  if (byLift !== 0) return byLift
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * The program to carry forward: best gate-holder by hard-seed log, then lift.
 * @param {object|null} state
 * @param {number} [floor]
 * @returns {{ id: string, objective: number, holdsEasy: boolean }|null}
 */
export function seedChampion(state, floor = state?.floor ?? EASY_FLOOR) {
  if (!state?.frozen) return null
  const ranked = Object.keys(state.candidates)
    .map(id => assess(state, id, floor))
    .filter(row => row.known)
    .sort(compareRank)
  if (ranked.length === 0) return null
  return { id: ranked[0].id, objective: ranked[0].hardMeanLog, holdsEasy: ranked[0].holdsEasy }
}

/**
 * Choose a parent. Every 5th choice, among candidates that hold both easy floors,
 * take the one with the highest quality on the next hard seed. A candidate that
 * misses an easy floor is not eligible for that niche pick. When nobody holds
 * the floors, rank the alive candidates by the same objective so the search
 * does not stall and does not fall back to raw points.
 *
 * Returns null when the ledger knows none of the alive ids. The caller then
 * uses the original fitness-proportional select.
 * @param {object} state
 * @param {string[]} aliveIds
 * @param {() => number} [random]
 */
export function chooseParent(state, aliveIds, random = Math.random) {
  const floor = state.floor ?? EASY_FLOOR
  const known = aliveIds.map(id => assess(state, id, floor)).filter(row => row.known)
  if (known.length === 0) return null
  const holders = known.filter(row => row.holdsEasy)
  const pool = (holders.length > 0 ? holders : known).slice().sort(compareRank)
  const picks = (state.picks ?? 0) + 1
  let nicheIndex = state.nicheIndex ?? 0
  if (picks % NICHE_EVERY === 0 && holders.length > 0 && (state.hard ?? []).length > 0) {
    const seed = state.hard[nicheIndex % state.hard.length]
    const ranked = holders.slice().sort((left, right) => {
      const gap = (right.q[seed] ?? 0) - (left.q[seed] ?? 0)
      if (Math.abs(gap) > 1e-15) return gap
      return compareRank(left, right)
    })
    return { id: ranked[0].id, picks, nicheIndex: nicheIndex + 1, niche: true, seed }
  }
  const weights = pool.map(row => Math.exp(Math.max(-20, Math.min(20, row.hardMeanLog))))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let ticket = random() * total
  for (let index = 0; index < pool.length; index += 1) {
    ticket -= weights[index]
    if (ticket <= 0) return { id: pool[index].id, picks, nicheIndex, niche: false, seed: null }
  }
  return { id: pool[pool.length - 1].id, picks, nicheIndex, niche: false, seed: null }
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toPrecision(8)) : value
}

function buildSummary(state, floor) {
  const champion = seedChampion(state, floor)
  const ids = Object.keys(state.candidates).sort()
  const newestId = ids[ids.length - 1]
  const newest = newestId ? assess(state, newestId, floor) : null
  const newestRow = newestId ? state.candidates[newestId] : null
  const newestParentQ = newestRow ? parentQuality(state, newestRow) : null
  const lifts = newest && newestParentQ
    ? newest.q.map((value, index) => logRatio(value, newestParentQ[index]))
    : []
  const positive = lifts.filter(value => value > 1e-12).length
  const negative = lifts.filter(value => value < -1e-12).length
  const easyRegressions = []
  for (const id of ids) {
    const row = state.candidates[id]
    if (row.parent == null) continue
    const parentQ = parentQuality(state, row)
    const failures = easyFailures(row.q, parentQ, state.difficulty, state.band, floor)
    for (const failure of failures) {
      if (easyRegressions.length >= 40) break
      easyRegressions.push({ id, ...failure })
    }
  }
  const championRow = champion ? assess(state, champion.id, floor) : null
  const hardStillBehind = []
  if (championRow?.known) {
    for (const index of state.hard) {
      if (logRatio(championRow.q[index], state.difficulty[index]) < 0) hardStillBehind.push(index)
    }
  }
  return {
    official_fitness: 'combined_score, the signed mean of absolute scores. This file does not replace it.',
    deliver: champion ? champion.id : null,
    seed_best_id: champion ? champion.id : null,
    seed_best_objective: champion ? round(champion.objective) : null,
    seed_best_holds_easy: champion ? champion.holdsEasy : null,
    floor,
    higher_is_better: state.higherIsBetter,
    picks: state.picks ?? 0,
    niche_index: state.nicheIndex ?? 0,
    last_choice: state.lastChoice ?? null,
    magnitude_disagreements: state.magnitudeDisagreements ?? 0,
    bands: { hard: state.hard, mid: state.mid, easy: state.easy },
    magnitude: state.magnitude.map(round),
    difficulty: state.difficulty.map(round),
    newest_id: newestId ?? null,
    newest_lift_spread: round(spread(lifts)),
    newest_same_direction: lifts.length === 0 ? null : {
      up: positive,
      down: negative,
      flat: lifts.length - positive - negative,
    },
    hard_still_behind: hardStillBehind,
    easy_regressions: easyRegressions,
    candidates: Object.fromEntries(ids.map(id => {
      const row = assess(state, id, floor)
      return [id, {
        parent: row.parent,
        holds_easy: row.holdsEasy,
        hard_mean_log: round(row.hardMeanLog),
        mean_lift: round(row.meanLift),
        q: row.q.map(round),
      }]
    })),
  }
}

async function writeState(files, state) {
  const floor = state.floor ?? EASY_FLOOR
  await files.write(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
  await files.write(SUMMARY_PATH, `${JSON.stringify(buildSummary(state, floor), null, 2)}\n`)
}

function metricNumbers(metrics, key, length) {
  const value = metrics?.[key]
  if (!Array.isArray(value) || value.length !== length) return null
  return value
}

function parsedCases(text) {
  if (!text) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const metrics = parsed?.metrics ?? {}
  const scores = metrics.case_scores
  if (!Array.isArray(scores) || scores.length === 0) return null
  const accepted = metricNumbers(metrics, 'case_accepted', scores.length) ?? scores.map(() => true)
  const reportedMagnitude = metricNumbers(metrics, 'case_magnitude', scores.length) ?? scores.map(() => 1)
  let higher = metrics.higher_is_better
  if (typeof higher !== 'boolean') {
    const fitness = Number(parsed.fitness)
    higher = !(Number.isFinite(fitness) && fitness < 0)
  }
  const raw = scores.map((score, index) => (accepted[index] === false ? 0 : Number(score)))
  return { raw, accepted, reportedMagnitude, higher }
}

async function freezeFrom(files, measurement) {
  const magnitude = measurement.reportedMagnitude.map(value => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : 1
  })
  const q = measurement.raw.map((score, index) => quality(score, magnitude[index], measurement.higher))
  const bands = assignBands(q)
  const floor = await readFloor(files, EASY_FLOOR)
  if (!(await files.read(FLOOR_PATH))) {
    await files.write(FLOOR_PATH, `${JSON.stringify({ easy: floor }, null, 2)}\n`)
  }
  return {
    ...emptyState(),
    frozen: true,
    higherIsBetter: measurement.higher,
    floor,
    magnitude,
    difficulty: q.slice(),
    band: bands.band,
    hard: bands.hard,
    mid: bands.mid,
    easy: bands.easy,
    candidates: {
      c000000: {
        parent: null,
        q,
        accepted: measurement.accepted.map(value => value !== false),
      },
    },
  }
}

/**
 * Record one evaluation. Magnitude, difficulty, and the bands freeze from the
 * baseline evaluation, including when a resumed run scores a child first and
 * the baseline result is already in run/evals/c000000.json. Later evaluations
 * never move those numbers, even when their own case_magnitude disagrees or
 * their quality is higher.
 * @param {object} files
 * @param {string} id
 * @param {string|null} parentId
 * @returns {Promise<object|null>}
 */
export async function recordEvaluation(files, id, parentId) {
  const measurement = parsedCases(await files.read(`evals/${id}.json`))
  if (!measurement) return null
  const isBaseline = parentId == null || id === 'c000000'
  let state = await loadState(files)
  const existed = state != null
  if (!state) {
    if (isBaseline) {
      state = await freezeFrom(files, measurement)
    } else {
      const baseline = parsedCases(await files.read('evals/c000000.json'))
      if (!baseline) return null
      state = await freezeFrom(files, baseline)
    }
  }
  if ((existed || !isBaseline) && measurement.reportedMagnitude.length === state.magnitude.length) {
    const moved = measurement.reportedMagnitude.some((value, index) => {
      const number = Number(value)
      const frozen = state.magnitude[index]
      return Number.isFinite(number) && Math.abs(number - frozen) > 1e-6 * Math.max(1, Math.abs(frozen))
    })
    if (moved) state.magnitudeDisagreements = (state.magnitudeDisagreements ?? 0) + 1
    if (typeof measurement.higher === 'boolean' && measurement.higher !== state.higherIsBetter) {
      state.directionDisagreements = (state.directionDisagreements ?? 0) + 1
    }
  }
  if (measurement.raw.length !== state.magnitude.length) {
    state.caseLengthDisagreements = (state.caseLengthDisagreements ?? 0) + 1
    state.floor = await readFloor(files, state.floor ?? EASY_FLOOR)
    await writeState(files, state)
    return state
  }
  const q = measurement.raw.map((score, index) => quality(score, state.magnitude[index] ?? 1, state.higherIsBetter))
  state.candidates[id] = {
    parent: isBaseline ? null : (parentId ?? null),
    q,
    accepted: measurement.accepted.map(value => value !== false),
  }
  state.floor = await readFloor(files, state.floor ?? EASY_FLOOR)
  await writeState(files, state)
  return state
}

/**
 * Persist the niche counter after a selection. Does not touch magnitude or difficulty.
 * @param {object} files
 * @param {{ id: string, picks: number, nicheIndex: number, niche: boolean, seed: number|null }} choice
 * @param {number} floor
 */
export async function saveSelection(files, choice, floor) {
  const state = await loadState(files)
  if (!state) return
  state.picks = choice.picks
  state.nicheIndex = choice.nicheIndex
  state.floor = floor
  state.lastChoice = { id: choice.id, niche: choice.niche, seed: choice.seed }
  await writeState(files, state)
}
