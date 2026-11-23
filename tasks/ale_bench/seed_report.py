"""Per-seed measurements for one ALE-Bench problem's public cases.

The official fitness stays ``combined_score`` (the signed mean of absolute
scores). This module only adds, for each public seed:

- the absolute score, or 0 when that seed was not accepted
- whether the seed was accepted
- a magnitude that belongs to the seed, not to the program

Magnitude is computed from that seed's input and this problem's score formula.
It is the scale of the raw score. It is not the seed's difficulty, and it does
not move when a later program scores higher. Difficulty is computed later, in
the search ledger, as the baseline program's quality on that frozen scale.

The ten evaluators call :func:`seed_fields`. Nothing else about the official
score formula lives here.
"""

from __future__ import annotations


def _case_text(case) -> str:
    """Return the case input as text. ``case_gen`` returns strings."""
    if isinstance(case, str):
        return case
    if isinstance(case, dict):
        for key in ("input", "text", "content"):
            value = case.get(key)
            if isinstance(value, str):
                return value
    for attr in ("input", "text", "content"):
        value = getattr(case, attr, None)
        if isinstance(value, str):
            return value
    return str(case)


def _accepted(case_result) -> bool:
    judge = case_result.get("judge_result") if isinstance(case_result, dict) else getattr(case_result, "judge_result", None)
    name = getattr(judge, "name", None)
    value = getattr(judge, "value", None)
    token = str(name or value or judge).strip().upper()
    return token in {"ACCEPTED", "AC"}


def _absolute(case_result) -> float:
    raw = case_result.get("absolute_score") if isinstance(case_result, dict) else getattr(case_result, "absolute_score", 0)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def _first_ints(text: str, count: int) -> list[int]:
    values = []
    for token in text.split():
        try:
            values.append(int(token))
        except ValueError:
            continue
        if len(values) >= count:
            break
    return values


def _positive(value: float, fallback: float) -> float:
    if value > 0:
        return float(value)
    return float(fallback)


def _ahc027_dirt_sum(text: str) -> float:
    """Sum of the visible dirt grid. Score is round(mean dirtiness); this sum is the seed's scale.

    Layout: N, then N-1 wall rows, then N wall rows, then N rows of N dirt values.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return 1.0
    n = int(lines[0].split()[0])
    if n < 1:
        return 1.0
    start = 1 + (n - 1) + n
    total = 0
    for line in lines[start:start + n]:
        total += sum(int(token) for token in line.split())
    return _positive(total, 1.0)


def magnitude_of(problem_id: str, case_input) -> float:
    """Seed-only magnitude for one public case.

    A failure to parse an input falls back to 1.0 so a measurement problem
    cannot wipe the official score. The fallback is not a difficulty.
    """
    try:
        return _magnitude(problem_id, _case_text(case_input))
    except (ValueError, IndexError, TypeError):
        return 1.0


def _magnitude(problem_id: str, text: str) -> float:
    # ahc008: round(1e8 * mean satisfaction). Satisfaction is at most 1, so the
    # point ceiling is 1e8 on every seed. The input's person count is a different
    # quantity and is not this magnitude.
    if problem_id == "ahc008":
        return 1e8

    # ahc011: the score is already divided by N^2-1, and a complete board scores
    # at most round(500000 * 2). N changes difficulty. The point ceiling does not.
    if problem_id == "ahc011":
        return 1_000_000.0

    # ahc015: round(1e6 * sum n_i^2 / sum d_i^2). The ratio is at most 1.
    if problem_id == "ahc015":
        return 1e6

    # ahc016: round(1e9 * 0.9^E / N). N is chosen by the program, so it is not a
    # property of the seed. The input's graph count and epsilon change difficulty.
    # The shared coefficient 1e9 is the seed-only scale.
    if problem_id == "ahc016":
        return 1e9

    # ahc024: score is E+1, and E cannot exceed the n*n squares. Read n.
    if problem_id == "ahc024":
        n = _first_ints(text, 1)
        side = n[0] if n else 50
        return _positive(side * side + 1, 2501.0)

    # ahc025: absolute score is 1+round(100*sqrt(V)). The item weights are not
    # shown to the program. The tester file may contain them; they are not used.
    # N is the visible instance size, not a score ceiling. The coefficient 100
    # is shared by every seed.
    if problem_id == "ahc025":
        nums = _first_ints(text, 1)
        n = nums[0] if nums else 1
        return _positive(n, 1.0)

    # ahc026: score is max(1, 10000-V). The ceiling is 10000 on every seed.
    if problem_id == "ahc026":
        return 10000.0

    # ahc027: minimize round(mean dirtiness). The dirt grid is visible.
    if problem_id == "ahc027":
        return _ahc027_dirt_sum(text)

    # ahc039: score is max(0, a-b+1). At most every mackerel and no sardine, so
    # the ceiling is N+1. Read N; the statement fixes it at 5000, the input still carries it.
    if problem_id == "ahc039":
        nums = _first_ints(text, 1)
        n = nums[0] if nums else 5000
        return _positive(n + 1, 5001.0)

    # ahc046: a complete visit scores M+2NM-T, whose ceiling at T=0 is M+2NM.
    # Read N and M. The statement fixes them at 20 and 40.
    if problem_id == "ahc046":
        nums = _first_ints(text, 2)
        n = nums[0] if nums else 20
        m = nums[1] if len(nums) > 1 else 40
        return _positive(m + 2 * n * m, 1640.0)

    return 1.0


def seed_fields(problem_id: str, cases, case_results, score_type: str) -> dict:
    """Fields to merge into an evaluator result. Does not include combined_score."""
    cases = list(cases)
    case_results = list(case_results)
    if len(cases) != len(case_results):
        raise ValueError(
            f"{problem_id}: {len(cases)} public cases but {len(case_results)} case results"
        )
    scores = []
    accepted = []
    magnitudes = []
    for case, result in zip(cases, case_results):
        ok = _accepted(result)
        accepted.append(ok)
        scores.append(_absolute(result) if ok else 0.0)
        magnitudes.append(magnitude_of(problem_id, case))
    return {
        "case_scores": scores,
        "case_accepted": accepted,
        "case_magnitude": magnitudes,
        "higher_is_better": score_type == "maximize",
    }


def _self_check() -> None:
    assert magnitude_of("ahc008", "0 1\n") == 1e8
    assert magnitude_of("ahc011", "6 432\n") == 1_000_000.0
    assert magnitude_of("ahc015", "1 2 3\n") == 1e6
    assert magnitude_of("ahc016", "10 0.10\n0\n1\n") == 1e9
    assert magnitude_of("ahc024", "50 100\n1 2\n") == 2501.0
    # Weights are present and must not become the magnitude.
    assert magnitude_of("ahc025", "40 4 200\n9 9 9 9\n") == 40.0
    assert magnitude_of("ahc026", "200 10\n1 2\n") == 10000.0
    ahc027 = "\n".join(["2", "01", "0", "1", "1 2", "3 4"]) + "\n"
    assert magnitude_of("ahc027", ahc027) == 10.0
    assert magnitude_of("ahc039", "5000\n0 0\n") == 5001.0
    assert magnitude_of("ahc046", "20 40\n0 0\n") == 1640.0
    assert magnitude_of("ahc099", "not a known problem") == 1.0
    broken = [{"judge_result": type("J", (), {"name": "WRONG_ANSWER", "value": "WA"})(), "absolute_score": 50}]
    fields = seed_fields("ahc039", ["5000\n"], broken, "maximize")
    assert fields["case_scores"] == [0.0]
    assert fields["case_accepted"] == [False]
    assert fields["case_magnitude"] == [5001.0]
    assert fields["higher_is_better"] is True
    print("seed_report self-check ok")


if __name__ == "__main__":
    _self_check()
