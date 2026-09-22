/**
 * audio/pitch-detector.ts — main-thread half of the detector.
 *
 * Port of main.py's `PitchProcessor`:
 *
 *   PitchProcessor.process()      -> the port.onmessage handler below
 *   Gate 1  freq < silence_threshold_hz   -> gate 1
 *   Gate 2  confidence < threshold        -> gate 2
 *   Gate 3  same MIDI note for N frames   -> gate 3 (stability / debounce)
 *   PitchProcessor.reset()        -> resetStreak()
 *   PitchProcessor._freq_to_midi  -> freqToMidi() (audio/note-helpers.ts)
 *
 * The heavy lifting (YIN + RMS) happens on the audio thread in
 * /public/worklets/pitch-processor.js; this module owns the *decision* logic,
 * exactly like the Python class did for `aubio.pitch`'s output.
 *
 * Every frame that survives the gates (i.e. every confirmed note) is emitted as
 * a `NoteEvent` — including repeats of the same note on consecutive frames,
 * because the Python main loop scored every confirmed frame, not just note
 * changes. Frames that fail a gate emit `onFrame(...)` with `note = null` so the
 * UI can fall back to "Listening..." and the volume meter can keep moving.
 */

import { freqToMidi } from './note-helpers';
import type { NoteEvent } from '../deck/types';

/** The raw payload posted by the AudioWorklet once per analysis frame. */
export interface PitchFrame {
  /** Detected frequency in Hz (0 when aubio's silence gate zeroed it). */
  freq: number;
  /** YIN confidence in [0, 1]. */
  confidence: number;
  /** Input level in dBFS, computed like Python's `rms_to_db()`. */
  db: number;
}

/** The subset of config.json the detector needs. */
export interface PitchDetectorConfig {
  silenceThresholdHz: number;
  confidenceThreshold: number;
  stabilityFrames: number;
}

export interface PitchDetectorHandlers {
  /**
   * Called for every analysis frame. `note` is non-null exactly when the three
   * gates passed (equivalent to `PitchProcessor.process()` returning a
   * `NoteEvent`).
   */
  onFrame: (frame: PitchFrame, note: NoteEvent | null) => void;
}

export interface PitchDetector {
  /** main.py: `PitchProcessor.reset()` — clears the stability streak. */
  resetStreak: () => void;
  /** Number of consecutive frames the current note has been held (diagnostics). */
  streak: () => number;
  /** Detach from the worklet port (React useEffect cleanup). */
  cleanup: () => void;
}

/**
 * main.py: `PitchProcessor.__init__` + `PitchProcessor.process()`.
 *
 * Attaches to an AudioWorkletNode produced by `startAudioEngine()` and calls
 * `handlers.onFrame` for each analysis frame.
 */
export function attachPitchDetector(
  node: AudioWorkletNode,
  config: PitchDetectorConfig,
  handlers: PitchDetectorHandlers,
): PitchDetector {
  // Stability filter state (main.py: `_prev_midi` / `_streak`).
  let prevMidi: number | null = null;
  let streak = 0;

  const resetStreak = (): void => {
    prevMidi = null;
    streak = 0;
  };

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as Partial<PitchFrame> & { type?: string };
    if (!data || typeof data !== 'object' || !('freq' in data)) return; // "ready" notices

    const frame: PitchFrame = {
      freq: Number(data.freq ?? 0),
      confidence: Number(data.confidence ?? 0),
      db: Number(data.db ?? -96),
    };

    // ---- Gate 1: silence / sub-bass rejection --------------------------
    // (aubio already zeroes the pitch below -50 dBFS, so silence lands here.)
    if (!(frame.freq >= config.silenceThresholdHz)) {
      resetStreak();
      handlers.onFrame(frame, null);
      return;
    }

    // ---- Gate 2: confidence threshold ----------------------------------
    if (!(frame.confidence >= config.confidenceThreshold)) {
      resetStreak();
      handlers.onFrame(frame, null);
      return;
    }

    // ---- Gate 3: stability / debounce ----------------------------------
    const midiNote = freqToMidi(frame.freq);
    if (midiNote === prevMidi) {
      streak += 1;
    } else {
      // New note — restart the counter.
      prevMidi = midiNote;
      streak = 1;
    }

    if (streak >= config.stabilityFrames) {
      handlers.onFrame(frame, {
        midiNote,
        frequency: frame.freq,
        confidence: frame.confidence,
      });
      return;
    }

    handlers.onFrame(frame, null); // Still accumulating — not stable yet.
  };

  node.port.addEventListener('message', onMessage);
  node.port.start();

  return {
    resetStreak,
    streak: () => streak,
    cleanup: () => {
      node.port.removeEventListener('message', onMessage);
      resetStreak();
    },
  };
}
