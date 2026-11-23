---
name: seed-balance
description: Use when a task's evaluator returns per-seed case_scores. Ranks parents and survivors by quality with each seed's magnitude and frozen difficulty removed, and keeps easy seeds from falling while hard seeds rise.
---

# Seed balance

Load this skill before the first `evolve_run` on a task whose evaluator returns `case_scores`. The ALE-Bench evaluators in this tree do. A task whose evaluations have no `case_scores` is unchanged: the seed-balance providers delegate to the original select, mutate, and survive, and this skill does not apply.

The search is still select, then mutate, then evaluate, then record, then survive. Official fitness is still the evaluator's `combined_score`, the signed mean of the absolute scores, stored on each population row. `best_id` is still the champion by that official fitness. The program to carry forward, and the program to report as the result of the search, is `seed_best_id`.

## What is frozen

For each of this problem's public seeds the ledger separates three numbers:

- **Magnitude** `M`. It comes from that seed's input and this problem's score formula. It is the scale of the raw score. It is not a difficulty, and it is not the baseline's raw score.
- **Quality** `q`. When a higher raw score is better, `q = raw / M`. When a lower raw score is better, `q = M / raw`. A seed that was not accepted has `q = 0`. It is not entered as a raw zero in the mean.
- **Difficulty** `D`. It is the baseline `c000000` quality on that seed. It is frozen at the baseline evaluation. A later, stronger program does not change it. The baseline's raw score is `M` times `D` (or `M / D` when lower is better). It is not itself `D`, and it is not `M`.

Bands are frozen with `D`, by sorting the 50 difficulties. The lowest third is hard, the highest third is easy, and the rest is the middle. For 50 seeds that is 16 hard, 18 middle, and 16 easy.

Comparable improvement across seeds is `log(q_child / q_parent)`. A doubling of quality is the same kind of gain on a small raw score and on a huge one. A raw point gap is not comparable, and neither is a gap of `q` values that still sit on different magnitudes.

`run/seed-ledger/state.json` holds the frozen numbers and every candidate's `q`. `run/seed-ledger/summary.json` is the view to read between chunks. `run/seed-ledger/floor.json` is `{ "easy": 0.97 }`. `run/seed-ledger/notes/<id>.txt` is the worker's reply for that candidate.

Do not edit `magnitude`, `difficulty`, or `band` in the state file. If a later evaluation reports a different `case_magnitude`, the ledger keeps the frozen one and counts the disagreement in the summary. Do not take magnitude or difficulty from a private-test file, from a moving local best, or from another problem.

## What the starting providers do

`seed-balance` is the active select, mutate, and survive. The original providers stay underneath. A provider you register with `evolve_define` stacks on top of `seed-balance`, same as before.

**Select.** Alive candidates that hold both easy floors are ranked by their mean log-quality on the hard seeds against `D`, then by their mean log-lift over the parent. Official fitness is not a weight. Every 5th selection, among those same floor-holders, the parent is the one with the highest `q` on the next hard seed. A candidate that misses an easy floor is not eligible for that pick. If nobody holds the floors, selection still uses this ranking over the alive candidates, so the search does not stall and does not go back to raw points.

**Survive.** The same order. Floor-holders outrank the rest. Official fitness does not decide who stays.

**Mutate.** The worker is told the hard-seed table (`D`, the parent's `q`, alpha `q - D`) and the easy-seed floors. The reply is saved under `run/seed-ledger/notes/`. The instruction requires all of the following, and it does not name an algorithm, a schedule, or parameter values:

- a feasible solution on every seed before time is spent on quality
- behavior that depends on the current input
- more than one construction inside the one program, chosen on each seed by that seed's own score
- the remaining time spent improving the current input
- the parent's easy-seed behavior kept as a fallback unless the replacement holds both floors on that seed

Both floors are `q >= floor * parent q` and `q >= floor * baseline q`, on every easy seed. The second floor stops a lineage that already dropped an easy seed from treating that drop as the new normal. A parent chosen for a hard seed is bound by both floors too.

## Between chunks

Read `run/seed-ledger/summary.json` after each chunk. Also read the new population rows: their `fitness` is the official mean, which can rise while easy seeds fall.

- **Easy seeds fell while the official mean rose.** The summary's `easy_regressions` names the candidate and the seed. The next parents must be floor-holders. Do not treat the official-mean champion as the parent line when it fails the floors.
- **Hard seeds are still behind the baseline.** `hard_still_behind` lists them for `seed_best_id`. The next worker brief should keep those seeds in view. The niche pick already rotates through the hard seeds.
- **All seeds moved together.** `newest_lift_spread` near zero, with `newest_same_direction` almost all up or all down, means the last program is still one global change. The next brief should insist that behavior depend on the current input.
- **The floor blocks every child.** `easy_regressions` covers every new candidate and the hard seeds are not moving. Loosen the floor. Widespread easy drops mean the opposite: tighten it.

To change the floor, write `run/seed-ledger/floor.json` as `{ "easy": 0.95 }` (or a tighter value) between chunks. The next selection, survival, and worker brief recompute the gates from the stored `q` values. They do not need the candidates to be re-evaluated. Keep the value in `(0, 1]`.

Larger changes to how parents are chosen, how workers are briefed, or who survives still go through `evolve_define` and `evolve_activate`, replacing select, mutate, or survive. Those replacements must keep both easy floors, including for a parent picked because it is best on a hard seed, unless the diagnosis above is a reason to change the floor itself. They must not rewrite `M` or `D`, must not record a per-seed measurement as official fitness, and must not change the evaluator, the instances, the budget, or `allocate` / `copyTask`.

## What to report

`evolve_run` returns `best_id` and `best_fitness` for the official mean, and `seed_best_id` with `seed_best_objective` (the mean log-quality on hard seeds against `D`) when the ledger exists. Report both. The directory to keep is `<task>/run/candidates/<seed_best_id>`. `best_id` stays available so the official mean can be audited. Do not submit the official-mean champion in place of `seed_best_id` when the two differ.
