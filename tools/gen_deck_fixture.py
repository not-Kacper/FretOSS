#!/usr/bin/env python3
"""Dump the Python `FretboardDeck` target list to tests/deck-fixture.json.

This is the reference side of the "deck generated in TS matches the Python
deck" acceptance criterion: `tests/deck.test.ts` rebuilds the deck with
src/deck/deck.ts and compares it to this fixture field by field.

Usage (stdlib only — no aubio/pyaudio/numpy needed, they are stubbed out
because only the deck code path is exercised):

    python3 tools/gen_deck_fixture.py            # uses public/config.json
    python3 tools/gen_deck_fixture.py config.json other-config.json

The generator imports main.py with `aubio`, `pyaudio` and `numpy` replaced by
empty stub modules, so the reference implementation stays the single source of
truth for what "the Python deck" means.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _stub_missing_deps() -> None:
    """main.py imports aubio/pyaudio/numpy/fsrs at module scope.

    `FretboardDeck._build_targets()` touches none of them, so they are stubbed
    when unavailable, which keeps regenerating the deck fixture a stdlib-only
    operation (the FSRS/queue fixtures do need the real packages — see
    tools/gen_fsrs_fixture.py).
    """
    def stub(name: str, attributes: tuple[str, ...]) -> None:
        module = types.ModuleType(name)
        for attribute in attributes:
            setattr(module, attribute, type(attribute, (), {}))
        sys.modules[name] = module

    for name in ("aubio", "pyaudio", "numpy", "fsrs"):
        if name in sys.modules:
            continue
        try:
            __import__(name)
        except ImportError:
            if name == "numpy":
                module = types.ModuleType(name)
                module.log2 = lambda value: 0.0  # never reached by the deck path
                sys.modules[name] = module
            elif name == "fsrs":
                stub(name, ("Card", "Rating", "ReviewLog", "Scheduler", "State"))
            else:
                stub(name, ("pitch", "PyAudio"))


def load_main_module():
    _stub_missing_deps()
    spec = importlib.util.spec_from_file_location("srs_main", REPO / "main.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["srs_main"] = module
    spec.loader.exec_module(module)
    return module


def main(argv: list[str]) -> int:
    config_paths = [Path(p) for p in argv[1:]] or [REPO / "public" / "config.json"]
    main_module = load_main_module()

    fixtures = {}
    for config_path in config_paths:
        if not config_path.is_absolute():
            config_path = (REPO / config_path).resolve()
        config = main_module.ConfigManager(config_path)
        deck = main_module.FretboardDeck(config)
        fixtures[config_path.name] = {
            "config_path": str(config_path.relative_to(REPO)),
            "count": len(deck.targets),
            "targets": [target.to_dict() for target in deck.targets],
        }
        print(f"{config_path}: {len(deck.targets)} targets")

    out_path = REPO / "tests" / "deck-fixture.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # `config.json` (repo root, used by the Python app) and `public/config.json`
    # (served to the browser) are kept identical, so a single fixture entry is
    # enough; both are dumped when passed explicitly.
    payload = {
        "generated_by": "tools/gen_deck_fixture.py",
        "generated_from": "main.py FretboardDeck._build_targets()",
        "decks": fixtures,
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
