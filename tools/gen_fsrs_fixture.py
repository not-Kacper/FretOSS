#!/usr/bin/env python3
"""Dump a py-fsrs reference sequence to tests/fsrs-fixture.json.

Reference side of the "FSRS ratings/intervals from ts-fsrs match py-fsrs"
acceptance criterion. `tests/srs.test.ts` replays the *same* review sequence
through src/srs/scheduler.ts and compares, field by field:

  * state / step / stability / difficulty / due after every review
  * the unfuzzed interval (fuzzing disabled → fully deterministic)
  * the fuzz range py-fsrs would draw from, so the ts-fsrs fuzzed path can be
    checked for correctness too (see `fuzz_range` below)

Requires the real py-fsrs (the package the Python app pins):

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python tools/gen_fsrs_fixture.py

Knobs come from public/config.json's `srs` block, and the sequence is written
with explicit second offsets so the fixture is stable across machines.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fsrs import Card, Rating, Scheduler
from fsrs.scheduler import FUZZ_RANGES

REPO = Path(__file__).resolve().parent.parent

# Deliberately late in the UTC day: py-fsrs measures elapsed time as
# `(review_datetime - last_review).days` (exact timedelta), while ts-fsrs's
# internals use calendar-day differences. Starting near midnight exercises the
# difference between those two conventions.
BASE = datetime(2026, 1, 5, 23, 30, tzinfo=timezone.utc)

# (rating name, seconds since the previous review) — hand-written to cover every
# branch of Scheduler.review_card(): new card, both learning steps, graduation,
# same-day short-term reviews, review-state recalls/forgets, relearning steps
# (Again / Hard-with-one-step / Good graduation), Easy, and long intervals.
SEQUENCE: list[tuple[str, int]] = [
    ("Good", 0),
    ("Good", 10 * 60),
    ("Good", 86_400 + 30 * 60),
    ("Again", 2 * 86_400),
    ("Good", 10 * 60),
    ("Hard", 3 * 3600),  # same-day review in Review state → short-term formula
    ("Easy", 2 * 86_400 + 4 * 3600),
    ("Again", 5 * 86_400),
    ("Again", 3600),
    ("Hard", 15 * 60),  # relearning step 0, single step → 1.5 x 10m
    ("Good", 10 * 60),
    ("Good", 30 * 86_400),
    ("Hard", 30 * 86_400),
    ("Easy", 60 * 86_400),
    ("Good", 86_400),
    ("Again", 25 * 3600),  # 1 day + 1h → elapsed_days == 1
    ("Easy", 10 * 60),
    ("Good", 45 * 86_400),
    ("Good", 120 * 86_400),
    ("Again", 400 * 86_400),
]

RATING_BY_NAME = {
    "Again": Rating.Again,
    "Hard": Rating.Hard,
    "Good": Rating.Good,
    "Easy": Rating.Easy,
}


def fuzz_range(interval_days: int, maximum_interval: int) -> tuple[int, int]:
    """`Scheduler._get_fuzzed_interval`'s range computation, verbatim.

    Intervals shorter than 2.5 days are returned unchanged (no fuzz).
    """
    if interval_days < 2.5:
        return interval_days, interval_days

    delta = 1.0
    for fuzz_range_entry in FUZZ_RANGES:
        delta += fuzz_range_entry["factor"] * max(
            min(float(interval_days), fuzz_range_entry["end"]) - fuzz_range_entry["start"],
            0.0,
        )
    min_ivl = int(round(interval_days - delta))
    max_ivl = int(round(interval_days + delta))
    min_ivl = max(2, min_ivl)
    max_ivl = min(max_ivl, maximum_interval)
    min_ivl = min(min_ivl, max_ivl)
    return min_ivl, max_ivl


def build_scheduler(srs_config: dict, enable_fuzzing: bool) -> Scheduler:
    return Scheduler(
        parameters=tuple(
            float(v) for v in srs_config.get("parameters", Scheduler.__init__.__defaults__[0])
        ),
        desired_retention=float(srs_config.get("desired_retention", 0.9)),
        learning_steps=tuple(
            timedelta(minutes=float(v)) for v in srs_config.get("learning_steps_minutes", [1, 10])
        ),
        relearning_steps=tuple(
            timedelta(minutes=float(v)) for v in srs_config.get("relearning_steps_minutes", [10])
        ),
        maximum_interval=int(srs_config.get("maximum_interval_days", 36500)),
        enable_fuzzing=enable_fuzzing,
    )


def run_sequence(scheduler: Scheduler, card_id: int = 7007) -> list[dict]:
    card = Card(card_id=card_id, due=BASE)
    steps: list[dict] = []
    at = BASE

    for index, (rating_name, delta_seconds) in enumerate(SEQUENCE):
        at = at + timedelta(seconds=delta_seconds) if index else BASE
        rating = RATING_BY_NAME[rating_name]
        card, review_log = scheduler.review_card(card, rating, review_datetime=at, review_duration=1234)
        interval_days = int(round((card.due - at).total_seconds() / 86_400))

        steps.append(
            {
                "index": index,
                "rating": rating_name,
                "rating_value": int(rating),
                "delta_seconds_from_previous": delta_seconds,
                "review_datetime": at.isoformat(),
                # `Scheduler._next_interval` (pre-fuzz, whole days) is implicit in
                # the unfuzzed due date.
                "interval_days_unfuzzed": interval_days,
                # py-fsrs fuzzes only Review-state intervals (and only >= 2.5
                # days), which `fuzz_range` itself checks.
                "fuzz_range_days": list(
                    fuzz_range(interval_days, scheduler.maximum_interval)
                    if card.state.value == 2
                    else [interval_days, interval_days]
                ),
                "card": card.to_dict(),
                "review_log": review_log.to_dict(),
            }
        )

    return steps


def main() -> int:
    config = json.loads((REPO / "public" / "config.json").read_text(encoding="utf-8"))
    srs_config = config.get("srs", {})

    deterministic = build_scheduler(srs_config, enable_fuzzing=False)
    card_id = 7007
    steps = run_sequence(deterministic, card_id)

    payload = {
        "generated_by": "tools/gen_fsrs_fixture.py",
        "reference": "py-fsrs 6.3.1 (fsrs==6.3.1, see requirements.txt)",
        "config": {
            "parameters": list(deterministic.parameters),
            "desired_retention": deterministic.desired_retention,
            "learning_steps_minutes": [
                step.total_seconds() / 60 for step in deterministic.learning_steps
            ],
            "relearning_steps_minutes": [
                step.total_seconds() / 60 for step in deterministic.relearning_steps
            ],
            "maximum_interval_days": deterministic.maximum_interval,
        },
        "base_time": BASE.isoformat(),
        "card_id": card_id,
        "steps": steps,
    }

    out_path = REPO / "tests" / "fsrs-fixture.json"
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path.relative_to(REPO)} ({len(steps)} reviews)")
    for step in steps:
        print(
            f"  {step['index']:2d} {step['rating']:<5} state={step['card']['state']} "
            f"step={step['card']['step']} ivl={step['interval_days_unfuzzed']}d "
            f"S={step['card']['stability']!r} D={step['card']['difficulty']!r}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
