"""Load and validate exported battle problems."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

REQUIRED_FIELDS = {
    "schemaVersion",
    "rulesVersion",
    "battleId",
    "battleAge",
    "baseline",
    "source",
    "researchIds",
    "candidateIds",
    "candidateStats",
    "candidateCosts",
    "enemyStacks",
    "availableFormations",
    "availableOrders",
    "ownedArmy",
    "candidateResearchIds",
    "researchCostsByCount",
    "requireMixed",
    "maximumRounds",
    "units",
    "formations",
    "fingerprint",
}


class ProblemError(ValueError):
    pass


def validate_problem(problem: dict) -> dict:
    missing = sorted(REQUIRED_FIELDS - problem.keys())
    if missing:
        raise ProblemError(f"missing fields: {', '.join(missing)}")
    if problem.get("schemaVersion") != 1:
        raise ProblemError("unsupported schemaVersion")
    if problem.get("rulesVersion") != "battle-v1":
        raise ProblemError("unsupported rulesVersion")
    if problem.get("baseline") != "scratch":
        raise ProblemError("only scratch baseline problems are supported")
    if not problem.get("candidateIds"):
        raise ProblemError("problem has no candidates")
    if not problem.get("enemyStacks"):
        raise ProblemError("problem has no enemy stacks")
    return problem


def iter_problems(path: str | Path) -> Iterator[dict]:
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                problem = json.loads(line)
            except json.JSONDecodeError as error:
                raise ProblemError(f"{path}:{line_number}: invalid JSON: {error}") from error
            try:
                yield validate_problem(problem)
            except ProblemError as error:
                raise ProblemError(f"{path}:{line_number}: {error}") from error


def load_problems(path: str | Path) -> list[dict]:
    return list(iter_problems(path))
