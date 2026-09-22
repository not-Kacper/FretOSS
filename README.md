# SRS Fretboard Learner (TypeScript / web port)

A real-time guitar note trainer with FSRS spaced repetition, ported from the
single-file Python app (`main.py`) to a **client-side web app**.

Play the prompted note on the prompted string, the app confirms it through the
microphone, scores the answer (FSRS rating), and schedules the next prompt.
The whole detection → scoring → scheduling loop runs in the browser: pitch
detection happens on the audio rendering thread (AudioWorklet) and progress
lives in IndexedDB, so nothing round-trips to a server while you practice.
Cross-device sync to Cloudflare D1 is optional and never on the critical path.

```
mic ──▶ AudioWorklet (YIN) ──▶ 3 gates ──▶ session loop ──▶ IndexedDB ──▶ (optional) D1
        audio thread          main thread   FSRS              local-first
```

## Stack

| Piece | Choice | Why |
| --- | --- | --- |
| Build | Vite 6 + TypeScript 5 (strict) | dev server + static build, no framework |
| UI | React 18 (one view, `useState`/`useRef`/`useCallback`) | mirrors the terminal screen |
| Pitch detection | Web Audio `AudioWorkletProcessor` in `public/worklets/` | runs on the audio rendering thread; not bundled so `addModule()` can load it |
| Scheduling | [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) (FSRS-6) | JS counterpart of the Python app's `py-fsrs` |
| Local persistence | IndexedDB (`idb`-free, hand-rolled wrapper) | the browser's `progress.json` |
| Hosting | Cloudflare Pages | static `dist/` |
| Sync API | Pages Function `functions/api/progress.ts` + D1 | optional, anonymous 256-bit token |

No Next.js, no router, no state-management library: the Python app had exactly
one screen and a few pieces of state, and the web version keeps that shape.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173 — allow the microphone when asked
npm test           # vitest: 71 tests (unit + py-fsrs parity + fixture replay)
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build  -> dist/
npm run preview    # serve dist/ locally
```

`localhost` is a secure context, so `getUserMedia` works without HTTPS.

### Config

`config.json` (repo root, read by the Python app) and `public/config.json`
(fetched by the browser) are **byte-identical copies**; `tests/config.test.ts`
fails if they ever drift. Same schema, same defaults, same clamps:

```jsonc
{
  "audio":           { "sample_rate": 44100, "buffer_size": 4096 },
  "pitch_detection": { "algorithm": "yin", "confidence_threshold": 0.80,
                       "silence_threshold_hz": 60.0, "pitch_tolerance": 0.8 },
  "stability":       { "required_consecutive_frames": 3 },
  "deck":            { "tuning": "EADGBE", "strings": [6,5,4,3,2,1],
                       "min_fret": 0, "max_fret": 12, "notes_to_learn": [/* 12 pitch classes */] },
  "srs":             { "progress_path": "progress.json", "desired_retention": 0.9,
                       "learning_steps_minutes": [1, 10], "relearning_steps_minutes": [10],
                       "maximum_interval_days": 36500, "enable_fuzzing": true,
                       "initial_new_cards": 3, "new_card_interval_sec": 45.0,
                       "random_candidate_window": 8, "easy_threshold_sec": 2.0,
                       "hard_threshold_sec": 6.0, "wrong_repeat_cooldown_sec": 1.5,
                       "success_pause_sec": 0.8 }
}
```

`progress_path` / `app_state_path` are kept for schema compatibility only: the
browser equivalent is IndexedDB / localStorage. An optional `srs.parameters`
array (21 floats) overrides the FSRS weights, exactly like `py_fsrs.Scheduler(parameters=...)`.

### Deploy

```bash
npm run build
npx wrangler login                                   # once, on your machine
npx wrangler d1 create fretboard_progress            # paste database_id into wrangler.toml
npx wrangler d1 execute fretboard_progress --remote --file=./migrations/0001_init.sql
npx wrangler pages deploy dist                       # or: npm run deploy
```

Without the D1 setup the app still works — `src/storage/sync.ts` treats a
failing `/api/progress` as "offline (local only)" and never blocks the UI.

## Port map (`main.py` → `src/`)

| Python | TypeScript |
| --- | --- |
| `ConfigManager` | `src/config/config.ts` (`ConfigManager`, `parseConfig`, `loadConfig`) |
| `AudioEngine` (`open`/`close`/`list_input_devices`/`select_device`) | `src/audio/engine.ts` (`startAudioEngine`, `stopAudioEngine`, `listInputDevices`) |
| `PitchProcessor.process()` (aubio YIN + gates) | `public/worklets/pitch-processor.js` (YIN) + `src/audio/pitch-detector.ts` (three gates) |
| `FreqProcessor.reset()` | `PitchDetector.resetStreak()` |
| `FretboardDeck._build_targets()` | `buildTargets()` — `src/deck/deck.ts` |
| `_parse_note_token()` | `parseNoteToken()` — `src/deck/deck.ts` |
| `_build_note_filter()` | `buildNoteFilter()` — `src/deck/deck.ts` |
| `ProgressStore._queue_buckets()` | `queueBuckets()` — `src/srs/queue.ts` |
| `ProgressStore._pick_candidate()` | `pickCandidate()` — `src/srs/queue.ts` |
| `ProgressStore.review()` | `ProgressStore.review()` — `src/storage/progress-idb.ts` + `Scheduler.reviewCard()` — `src/srs/scheduler.ts` |
| `rating_for_correct_answer()` | `ratingForCorrectAnswer()` — `src/srs/scheduler.ts` |
| `TerminalDisplay.draw()` | `src/App.tsx` + `src/components/*.tsx` |
| `midi_to_name()` / `rms_to_db()` / `_format_wait()` | `src/audio/note-helpers.ts` |
| `choose_audio_device()` | `src/components/DevicePicker.tsx` (dropdown instead of a numbered terminal prompt) |
| `progress.json` | IndexedDB store `srs-fretboard` (`cards` + `meta`) |
| `app_state.json` (`audio_device`) | `localStorage["srs-fretboard.audio_device"]` |
| — (new) | `src/storage/sync.ts` + `functions/api/progress.ts` + `migrations/0001_init.sql` |

## Fidelity notes

Everything algorithmic is a faithful port, including error messages and clamps.
The deviations below are deliberate, and each exists because the platform
differs from a terminal + PyAudio:

1. **Silent sink instead of "no output connection".**
   `MediaStreamSource → AudioWorkletNode → GainNode(gain = 0) → destination`.
   Web Audio only renders nodes that (transitively) reach the destination, so an
   unconnected `AudioWorkletNode` would never see a single render quantum — its
   `process()` would simply not be called. Gain 0 keeps the analysis graph
   pulled while producing silence: nothing is ever audible, and the processor
   itself does no playback.
2. **Device picker is a dropdown.** `choose_audio_device()`'s numbered prompt
   becomes `<select>`; the remembered device is pre-selected and reused, and
   the "default" marker survives as `(remembered)`.
3. **Worklet posts `db` and applies the aubio silence gate.** The Python loop
   computed `rms_to_db()` on the main thread and aubio zeroed the pitch below
   -50 dBFS. The worklet now does both (aubio's `aubio_pitch_do`: zero when
   `10·log10(mean(x²)) < -50`), and the main thread uses the same value for the
   meter. `rms_to_db()` is ported verbatim in `note-helpers.ts` and computed on
   the same buffers, so the two agree (asserted in `tests/worklet.test.ts`).
   On silence the worklet reports `confidence: 0` — Python's `get_confidence()`
   would return a stale value for the frame it discarded, which the gates threw
   away anyway.
4. **FSRS library version.** Python pins `fsrs==6.3.1`; the JS port uses
   `ts-fsrs@5.4.2` (latest stable FSRS-6 implementation at the time of
   writing; `6.0.0` exists only as a beta). Both implement the same FSRS-6
   formulas with the same 21 default weights, and `Scheduler` keeps the
   py-fsrs semantics where ts-fsrs's choices differ (see below).
5. **Fuzzing is library-internal.** py-fsrs uses the `random` module;
   ts-fsrs derives its fuzz from a per-review seed strategy. The *range*
   (`get_fuzz_range`) is identical, so intervals stay within the same bounds,
   but the exact jitter is not bit-identical between the two front-ends. Set
   `"enable_fuzzing": false` for bit-exact scheduling.
6. **Progress file timestamps.** Python wrote `+00:00` ISO strings, JS writes
   `Z`. Both parse to the same instant; tests compare instants, and
   `importProgressFile()` accepts either (so a `progress.json` written by the
   Python app loads directly — covered by `tests/store.test.ts`).
7. **New feature: cross-device sync.** The Python app was single-machine. The
   web app keeps D1 sync optional and local-first: IndexedDB is the source of
   truth, pushes are debounced (1500 ms), and a remote blob is adopted only
   when there is no local progress or the remote copy is newer.

### FSRS notes (`src/srs/scheduler.ts`)

`Scheduler.reviewCard()` is a branch-for-branch port of py-fsrs 6.3.1's
`Scheduler.review_card()` on top of ts-fsrs's math primitives. Two places
needed a local implementation because ts-fsrs intentionally differs from
py-fsrs:

* **Short-term stability.** py-fsrs's `_short_term_stability()` lets a Hard
  rating *lower* same-day stability; ts-fsrs's `next_short_term_stability()`
  masks the decrease. Same for the `S_MIN` clamp: py-fsrs allows any decrease
  from the current value. `Scheduler.shortTermStability()` restores the
  py-fsrs formula (`S · e^(w17·(rating−3+w18)) · S^−w19`, clamped to
  ≥ 0.001, no lower bound on the delta).
* **Forget stability.** py-fsrs's `_next_forget_stability()` caps the result at
  `S / e^(w17·w18)`; ts-fsrs's `next_forget_stability()` omits the cap.
  `Scheduler.forgetStability()` restores it.
* Initial stability uses py-fsrs's `S_MIN = 0.001` clamp (ts-fsrs floors at
  0.1), and the learning-step arithmetic keeps sub-minute precision: steps are
  stored in milliseconds and `(steps[0] + steps[1]) / 2` is computed exactly
  (py-fsrs's Hard-at-step-0 interval), not rounded to whole minutes.
* Fuzzing is re-seeded per review from
  `` `${reviewDatetime.getTime()}_${step}_${difficulty * stability}` `` so
  repeats are reproducible; the ranges come from ts-fsrs's own
  `get_fuzz_range()` (which also skips fuzzing for intervals < 2.5 days, like
  py-fsrs — verified against the fixture generator).
* `elapsedDays()` floors the exact millisecond delta like Python's
  `timedelta.days`, rather than comparing calendar dates.

## Session behaviour (same as `main()`)

* A confirmed note must pass three gates: `freq ≥ silence_threshold_hz`,
  `confidence ≥ confidence_threshold`, and `required_consecutive_frames`
  consecutive frames of the same MIDI note (`round(69 + 12·log2(f/440))`).
* Correct answer → `ratingForCorrectAnswer(elapsed, wrongAttempts)`:
  any mistake ⇒ Hard; ≤ 2 s ⇒ Easy; ≤ 6 s ⇒ Good; else Hard. Points: Easy 3,
  Good 2, Hard 1, Again −1.
* Wrong note → recorded as `Again` unless the same MIDI note repeats within
  `wrong_repeat_cooldown_sec`; the streak resets so the correct note must be
  held cleanly from scratch.
* After a correct answer the success screen is held for `success_pause_sec`
  (the port of `time.sleep()`, without blocking the audio thread), then the next
  target is picked: `learning_due → review_due → new`, where new cards unlock
  adaptively (`initial_new_cards` now, +1 every `new_card_interval_sec`) and the
  candidate is drawn from the first `random_candidate_window` of a
  Python-equivalent sorted tuple list (`sort(key=...)` semantics, stable).
* When nothing is due the view shows `next_due` and the adaptive-unlock note.

## Storage

IndexedDB database `srs-fretboard` (version 2):

| Store | Key | Content |
| --- | --- | --- |
| `cardRecords` | `${deckId}::${target.key}` | one `CardRecord` plus `deck_id`; v1 `cards` rows are migrated once onto `guitar6-standard` |
| `meta` | `${deckId}::version` etc. | per-deck scheduler header |

`deckId` is the tuning id (presets already encode instrument + tuning). Fret
range is a queue/view filter and is **not** part of the id, so extending 0–12
to 0–24 never discards out-of-range progress.

`toProgressFile()` still produces the Python `progress.json` shape for **one**
deck. Settings → Export writes every deck plus the anonymous token to
`srs-fretboard-backup-YYYY-MM-DD.json`.

Sync endpoints (`functions/api/progress.ts`):

```
GET /api/progress?deck_id=<id>   + header X-User-Token  -> 200 blob | 404
PUT /api/progress?deck_id=<id>   + header X-User-Token  -> upsert
```

No passwords or accounts: `X-User-Token` is a 256-bit `crypto.getRandomValues()`
secret kept in localStorage. D1 primary key is `(user_token, deck_id)`.

## Tests

`npm test` runs 9 files / 71 tests. The parity tests replay fixtures generated
from the *Python* implementation, so they fail if the port drifts:

| File | What it locks down |
| --- | --- |
| `tests/deck.test.ts` | `tests/deck-fixture.json` (78 targets from the real `main.py`), card ids, error messages, `parseNoteToken`, `buildNoteFilter` |
| `tests/srs.test.ts` | `tests/fsrs-fixture.json` (20-review sequence from real `py-fsrs 6.3.1`): state/step/stability/difficulty/due per review, review-log shape, fuzz ranges |
| `tests/store.test.ts` | `tests/store-fixture.json` (12 scripted reviews + 7 prompts through the real `ProgressStore`): every record field, queue buckets + ordering, `queue_stats`, all six `select_next_target` probes (random window, recent-key filter, all-recent fallback, single candidate), `next_due`, reload-from-IndexedDB, hard-clear-then-restore, `progress.json` import |
| `tests/worklet.test.ts` | the worklet file itself (loaded as plain text — proving it is standalone): cents accuracy across all six strings, one message per `buffer_size`, dBFS formula, −50 dB gate, parabolic interpolation |
| `tests/pitch-detector.test.ts` | the three gates, streak/reset semantics, MIDI conversion |
| `tests/audio-engine.test.ts` | constraints (`echoCancellation:false`, …), `addModule('/worklets/pitch-processor.js')`, silent-sink routing, teardown, device memory |
| `tests/config.test.ts` | root vs `public/config.json` byte equality, defaults/clamps, scheduler dict, helper functions, `ratingForCorrectAnswer` |
| `tests/ui.test.tsx` | the rendered screen: target / progress / queue / 40-block meter / ✅❌ note / status lines |
| `tests/sync.test.ts` | query string, 404 handling, debounce/coalescing, offline tolerance |

Fixtures are regenerated from Python (not hand-written):

```bash
python3 tools/gen_deck_fixture.py                 # stdlib only
python3 -m venv .venv && .venv/bin/pip install fsrs==6.3.1
.venv/bin/python tools/gen_fsrs_fixture.py        # needs real py-fsrs
.venv/bin/python tools/gen_store_fixture.py       # needs real py-fsrs
```

`tools/gen_store_fixture.py` prints the bucket/selection summary it dumped, and
pins Python's `random` (fuzzing off) so the replay is deterministic.

## Layout

```
index.html                     Vite entry
public/config.json             runtime config (copy of the root config.json)
public/worklets/pitch-processor.js   AudioWorklet YIN (never bundled)
src/main.tsx, src/App.tsx      mount + the single view
src/components/                VolumeMeter, NoteDisplay, TargetPrompt, QueueStats, StatusBar, DevicePicker
src/audio/                     engine (mic/context/worklet), pitch-detector (gates), note-helpers
src/deck/                      buildTargets/parseNoteToken/buildNoteFilter + types
src/srs/                       scheduler (ts-fsrs), queue (pure), types
src/storage/                   progress-idb (IndexedDB progress.json), sync (D1 client)
src/config/, src/hooks/        ConfigManager + useConfig/useAudio/useSrsSession
functions/api/progress.ts      Pages Function (GET/PUT over D1)
migrations/0001_init.sql       progress(user_id, data, updated_at)
tools/                         Python fixture generators
tests/                         vitest suites + Python-generated fixtures
wrangler.toml                  Pages project + D1 binding
```

## Known limits

* The microphone path can only be exercised in a real browser; `npm run dev`
  (or `npm run preview`) on `localhost` covers it. Everything else — including
  the worklet's DSP — is covered by the Node test suite.
* Session state (current target, wrong-attempt counters, success pause) lives in
  memory only; a refresh resumes from IndexedDB, which means it re-picks the
  next target from the queue rather than restoring the exact prompt.
* Sync has no auth and no merge policy: the last writer wins per uid.
