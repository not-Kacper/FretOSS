"""
SRS Fretboard Learner — Core Audio Pipeline
=============================================
Listens to a real-time guitar input, detects a single monophonic note using
aubio's YIN pitch detection, validates it against a target MIDI note, and
displays the result in a clean live terminal UI.

Architecture (designed for easy extraction into a TUI/web layer):
    ConfigManager   — loads & exposes settings from config.json
    AudioEngine     — owns the PyAudio stream lifecycle + device selection
    PitchProcessor  — wraps aubio.pitch + stability/debounce filter
    TerminalDisplay — ANSI-based live TUI (volume meter, note display)
"""

from __future__ import annotations

import contextlib
from datetime import datetime, timedelta, timezone
import json
import math
import os
import random
import re
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import aubio
import numpy as np
import pyaudio
from fsrs import Card, Rating, ReviewLog, Scheduler, State

# ---------------------------------------------------------------------------
#  ALSA warning suppressor
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def _suppress_alsa_warnings():
    """Temporarily redirect C-level stderr to /dev/null.

    PyAudio (via PortAudio) probes every ALSA device on init, printing
    dozens of harmless 'Unknown PCM' warnings.  These are emitted by the
    C library so Python's contextlib.redirect_stderr can't catch them —
    we need to dup2 the actual file descriptor.
    """
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
        old_stderr = os.dup(2)
        os.dup2(devnull, 2)
        os.close(devnull)
        yield
    finally:
        os.dup2(old_stderr, 2)
        os.close(old_stderr)


# ---------------------------------------------------------------------------
#  ANSI helpers
# ---------------------------------------------------------------------------

class _Ansi:
    """Minimal ANSI escape-code constants for the live TUI."""
    RESET       = "\033[0m"
    BOLD        = "\033[1m"
    DIM         = "\033[2m"
    ITALIC      = "\033[3m"
    UNDERLINE   = "\033[4m"

    # Foreground colours
    RED         = "\033[31m"
    GREEN       = "\033[32m"
    YELLOW      = "\033[33m"
    BLUE        = "\033[34m"
    MAGENTA     = "\033[35m"
    CYAN        = "\033[36m"
    WHITE       = "\033[97m"
    GREY        = "\033[90m"

    # Background colours
    BG_GREEN    = "\033[42m"
    BG_RED      = "\033[41m"
    BG_YELLOW   = "\033[43m"
    BG_BLUE     = "\033[44m"
    BG_GREY     = "\033[100m"

    CLEAR       = "\033[2J"       # Clear entire screen.
    HOME        = "\033[H"        # Cursor to top-left.
    HIDE_CURSOR = "\033[?25l"
    SHOW_CURSOR = "\033[?25h"
    ERASE_LINE  = "\033[2K"       # Clear current line.

A = _Ansi


# ---------------------------------------------------------------------------
#  ConfigManager
# ---------------------------------------------------------------------------

class ConfigManager:
    """Loads configuration from a JSON file and provides typed accessors.

    Keeps the raw dict available (``self.raw``) for forward-compatible keys
    that haven't been given an accessor yet.
    """

    def __init__(self, path: str | Path = "config.json") -> None:
        self.path = Path(path)
        self.raw: dict = {}
        self._load()

    # -- public accessors ----------------------------------------------------

    @property
    def sample_rate(self) -> int:
        return int(self.raw["audio"]["sample_rate"])

    @property
    def buffer_size(self) -> int:
        return int(self.raw["audio"]["buffer_size"])

    @property
    def algorithm(self) -> str:
        return str(self.raw["pitch_detection"]["algorithm"])

    @property
    def confidence_threshold(self) -> float:
        return float(self.raw["pitch_detection"]["confidence_threshold"])

    @property
    def silence_threshold_hz(self) -> float:
        return float(self.raw["pitch_detection"]["silence_threshold_hz"])

    @property
    def pitch_tolerance(self) -> float:
        return float(self.raw["pitch_detection"]["pitch_tolerance"])

    @property
    def stability_frames(self) -> int:
        return int(self.raw["stability"]["required_consecutive_frames"])

    @property
    def deck_config(self) -> dict:
        return dict(self.raw.get("deck", {}))

    @property
    def srs_config(self) -> dict:
        return dict(self.raw.get("srs", {}))

    @property
    def progress_path(self) -> Path:
        raw_path = str(self.srs_config.get("progress_path", "progress.json"))
        path = Path(raw_path)
        if not path.is_absolute():
            path = self.path.parent / path
        return path

    @property
    def app_state_path(self) -> Path:
        raw_path = str(self.raw.get("app_state_path", "app_state.json"))
        path = Path(raw_path)
        if not path.is_absolute():
            path = self.path.parent / path
        return path

    @property
    def easy_threshold_sec(self) -> float:
        return float(self.srs_config.get("easy_threshold_sec", 2.0))

    @property
    def hard_threshold_sec(self) -> float:
        return float(self.srs_config.get("hard_threshold_sec", 6.0))

    @property
    def wrong_repeat_cooldown_sec(self) -> float:
        return float(self.srs_config.get("wrong_repeat_cooldown_sec", 1.5))

    @property
    def success_pause_sec(self) -> float:
        return float(self.srs_config.get("success_pause_sec", 0.8))

    @property
    def initial_new_cards(self) -> int:
        return max(0, int(self.srs_config.get("initial_new_cards", 3)))

    @property
    def new_card_interval_sec(self) -> float:
        return max(1.0, float(self.srs_config.get("new_card_interval_sec", 45.0)))

    @property
    def random_candidate_window(self) -> int:
        return max(1, int(self.srs_config.get("random_candidate_window", 8)))

    def new_card_allowance(self, session_elapsed_sec: float) -> int:
        extra = int(max(0.0, session_elapsed_sec) // self.new_card_interval_sec)
        return self.initial_new_cards + extra

    def create_scheduler(self) -> Scheduler:
        """Build the Py-FSRS scheduler from config.json settings."""
        srs = self.srs_config

        parameters = srs.get("parameters")
        if parameters is None:
            scheduler_kwargs = {}
        else:
            scheduler_kwargs = {"parameters": tuple(float(v) for v in parameters)}

        return Scheduler(
            **scheduler_kwargs,
            desired_retention=float(srs.get("desired_retention", 0.9)),
            learning_steps=tuple(
                timedelta(minutes=float(v))
                for v in srs.get("learning_steps_minutes", [1, 10])
            ),
            relearning_steps=tuple(
                timedelta(minutes=float(v))
                for v in srs.get("relearning_steps_minutes", [10])
            ),
            maximum_interval=int(srs.get("maximum_interval_days", 36500)),
            enable_fuzzing=bool(srs.get("enable_fuzzing", True)),
        )

    # -- internals -----------------------------------------------------------

    def _load(self) -> None:
        if not self.path.exists():
            print(f"  {A.RED}ERROR:{A.RESET} '{self.path}' not found.")
            sys.exit(1)
        with open(self.path, "r", encoding="utf-8") as fh:
            self.raw = json.load(fh)


# ---------------------------------------------------------------------------
#  AudioEngine
# ---------------------------------------------------------------------------

class AudioEngine:
    """Manages the PyAudio stream lifecycle.

    Exposes a thin ``read_frame()`` method that returns a float32 numpy array
    suitable for aubio, or *None* on overflow / error.
    """

    def __init__(self, config: ConfigManager) -> None:
        self._config = config
        self._pa: Optional[pyaudio.PyAudio] = None
        self._stream: Optional[pyaudio.Stream] = None
        self._device_index: Optional[int] = None
        self._device_name: str = ""

    # -- device selection ----------------------------------------------------

    def list_input_devices(self) -> list[dict]:
        """Return a list of available input devices with their info."""
        with _suppress_alsa_warnings():
            self._pa = pyaudio.PyAudio()
        devices = []
        for i in range(self._pa.get_device_count()):
            info = self._pa.get_device_info_by_index(i)
            if info["maxInputChannels"] > 0:
                name = str(info["name"])
                # Flag whether this is a raw hardware device (bypasses PipeWire).
                is_hw = "hw:" in name or name.startswith("sysdefault")
                devices.append({
                    "index": int(info["index"]),
                    "name": name,
                    "channels": int(info["maxInputChannels"]),
                    "default_sr": int(info["defaultSampleRate"]),
                    "is_hw": is_hw,
                })
        return devices

    def select_device(self, device_index: int, device_name: str) -> None:
        """Set the device to use when ``open()`` is called."""
        self._device_index = device_index
        self._device_name = device_name

    # -- lifecycle -----------------------------------------------------------

    def open(self) -> None:
        """Initialise PyAudio and open the selected input device."""
        if self._pa is None:
            with _suppress_alsa_warnings():
                self._pa = pyaudio.PyAudio()

        if self._device_index is None:
            # Fallback to system default if nothing was selected.
            self._device_index = int(
                self._pa.get_default_input_device_info()["index"]
            )
            self._device_name = str(
                self._pa.get_device_info_by_index(self._device_index)["name"]
            )

        self._stream = self._pa.open(
            format=pyaudio.paFloat32,
            channels=1,
            rate=self._config.sample_rate,
            input=True,
            input_device_index=self._device_index,
            frames_per_buffer=self._config.buffer_size,
        )

    def close(self) -> None:
        """Tear down the stream and PyAudio instance gracefully."""
        if self._stream is not None:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass  # Stream may already be closed.
        if self._pa is not None:
            self._pa.terminate()
            self._pa = None

    @property
    def device_name(self) -> str:
        return self._device_name

    # -- frame access --------------------------------------------------------

    def read_frame(self) -> Optional[np.ndarray]:
        """Read one buffer of audio and return it as a float32 numpy array.

        Returns ``None`` if the read fails (e.g. input overflow on a cheap
        USB interface) so callers can simply ``continue`` without crashing.
        """
        if self._stream is None:
            return None
        try:
            raw_bytes = self._stream.read(
                self._config.buffer_size, exception_on_overflow=False
            )
            # Unpack raw bytes → float32 numpy array expected by aubio.
            return np.frombuffer(raw_bytes, dtype=np.float32)
        except IOError:
            return None


# ---------------------------------------------------------------------------
#  PitchProcessor
# ---------------------------------------------------------------------------

@dataclass
class NoteEvent:
    """Lightweight value object emitted when the stability filter confirms
    a note has been held for enough consecutive frames."""
    midi_note: int
    frequency: float
    confidence: float


class PitchProcessor:
    """Wraps ``aubio.pitch`` with a stability/debounce filter.

    A note is only *confirmed* when:
      1. aubio reports a pitch above ``silence_threshold_hz``.
      2. The detection confidence exceeds ``confidence_threshold``.
      3. The **same MIDI note** is detected for ``stability_frames``
         consecutive frames — filtering out attack transients and
         brief sympathetic string vibrations.
    """

    def __init__(self, config: ConfigManager) -> None:
        self._config = config

        # Initialise the aubio pitch detector.
        self._detector = aubio.pitch(
            method=config.algorithm,
            buf_size=config.buffer_size,
            hop_size=config.buffer_size,
            samplerate=config.sample_rate,
        )
        self._detector.set_tolerance(config.pitch_tolerance)

        # Stability filter state.
        self._prev_midi: Optional[int] = None
        self._streak: int = 0

    # -- public API ----------------------------------------------------------

    def process(self, samples: np.ndarray) -> Optional[NoteEvent]:
        """Feed a buffer of float32 audio and return a ``NoteEvent`` if the
        stability filter confirms a note, otherwise ``None``.
        """
        # Run aubio pitch detection on this frame.
        frequency = float(self._detector(samples)[0])
        confidence = float(self._detector.get_confidence())

        # ---- Gate 1: silence / sub-bass rejection --------------------------
        if frequency < self._config.silence_threshold_hz:
            self._reset_streak()
            return None

        # ---- Gate 2: confidence threshold ----------------------------------
        if confidence < self._config.confidence_threshold:
            self._reset_streak()
            return None

        # ---- Gate 3: stability / debounce ----------------------------------
        midi_note = self._freq_to_midi(frequency)

        if midi_note == self._prev_midi:
            self._streak += 1
        else:
            # New note — restart the counter.
            self._prev_midi = midi_note
            self._streak = 1

        if self._streak >= self._config.stability_frames:
            return NoteEvent(
                midi_note=midi_note,
                frequency=frequency,
                confidence=confidence,
            )

        return None  # Still accumulating — not stable yet.

    def reset(self) -> None:
        """Manually reset the stability filter (e.g. between SRS prompts)."""
        self._reset_streak()

    # -- internals -----------------------------------------------------------

    def _reset_streak(self) -> None:
        self._prev_midi = None
        self._streak = 0

    @staticmethod
    def _freq_to_midi(freq: float) -> int:
        """Convert a frequency in Hz to the nearest MIDI note number.

        Uses the standard formula:  MIDI = 69 + 12·log₂(f / 440).
        """
        if freq <= 0:
            return 0
        return int(round(69 + 12 * np.log2(freq / 440.0)))


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

# Lookup table: MIDI note number → human-readable name (sharps only).
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_name(midi_note: int) -> str:
    """Return a human-readable note name like 'E2' for a MIDI note number."""
    octave = (midi_note // 12) - 1
    name = _NOTE_NAMES[midi_note % 12]
    return f"{name}{octave}"


def rms_to_db(samples: np.ndarray) -> float:
    """Compute RMS level of audio buffer in dBFS."""
    rms = np.sqrt(np.mean(samples ** 2))
    if rms < 1e-10:
        return -96.0  # Silence floor.
    return max(-96.0, 20.0 * math.log10(rms))


# ---------------------------------------------------------------------------
#  App state
# ---------------------------------------------------------------------------

def load_app_state(path: Path) -> dict:
    if not path.exists():
        return {}

    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}

    return data if isinstance(data, dict) else {}


def save_app_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
        fh.write("\n")
    os.replace(tmp_path, path)


def remember_audio_device(path: Path, device: dict) -> None:
    state = load_app_state(path)
    state["audio_device"] = {
        "index": int(device["index"]),
        "name": str(device["name"]),
        "channels": int(device.get("channels", 0)),
        "default_sr": int(device.get("default_sr", 0)),
        "saved_at": _utc_now().isoformat(),
    }
    save_app_state(path, state)


def find_remembered_device(devices: list[dict], state: dict) -> Optional[dict]:
    saved = state.get("audio_device")
    if not isinstance(saved, dict):
        return None

    saved_name = str(saved.get("name", ""))
    saved_index = saved.get("index")

    for device in devices:
        if device["name"] == saved_name and device["index"] == saved_index:
            return device

    for device in devices:
        if device["name"] == saved_name:
            return device

    return None


# ---------------------------------------------------------------------------
#  Fretboard deck
# ---------------------------------------------------------------------------

_BASE_NOTE_INDEX = {
    "C": 0,
    "D": 2,
    "E": 4,
    "F": 5,
    "G": 7,
    "A": 9,
    "B": 11,
}

_STANDARD_TUNING_MIDI = {
    6: 40,  # E2
    5: 45,  # A2
    4: 50,  # D3
    3: 55,  # G3
    2: 59,  # B3
    1: 64,  # E4
}

_STRING_LABELS = {
    6: "low E",
    5: "A",
    4: "D",
    3: "G",
    2: "B",
    1: "high E",
}


@dataclass(frozen=True)
class FretboardTarget:
    """One schedulable guitar position: a specific string and fret."""

    key: str
    card_id: int
    string_number: int
    string_label: str
    fret: int
    midi_note: int
    note_name: str
    pitch_class: str

    @property
    def prompt_label(self) -> str:
        return f"{self.note_name} on {self.string_label} string"

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "card_id": self.card_id,
            "string": self.string_number,
            "string_label": self.string_label,
            "fret": self.fret,
            "midi_note": self.midi_note,
            "note_name": self.note_name,
            "pitch_class": self.pitch_class,
        }


def _parse_note_token(value: object) -> tuple[str, int | str] | None:
    """Return ('midi', 40) or ('pitch_class', 'E') from a config note token."""
    if isinstance(value, int):
        return ("midi", value)

    raw = str(value).strip()
    if raw == "" or raw == "*":
        return None
    if raw.lower() in {"all", "any"}:
        return None
    if re.fullmatch(r"-?\d+", raw):
        return ("midi", int(raw))

    match = re.fullmatch(r"([A-Ga-g])([#b]?)(-?\d+)?", raw)
    if match is None:
        raise ValueError(f"Unsupported note token in config.json: {value!r}")

    letter = match.group(1).upper()
    accidental = match.group(2)
    octave = match.group(3)

    semitone = _BASE_NOTE_INDEX[letter]
    if accidental == "#":
        semitone += 1
    elif accidental == "b":
        semitone -= 1
    semitone %= 12

    if octave is None:
        return ("pitch_class", _NOTE_NAMES[semitone])

    return ("midi", (int(octave) + 1) * 12 + semitone)


def _build_note_filter(raw_notes: object) -> tuple[set[int], set[str]] | None:
    """Build MIDI/pitch-class allowlists; None means all notes are allowed."""
    if raw_notes is None:
        return None
    if not isinstance(raw_notes, list):
        raw_notes = [raw_notes]
    if len(raw_notes) == 0:
        return None

    allowed_midi: set[int] = set()
    allowed_pitch_classes: set[str] = set()

    for raw_note in raw_notes:
        parsed = _parse_note_token(raw_note)
        if parsed is None:
            return None
        kind, value = parsed
        if kind == "midi":
            allowed_midi.add(int(value))
        else:
            allowed_pitch_classes.add(str(value))

    return allowed_midi, allowed_pitch_classes


class FretboardDeck:
    """Builds standard-tuning guitar targets from the deck config."""

    def __init__(self, config: ConfigManager) -> None:
        self._config = config
        self.targets = self._build_targets()

        if not self.targets:
            print(
                f"  {A.RED}ERROR:{A.RESET} config.json deck produced no fretboard targets."
            )
            sys.exit(1)

    def _build_targets(self) -> list[FretboardTarget]:
        deck = self._config.deck_config
        tuning = str(deck.get("tuning", "EADGBE")).upper().replace("-", "_")
        if tuning not in {"EADGBE", "STANDARD", "STANDARD_6_STRING_GUITAR"}:
            print(
                f"  {A.RED}ERROR:{A.RESET} Only standard 6-string EADGBE tuning "
                f"is supported right now."
            )
            sys.exit(1)

        raw_strings = deck.get("strings", [6, 5, 4, 3, 2, 1])
        strings = [int(string_number) for string_number in raw_strings]
        unknown_strings = sorted(set(strings) - set(_STANDARD_TUNING_MIDI))
        if unknown_strings:
            print(
                f"  {A.RED}ERROR:{A.RESET} Unsupported guitar strings in config.json: "
                f"{unknown_strings}"
            )
            sys.exit(1)

        raw_frets = deck.get("frets")
        if raw_frets is None:
            min_fret = int(deck.get("min_fret", 0))
            max_fret = int(deck.get("max_fret", 12))
            frets = list(range(min_fret, max_fret + 1))
        else:
            frets = [int(fret) for fret in raw_frets]

        if any(fret < 0 for fret in frets):
            print(f"  {A.RED}ERROR:{A.RESET} Fret numbers must be >= 0.")
            sys.exit(1)

        note_filter = _build_note_filter(
            deck.get("notes_to_learn", deck.get("notes"))
        )

        targets: list[FretboardTarget] = []
        for string_number in strings:
            open_midi = _STANDARD_TUNING_MIDI[string_number]
            for fret in frets:
                midi_note = open_midi + fret
                note_name = midi_to_name(midi_note)
                pitch_class = _NOTE_NAMES[midi_note % 12]

                if note_filter is not None:
                    allowed_midi, allowed_pitch_classes = note_filter
                    if (
                        midi_note not in allowed_midi
                        and pitch_class not in allowed_pitch_classes
                    ):
                        continue

                key = f"s{string_number}_f{fret:02d}"
                card_id = (string_number * 1000) + fret
                targets.append(
                    FretboardTarget(
                        key=key,
                        card_id=card_id,
                        string_number=string_number,
                        string_label=_STRING_LABELS[string_number],
                        fret=fret,
                        midi_note=midi_note,
                        note_name=note_name,
                        pitch_class=pitch_class,
                    )
                )

        return targets


# ---------------------------------------------------------------------------
#  Progress / FSRS persistence
# ---------------------------------------------------------------------------

def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _format_local_datetime(value: datetime) -> str:
    return _as_utc(value).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def _format_wait(delta: timedelta) -> str:
    total_seconds = max(0, int(delta.total_seconds()))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}h {minutes}m"
    if minutes > 0:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


@dataclass(frozen=True)
class QueueStats:
    learning_due: int
    review_due: int
    new_available: int
    new_total: int
    future: int

    @property
    def available(self) -> int:
        return self.learning_due + self.review_due + self.new_available


class ProgressStore:
    """Persists one FSRS card and simple point stats per fretboard target."""

    VERSION = 1

    def __init__(
        self,
        path: Path,
        scheduler: Scheduler,
        targets: list[FretboardTarget],
    ) -> None:
        self.path = path
        self.scheduler = scheduler
        self._target_by_key = {target.key: target for target in targets}
        self.data = self._load_or_create()
        self._sync_targets(targets)
        self.save()

    def select_next_target(
        self,
        now: datetime,
        new_cards_allowed: int,
        new_cards_started: int,
        random_window: int,
        recent_keys: Optional[list[str]] = None,
    ) -> Optional[FretboardTarget]:
        buckets = self._queue_buckets(now)
        recent = set(recent_keys or [])

        if buckets["learning_due"]:
            return self._pick_candidate(
                buckets["learning_due"],
                random_window,
                recent,
            )

        if buckets["review_due"]:
            return self._pick_candidate(
                buckets["review_due"],
                random_window,
                recent,
            )

        if new_cards_started < new_cards_allowed and buckets["new"]:
            return self._pick_candidate(
                buckets["new"],
                random_window,
                recent,
            )

        return None

    def queue_stats(
        self,
        now: datetime,
        new_cards_allowed: int,
        new_cards_started: int,
    ) -> QueueStats:
        buckets = self._queue_buckets(now)
        new_remaining = max(0, new_cards_allowed - new_cards_started)
        return QueueStats(
            learning_due=len(buckets["learning_due"]),
            review_due=len(buckets["review_due"]),
            new_available=min(new_remaining, len(buckets["new"])),
            new_total=len(buckets["new"]),
            future=len(buckets["future"]),
        )

    def is_new(self, target: FretboardTarget) -> bool:
        record = self._record_for(target)
        return self._is_new_card(record, self._card_from_record(record))

    def has_new_cards(self) -> bool:
        for target in self._target_by_key.values():
            record = self._record_for(target)
            if self._is_new_card(record, self._card_from_record(record)):
                return True
        return False

    def next_due(self) -> Optional[tuple[FretboardTarget, Card]]:
        upcoming: list[tuple[FretboardTarget, Card]] = []
        for target in self._target_by_key.values():
            record = self._record_for(target)
            card = self._card_from_record(record)
            if not self._is_new_card(record, card):
                upcoming.append((target, card))
        if not upcoming:
            return None
        upcoming.sort(key=lambda item: item[1].due)
        return upcoming[0]

    def stats_for(self, target: FretboardTarget) -> dict:
        record = self._record_for(target)
        return {
            "points": int(record.get("points", 0)),
            "attempts": int(record.get("attempts", 0)),
            "correct": int(record.get("correct", 0)),
            "wrong": int(record.get("wrong", 0)),
        }

    def mark_prompted(self, target: FretboardTarget, when: datetime) -> None:
        record = self._record_for(target)
        record["last_prompted_at"] = _as_utc(when).isoformat()
        record["prompt_count"] = int(record.get("prompt_count", 0)) + 1
        self._touch()
        self.save()

    def review(
        self,
        target: FretboardTarget,
        rating: Rating,
        review_datetime: datetime,
        review_duration_ms: int,
        detected_midi: Optional[int] = None,
    ) -> tuple[Card, ReviewLog]:
        record = self._record_for(target)
        card = self._card_from_record(record)
        reviewed_at = _as_utc(review_datetime)
        updated_card, review_log = self.scheduler.review_card(
            card,
            rating,
            review_datetime=reviewed_at,
            review_duration=review_duration_ms,
        )

        record["card"] = updated_card.to_dict()
        record["attempts"] = int(record.get("attempts", 0)) + 1
        record["last_reviewed_at"] = reviewed_at.isoformat()

        if rating == Rating.Again:
            record["wrong"] = int(record.get("wrong", 0)) + 1
            record["points"] = int(record.get("points", 0)) - 1
        else:
            record["correct"] = int(record.get("correct", 0)) + 1
            record["points"] = int(record.get("points", 0)) + self._points_for(rating)

        review_entry = dict(review_log.to_dict())
        review_entry["target_key"] = target.key
        if detected_midi is not None:
            review_entry["detected_midi_note"] = detected_midi
            review_entry["detected_note_name"] = midi_to_name(detected_midi)
        record.setdefault("reviews", []).append(review_entry)

        self._touch()
        self.save()
        return updated_card, review_log

    def _load_or_create(self) -> dict:
        if not self.path.exists():
            now = _utc_now().isoformat()
            return {
                "version": self.VERSION,
                "created_at": now,
                "updated_at": now,
                "scheduler": self.scheduler.to_dict(),
                "cards": {},
            }

        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"  {A.RED}ERROR:{A.RESET} Could not read progress file "
                f"{self.path}: {exc}"
            )
            sys.exit(1)

        if not isinstance(data, dict):
            print(f"  {A.RED}ERROR:{A.RESET} Progress file must contain a JSON object.")
            sys.exit(1)

        data.setdefault("version", self.VERSION)
        data.setdefault("created_at", _utc_now().isoformat())
        data.setdefault("updated_at", _utc_now().isoformat())
        data.setdefault("scheduler", self.scheduler.to_dict())
        data.setdefault("cards", {})
        return data

    def _sync_targets(self, targets: list[FretboardTarget]) -> None:
        cards = self.data.setdefault("cards", {})
        now = _utc_now()

        for target in targets:
            if target.key not in cards:
                cards[target.key] = self._new_record(target, now)
                continue

            record = cards[target.key]
            record["target"] = target.to_dict()
            record.setdefault("card", Card(card_id=target.card_id, due=now).to_dict())
            record.setdefault("points", 0)
            record.setdefault("attempts", 0)
            record.setdefault("correct", 0)
            record.setdefault("wrong", 0)
            record.setdefault("reviews", [])

        self.data["scheduler"] = self.scheduler.to_dict()
        self._touch()

    def _new_record(self, target: FretboardTarget, now: datetime) -> dict:
        return {
            "target": target.to_dict(),
            "card": Card(card_id=target.card_id, due=now).to_dict(),
            "points": 0,
            "attempts": 0,
            "correct": 0,
            "wrong": 0,
            "prompt_count": 0,
            "last_prompted_at": None,
            "last_reviewed_at": None,
            "reviews": [],
        }

    def _record_for(self, target: FretboardTarget) -> dict:
        return self.data["cards"][target.key]

    def _queue_buckets(self, now: datetime) -> dict[str, list[tuple]]:
        buckets: dict[str, list[tuple]] = {
            "learning_due": [],
            "review_due": [],
            "new": [],
            "future": [],
        }

        for target in self._target_by_key.values():
            record = self._record_for(target)
            card = self._card_from_record(record)
            retrievability = self.scheduler.get_card_retrievability(card, now)
            candidate = (target, record, card, retrievability)

            if self._is_new_card(record, card):
                buckets["new"].append(candidate)
            elif card.due <= now and card.state in (State.Learning, State.Relearning):
                buckets["learning_due"].append(candidate)
            elif card.due <= now:
                buckets["review_due"].append(candidate)
            else:
                buckets["future"].append(candidate)

        buckets["learning_due"].sort(key=self._learning_priority)
        buckets["review_due"].sort(key=self._review_priority)
        buckets["new"].sort(key=self._new_priority)
        buckets["future"].sort(key=lambda item: item[2].due)
        return buckets

    def _pick_candidate(
        self,
        candidates: list[tuple],
        random_window: int,
        recent_keys: set[str],
    ) -> FretboardTarget:
        if len(candidates) == 1:
            return candidates[0][0]

        pool = candidates[: min(random_window, len(candidates))]
        without_recent = [item for item in pool if item[0].key not in recent_keys]
        if without_recent:
            pool = without_recent

        return random.choice(pool)[0]

    def _is_new_card(self, record: dict, card: Card) -> bool:
        return card.last_review is None and int(record.get("attempts", 0)) == 0

    def _learning_priority(self, item: tuple) -> tuple:
        target, record, card, retrievability = item
        return (
            card.due,
            int(record.get("points", 0)),
            retrievability,
            int(record.get("attempts", 0)),
            target.string_number,
            target.fret,
        )

    def _review_priority(self, item: tuple) -> tuple:
        target, record, card, retrievability = item
        return (
            retrievability,
            card.due,
            int(record.get("points", 0)),
            int(record.get("attempts", 0)),
            target.string_number,
            target.fret,
        )

    def _new_priority(self, item: tuple) -> tuple:
        target, record, card, retrievability = item
        return (
            int(record.get("prompt_count", 0)),
            int(record.get("points", 0)),
            random.random(),
            target.string_number,
            target.fret,
        )

    def _card_from_record(self, record: dict) -> Card:
        card = Card.from_dict(record["card"])
        card.due = _as_utc(card.due)
        if card.last_review is not None:
            card.last_review = _as_utc(card.last_review)
        return card

    def _touch(self) -> None:
        self.data["updated_at"] = _utc_now().isoformat()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_name(f"{self.path.name}.tmp")
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(self.data, fh, indent=2)
            fh.write("\n")
        os.replace(tmp_path, self.path)

    @staticmethod
    def _points_for(rating: Rating) -> int:
        if rating == Rating.Easy:
            return 3
        if rating == Rating.Good:
            return 2
        return 1


def rating_for_correct_answer(
    elapsed_sec: float,
    wrong_attempts: int,
    config: ConfigManager,
) -> Rating:
    if wrong_attempts > 0:
        return Rating.Hard
    if elapsed_sec <= config.easy_threshold_sec:
        return Rating.Easy
    if elapsed_sec <= config.hard_threshold_sec:
        return Rating.Good
    return Rating.Hard


# ---------------------------------------------------------------------------
#  TerminalDisplay — live TUI
# ---------------------------------------------------------------------------

class TerminalDisplay:
    """ANSI-based live terminal display.

    Redraws the screen in-place to show:
      - Header with device info
      - Target note prompt
      - Current detected note (big & prominent)
      - Volume meter
      - Status / result feedback
    """

    METER_WIDTH = 40  # Character width of the volume bar.

    def __init__(
        self,
        target: FretboardTarget,
        device_name: str,
        stats: dict,
        queue_stats: QueueStats,
    ) -> None:
        self._target = target
        self._device_name = device_name
        self._stats = stats
        self._queue_stats = queue_stats

    def set_target(
        self,
        target: FretboardTarget,
        stats: dict,
        queue_stats: QueueStats,
    ) -> None:
        self._target = target
        self._stats = stats
        self._queue_stats = queue_stats

    def init(self) -> None:
        """Set up the terminal for live drawing."""
        sys.stdout.write(A.HIDE_CURSOR + A.CLEAR + A.HOME)
        sys.stdout.flush()

    def cleanup(self) -> None:
        """Restore the terminal state."""
        sys.stdout.write(A.SHOW_CURSOR + "\n")
        sys.stdout.flush()

    def draw(
        self,
        detected_name: Optional[str] = None,
        detected_midi: Optional[int] = None,
        frequency: float = 0.0,
        confidence: float = 0.0,
        db_level: float = -96.0,
        is_match: Optional[bool] = None,
    ) -> None:
        """Redraw the entire screen with current state."""
        lines: list[str] = []

        # ── Header ──────────────────────────────────────────────────
        lines.append("")
        lines.append(f"  {A.BOLD}{A.CYAN}🎸 SRS Fretboard Learner{A.RESET}")
        lines.append(f"  {A.DIM}{'─' * 48}{A.RESET}")
        lines.append(
            f"  {A.DIM}Device:{A.RESET}  {A.WHITE}{self._device_name}{A.RESET}"
        )
        lines.append("")

        # ── Target ──────────────────────────────────────────────────
        lines.append(
            f"  {A.DIM}Target:{A.RESET}  "
            f"{A.BOLD}{A.YELLOW}{self._target.note_name}{A.RESET}"
            f"  {A.WHITE}{self._target.string_label} string{A.RESET}"
        )
        lines.append(
            f"  {A.DIM}Progress:{A.RESET}  "
            f"points {self._stats.get('points', 0):+d}  "
            f"{self._stats.get('correct', 0)} correct / "
            f"{self._stats.get('wrong', 0)} wrong  "
            f"{A.DIM}queue: "
            f"learn {self._queue_stats.learning_due}, "
            f"review {self._queue_stats.review_due}, "
            f"new {self._queue_stats.new_available}/{self._queue_stats.new_total}"
            f"{A.RESET}"
        )
        lines.append("")

        # ── Volume meter ────────────────────────────────────────────
        vol_bar = self._build_volume_bar(db_level)
        lines.append(f"  {A.DIM}Volume:{A.RESET}  {vol_bar}  {A.DIM}{db_level:+5.1f} dB{A.RESET}")
        lines.append("")

        # ── Detected note (prominent) ──────────────────────────────
        lines.append(f"  {A.DIM}{'─' * 48}{A.RESET}")

        if detected_name is None:
            # Silence / waiting state.
            lines.append("")
            lines.append(f"       {A.DIM}{A.ITALIC}Listening...  play a note{A.RESET}")
            lines.append("")
        else:
            # Show detected note BIG.
            if is_match:
                colour = A.GREEN
                icon = "✅"
            else:
                colour = A.RED
                icon = "❌"

            lines.append("")
            lines.append(
                f"    {icon}  {A.BOLD}{colour}"
                f"{detected_name:>4s}"
                f"{A.RESET}"
                f"   {A.DIM}{frequency:.1f} Hz   conf {confidence:.0%}{A.RESET}"
            )
            lines.append("")

        lines.append(f"  {A.DIM}{'─' * 48}{A.RESET}")

        # ── Status line ────────────────────────────────────────────
        lines.append("")
        if is_match is True:
            lines.append(
                f"  {A.BOLD}{A.GREEN}🎉  Note validated!  "
                f"Saving progress and picking the next prompt.{A.RESET}"
            )
        elif is_match is False:
            lines.append(
                f"  {A.YELLOW}⏳  Expected {self._target.prompt_label} — keep trying!{A.RESET}"
            )
        else:
            lines.append(
                f"  {A.DIM}Waiting for {self._target.prompt_label}...{A.RESET}"
            )

        lines.append("")
        lines.append(f"  {A.DIM}Press Ctrl-C to quit{A.RESET}")
        lines.append("")

        # ── Flush to terminal ──────────────────────────────────────
        # Move cursor home and overwrite — avoids flicker vs full clear.
        output = A.HOME
        for line in lines:
            output += A.ERASE_LINE + line + "\n"
        sys.stdout.write(output)
        sys.stdout.flush()

    # -- volume bar ----------------------------------------------------------

    def _build_volume_bar(self, db: float) -> str:
        """Render a coloured volume bar from a dBFS value.

        Maps -96 dB → 0 bars, 0 dB → full bar.
        """
        # Normalise to 0.0–1.0 range.
        level = max(0.0, min(1.0, (db + 96.0) / 96.0))
        filled = int(level * self.METER_WIDTH)
        empty = self.METER_WIDTH - filled

        # Colour gradient: green → yellow → red.
        bar = ""
        for i in range(filled):
            frac = i / self.METER_WIDTH
            if frac < 0.5:
                bar += f"{A.GREEN}█"
            elif frac < 0.8:
                bar += f"{A.YELLOW}█"
            else:
                bar += f"{A.RED}█"

        bar += f"{A.GREY}{'░' * empty}{A.RESET}"
        return bar


# ---------------------------------------------------------------------------
#  Device selection prompt
# ---------------------------------------------------------------------------

def choose_audio_device(engine: AudioEngine, config: ConfigManager) -> None:
    """Interactive device picker shown at startup.

    Lists all available input devices and asks the user to choose one.
    A remembered device is reused automatically when available.
    """
    devices = engine.list_input_devices()

    if not devices:
        print(f"\n  {A.RED}{A.BOLD}ERROR:{A.RESET} No audio input devices found.")
        print(f"  Connect a microphone or audio interface and try again.\n")
        sys.exit(1)

    app_state = load_app_state(config.app_state_path)
    remembered = find_remembered_device(devices, app_state)
    if remembered is not None:
        engine.select_device(remembered["index"], remembered["name"])
        print()
        print(f"  {A.BOLD}{A.CYAN}🎸 SRS Fretboard Learner{A.RESET}")
        print(
            f"  {A.GREEN}✓{A.RESET}  Using remembered input: "
            f"{A.BOLD}{remembered['name']}{A.RESET}"
        )
        print()
        time.sleep(0.6)
        return

    # Find system default.
    try:
        pa = engine._pa
        default_idx = int(pa.get_default_input_device_info()["index"])
    except Exception:
        default_idx = devices[0]["index"]

    print()
    print(f"  {A.BOLD}{A.CYAN}🎸 SRS Fretboard Learner{A.RESET}")
    print(f"  {A.DIM}{'─' * 48}{A.RESET}")
    print(f"  {A.BOLD}Select audio input device:{A.RESET}")
    print()

    default_choice = 0
    for i, dev in enumerate(devices):
        is_default = dev["index"] == default_idx
        markers = []
        if is_default:
            default_choice = i
            markers.append(f"{A.GREEN}← default{A.RESET}")
        if dev.get("is_hw"):
            markers.append(f"{A.YELLOW}hw{A.RESET}")

        marker_str = "  ".join(markers)
        if marker_str:
            marker_str = " " + marker_str

        print(
            f"    {A.BOLD}{A.WHITE}[{i + 1}]{A.RESET}  "
            f"{dev['name']}"
            f"  {A.DIM}({dev['channels']}ch, {dev['default_sr']} Hz){A.RESET}"
            f"{marker_str}"
        )

    print()
    print(
        f"  {A.DIM}💡 Tip: If using Reaper with pw-jack, pick a "
        f"\"default\" or \"pipewire\" device{A.RESET}"
    )
    print(
        f"  {A.DIM}   (devices marked {A.YELLOW}hw{A.RESET}{A.DIM} "
        f"grab hardware directly and can't share with JACK){A.RESET}"
    )
    print()
    print(
        f"  {A.DIM}Press Enter for default, "
        f"or type a number (1-{len(devices)}):{A.RESET}"
    )

    while True:
        try:
            raw = input(f"  {A.CYAN}▸{A.RESET} ").strip()
        except (EOFError, KeyboardInterrupt):
            print(f"\n  {A.DIM}Cancelled.{A.RESET}")
            sys.exit(0)

        if raw == "":
            choice = default_choice
            break

        try:
            choice = int(raw) - 1
            if 0 <= choice < len(devices):
                break
        except ValueError:
            pass

        print(
            f"  {A.RED}Invalid choice.{A.RESET} "
            f"Enter 1–{len(devices)} or press Enter for default."
        )

    selected = devices[choice]
    engine.select_device(selected["index"], selected["name"])
    remember_audio_device(config.app_state_path, selected)
    print()
    print(
        f"  {A.GREEN}✓{A.RESET}  Selected: "
        f"{A.BOLD}{selected['name']}{A.RESET}"
    )
    print(f"  {A.DIM}Remembered for next launch.{A.RESET}")
    print()
    # Brief pause so the user can see the confirmation.
    time.sleep(0.6)


# ---------------------------------------------------------------------------
#  Main entry point
# ---------------------------------------------------------------------------

def main() -> None:
    # ---- Configuration -----------------------------------------------------
    config = ConfigManager()
    scheduler = config.create_scheduler()
    deck = FretboardDeck(config)
    progress = ProgressStore(config.progress_path, scheduler, deck.targets)
    session_started_at = time.monotonic()
    new_cards_started = 0
    recent_target_keys: list[str] = []

    def _session_elapsed_sec() -> float:
        return time.monotonic() - session_started_at

    def _new_card_allowance() -> int:
        return config.new_card_allowance(_session_elapsed_sec())

    def _queue_stats() -> QueueStats:
        return progress.queue_stats(
            _utc_now(),
            _new_card_allowance(),
            new_cards_started,
        )

    def _select_target() -> Optional[FretboardTarget]:
        return progress.select_next_target(
            _utc_now(),
            _new_card_allowance(),
            new_cards_started,
            config.random_candidate_window,
            recent_target_keys,
        )

    target = _select_target()
    if target is None:
        next_due = progress.next_due()
        print()
        print(f"  {A.BOLD}{A.CYAN}🎸 SRS Fretboard Learner{A.RESET}")
        print(f"  {A.GREEN}No cards are ready right now.{A.RESET}")
        if next_due is not None:
            next_target, next_card = next_due
            wait = _format_wait(next_card.due - _utc_now())
            print(
                f"  Next due: {A.YELLOW}{next_target.prompt_label}{A.RESET} "
                f"at {_format_local_datetime(next_card.due)} ({wait})."
            )
        elif progress.has_new_cards():
            print(
                f"  New cards unlock adaptively while you practice: "
                f"{config.initial_new_cards} now, then one more every "
                f"{_format_wait(timedelta(seconds=config.new_card_interval_sec))}."
            )
        print()
        return

    # ---- Device selection --------------------------------------------------
    engine = AudioEngine(config)
    choose_audio_device(engine, config)

    # ---- Set up pitch processor --------------------------------------------
    processor = PitchProcessor(config)

    # ---- Set up display ----------------------------------------------------
    now = _utc_now()
    progress.mark_prompted(target, now)
    if progress.is_new(target):
        new_cards_started += 1
    display = TerminalDisplay(
        target,
        engine.device_name,
        progress.stats_for(target),
        _queue_stats(),
    )

    # Graceful shutdown on Ctrl-C / SIGINT.
    running = True

    def _on_signal(sig, frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, _on_signal)

    engine.open()
    display.init()

    # Draw initial "waiting" state.
    display.draw()

    completed_cards = 0
    prompt_started_at = time.monotonic()
    wrong_attempts = 0
    last_wrong_midi: Optional[int] = None
    last_wrong_at = 0.0

    try:
        while running:
            samples = engine.read_frame()
            if samples is None:
                continue  # Overflow or error — skip this frame.

            # Compute volume level for the meter.
            db_level = rms_to_db(samples)

            # Run pitch detection.
            event = processor.process(samples)

            if event is None:
                # No stable note — just update the volume meter.
                display.draw(db_level=db_level)
                continue

            detected_name = midi_to_name(event.midi_note)
            is_match = event.midi_note == target.midi_note

            display.draw(
                detected_name=detected_name,
                detected_midi=event.midi_note,
                frequency=event.frequency,
                confidence=event.confidence,
                db_level=db_level,
                is_match=is_match,
            )

            if is_match:
                elapsed_sec = time.monotonic() - prompt_started_at
                rating = rating_for_correct_answer(
                    elapsed_sec,
                    wrong_attempts,
                    config,
                )
                progress.review(
                    target,
                    rating,
                    _utc_now(),
                    int(elapsed_sec * 1000),
                    detected_midi=event.midi_note,
                )
                completed_cards += 1
                display.set_target(
                    target,
                    progress.stats_for(target),
                    _queue_stats(),
                )
                display.draw(
                    detected_name=detected_name,
                    detected_midi=event.midi_note,
                    frequency=event.frequency,
                    confidence=event.confidence,
                    db_level=db_level,
                    is_match=True,
                )

                # Hold the success screen for a moment so the user sees it.
                time.sleep(config.success_pause_sec)

                recent_target_keys.append(target.key)
                recent_target_keys = recent_target_keys[-6:]

                target = _select_target()
                if target is None:
                    break

                progress.mark_prompted(target, _utc_now())
                if progress.is_new(target):
                    new_cards_started += 1
                display.set_target(
                    target,
                    progress.stats_for(target),
                    _queue_stats(),
                )
                prompt_started_at = time.monotonic()
                wrong_attempts = 0
                last_wrong_midi = None
                last_wrong_at = 0.0
                processor.reset()
                display.draw()
            else:
                now_monotonic = time.monotonic()
                should_record_wrong = (
                    last_wrong_midi != event.midi_note
                    or now_monotonic - last_wrong_at
                    >= config.wrong_repeat_cooldown_sec
                )
                if should_record_wrong:
                    progress.review(
                        target,
                        Rating.Again,
                        _utc_now(),
                        int((now_monotonic - prompt_started_at) * 1000),
                        detected_midi=event.midi_note,
                    )
                    wrong_attempts += 1
                    last_wrong_midi = event.midi_note
                    last_wrong_at = now_monotonic
                    display.set_target(
                        target,
                        progress.stats_for(target),
                        _queue_stats(),
                    )

                # Reset the streak so the user must hold the *correct* note
                # cleanly from scratch.
                processor.reset()

    finally:
        display.cleanup()
        engine.close()

    if not running:
        print(f"  {A.DIM}⏹  Interrupted by user.{A.RESET}\n")
    elif completed_cards > 0:
        next_due = progress.next_due()
        print(
            f"  {A.GREEN}✓{A.RESET} Session complete: "
            f"{completed_cards} due card(s) reviewed."
        )
        if next_due is not None:
            next_target, next_card = next_due
            wait = _format_wait(next_card.due - _utc_now())
            print(
                f"  Next due: {A.YELLOW}{next_target.prompt_label}{A.RESET} "
                f"at {_format_local_datetime(next_card.due)} ({wait}).\n"
            )


if __name__ == "__main__":
    main()
