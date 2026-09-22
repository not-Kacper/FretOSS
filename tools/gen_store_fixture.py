#!/usr/bin/env python3
"""Dump a `ProgressStore` session + queue reference to tests/store-fixture.json.

The Python `ProgressStore` is the reference for everything the browser store
does: record shape, point counters, review logs, queue buckets, priority
ordering, selection and the adaptive new-card allowance.

`tests/store.test.ts` replays the identical scripted session through
src/storage/progress-idb.ts (IndexedDB via fake-indexeddb) and compares:

  * every touched record field by field (card, points, attempts, correct,
    wrong, prompt_count, timestamps, review entries)
  * a compact summary of all 78 cards
  * the queue buckets at a pinned `now` (classification + ordering)
  * `queue_stats`, `select_next_target` (several probe sets: no recent keys,
    leading recent keys, every candidate recent, a one-candidate window, and the
    single-candidate early return) and `next_due`

Randomness is pinned on both sides (`random.random() -> 0.0`,
`random.choice(seq) -> seq[0]`) so the ordering assertions are deterministic;
fuzzing is disabled so the due dates are reproducible.

Requires the real py-fsrs:

    .venv/bin/python tools/gen_store_fixture.py
"""

from __future__ import annotations

import importlib.util
import json
import random
import sys
import tempfile
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Session times (UTC) — reviews happen inside an hour, then the queue is
# inspected ~2 days later so several buckets are populated.
SESSION_START = datetime(2026, 2, 1, 20, 0, tzinfo=timezone.utc)
QUEUE_NOW = datetime(2026, 2, 3, 21, 0, tzinfo=timezone.utc)

# (target_key, rating, seconds after SESSION_START, duration_ms, detected_midi)
SCRIPT: list[tuple[str, str, int, int, int | None]] = [
    ("s6_f00", "Good", 0, 4210, 40),
    ("s6_f00", "Hard", 15 * 60, 6100, 41),  # wrong note first, then correct slowly
    ("s5_f02", "Again", 20 * 60, 1200, 44),
    ("s5_f02", "Again", 30 * 60, 900, 42),
    ("s4_f05", "Easy", 25 * 60, 1500, 50),
    ("s3_f07", "Hard", 26 * 60, 5400, 54),
    ("s2_f09", "Again", 27 * 60, 800, 61),
    ("s2_f09", "Good", 29 * 60, 1300, 64),
    ("s1_f03", "Good", 31 * 60, 1900, 67),
    ("s1_f03", "Good", 34 * 60, 1400, 68),
    ("s6_f01", "Good", 36 * 60, 1100, 41),
    ("s6_f01", "Easy", 40 * 60, 700, 41),
]

# Targets that were shown to the user (main.py calls mark_prompted on selection).
PROMPTED: list[tuple[str, int]] = [
    ("s6_f00", 0),
    ("s5_f02", 20 * 60),
    ("s4_f05", 25 * 60),
    ("s3_f07", 26 * 60),
    ("s2_f09", 27 * 60),
    ("s1_f03", 31 * 60),
    ("s6_f01", 36 * 60),
]

# Recent keys handed to select_next_target (the last six prompts of a session).
RECENT_KEYS = ["s6_f01", "s1_f03", "s2_f09", "s3_f07", "s4_f05", "s5_f02"]


def _stub_missing_deps() -> None:
    """aubio/pyaudio/numpy are imported by main.py but unused by the store path."""
    for name in ("aubio", "pyaudio", "numpy"):
        if name in sys.modules:
            continue
        try:
            __import__(name)
        except ImportError:
            module = types.ModuleType(name)
            if name == "numpy":
                module.log2 = lambda value: 0.0
            sys.modules[name] = module


def load_main_module():
    _stub_missing_deps()
    spec = importlib.util.spec_from_file_location("srs_main", REPO / "main.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["srs_main"] = module
    spec.loader.exec_module(module)
    return module


def summarize(record: dict) -> dict:
    """The deterministic part of a record (new cards' `due` is wall-clock)."""
    card = dict(record["card"])
    is_new = card["last_review"] is None and int(record.get("attempts", 0)) == 0
    if is_new:
        card["due"] = "NEW_CARD_DUE"  # generation-time timestamp, not reproducible
    return {
        "card": card,
        "points": int(record.get("points", 0)),
        "attempts": int(record.get("attempts", 0)),
        "correct": int(record.get("correct", 0)),
        "wrong": int(record.get("wrong", 0)),
        "prompt_count": int(record.get("prompt_count", 0)),
        "last_prompted_at": record.get("last_prompted_at"),
        "last_reviewed_at": record.get("last_reviewed_at"),
        "review_count": len(record.get("reviews", [])),
        "reviews": record.get("reviews", []),
    }


def main() -> int:
    # Deterministic PRNG for the priority tie-breakers, mirroring what the TS
    # test injects.
    random.random = lambda: 0.0  # type: ignore[assignment]
    random.choice = lambda seq: seq[0]  # type: ignore[assignment]

    main_module = load_main_module()
    config = main_module.ConfigManager(REPO / "public" / "config.json")

    # Fuzzing off so the reference due dates are reproducible.
    raw_srs = dict(config.srs_config)
    raw_srs["enable_fuzzing"] = False
    config.raw["srs"] = raw_srs

    scheduler = config.create_scheduler()
    deck = main_module.FretboardDeck(config)
    target_by_key = {target.key: target for target in deck.targets}

    with tempfile.TemporaryDirectory() as tmpdir:
        progress = main_module.ProgressStore(
            Path(tmpdir) / "progress.json", scheduler, deck.targets
        )

        for key, seconds in PROMPTED:
            progress.mark_prompted(target_by_key[key], SESSION_START + timedelta(seconds=seconds))

        for key, rating_name, seconds, duration_ms, detected_midi in SCRIPT:
            progress.review(
                target_by_key[key],
                getattr(main_module.Rating, rating_name),
                SESSION_START + timedelta(seconds=seconds),
                duration_ms,
                detected_midi=detected_midi,
            )

        buckets = progress._queue_buckets(QUEUE_NOW)
        allowance = config.new_card_allowance(0.0)
        selected = progress.select_next_target(
            QUEUE_NOW, allowance, 0, config.random_candidate_window, RECENT_KEYS
        )
        selected_no_recent = progress.select_next_target(
            QUEUE_NOW, allowance, 0, config.random_candidate_window, []
        )
        stats = progress.queue_stats(QUEUE_NOW, allowance, 0)
        next_due = progress.next_due()

        # `_pick_candidate()` branches: the random window, the "prefer a target
        # that was not just shown" filter, the Python fallback when *every*
        # candidate in the pool is recent, and the single-candidate shortcut.
        learning_keys = [item[0].key for item in buckets["learning_due"]]
        probes = [
            ("window_8_no_recent", [], config.random_candidate_window),
            ("window_8_last_six_recent", RECENT_KEYS, config.random_candidate_window),
            ("leading_two_recent", learning_keys[:2], config.random_candidate_window),
            ("all_pool_recent", learning_keys, config.random_candidate_window),
            ("window_one", [], 1),
        ]
        selection_probes = []
        for name, recent, window in probes:
            picked = progress.select_next_target(QUEUE_NOW, allowance, 0, window, recent)
            selection_probes.append(
                {
                    "name": name,
                    "recent_keys": recent,
                    "random_window": window,
                    "expected_key": picked.key if picked else None,
                }
            )
        single = progress._pick_candidate(
            buckets["learning_due"][:1], config.random_candidate_window, set()
        )
        selection_probes.append(
            {
                "name": "single_candidate",
                "recent_keys": [],
                "random_window": config.random_candidate_window,
                "expected_key": single.key,
            }
        )

        payload = {
            "generated_by": "tools/gen_store_fixture.py",
            "reference": "main.py ProgressStore (fsrs==6.3.1, fuzzing disabled)",
            "config": {
                "srs": raw_srs,
                "deck": config.deck_config,
                "random_candidate_window": config.random_candidate_window,
                "initial_new_cards": config.initial_new_cards,
                "new_card_interval_sec": config.new_card_interval_sec,
            },
            "session_start": SESSION_START.isoformat(),
            "queue_now": QUEUE_NOW.isoformat(),
            "prompted": [{"key": key, "at": (SESSION_START + timedelta(seconds=s)).isoformat()} for key, s in PROMPTED],
            "script": [
                {
                    "key": key,
                    "rating": rating_name,
                    "at": (SESSION_START + timedelta(seconds=seconds)).isoformat(),
                    "duration_ms": duration_ms,
                    "detected_midi": detected_midi,
                }
                for key, rating_name, seconds, duration_ms, detected_midi in SCRIPT
            ],
            "expected": {
                "records": {
                    key: summarize(progress.data["cards"][key])
                    for key in sorted({step[0] for step in SCRIPT})
                },
                "all_cards": {
                    key: summarize(record) for key, record in progress.data["cards"].items()
                },
                "queue": {
                    "learning_due": [item[0].key for item in buckets["learning_due"]],
                    "review_due": [item[0].key for item in buckets["review_due"]],
                    "new": [item[0].key for item in buckets["new"]],
                    "future": [item[0].key for item in buckets["future"]],
                    "stats": {
                        "learning_due": stats.learning_due,
                        "review_due": stats.review_due,
                        "new_available": stats.new_available,
                        "new_total": stats.new_total,
                        "future": stats.future,
                        "available": stats.available,
                    },
                },
                "selection": {
                    "allowance": allowance,
                    "recent_keys": RECENT_KEYS,
                    "with_recent_keys": selected.key if selected else None,
                    "without_recent_keys": selected_no_recent.key if selected_no_recent else None,
                    "probes": selection_probes,
                },
                "next_due": (
                    {"key": next_due[0].key, "due": next_due[1].due.isoformat()}
                    if next_due
                    else None
                ),
            },
        }

    out_path = REPO / "tests" / "store-fixture.json"
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path.relative_to(REPO)}")
    print("  buckets:", {name: len(keys) for name, keys in payload["expected"]["queue"].items() if isinstance(keys, list)})
    print("  selection:", payload["expected"]["selection"])
    for probe in payload["expected"]["selection"]["probes"]:
        print(f"    {probe['name']:24s} -> {probe['expected_key']}")
    print("  scripted reviews:", len(SCRIPT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
