/**
 * Three-gate filter test — the main-thread half of `PitchProcessor.process()`.
 *
 * Feeds synthetic worklet messages through src/audio/pitch-detector.ts and
 * checks each gate in isolation, plus the streak/reset semantics the session
 * relies on (`processor.reset()` after mistakes and between prompts).
 */

import { describe, expect, it } from 'vitest';

import { attachPitchDetector, type PitchFrame } from '../src/audio/pitch-detector';
import type { NoteEvent } from '../src/deck/types';

const CONFIG = {
  silenceThresholdHz: 60,
  confidenceThreshold: 0.8,
  stabilityFrames: 3,
};

/** Minimal stand-in for an AudioWorkletNode's MessagePort. */
function fakeNode() {
  const listeners = new Set<(event: { data: unknown }) => void>();
  return {
    port: {
      addEventListener: (_type: string, listener: (event: { data: unknown }) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { data: unknown }) => void) =>
        listeners.delete(listener),
      start: () => {},
    },
    emit: (data: PitchFrame | { type: string }) => {
      for (const listener of [...listeners]) listener({ data });
    },
    listenerCount: () => listeners.size,
  } as unknown as AudioWorkletNode & {
    emit: (data: PitchFrame | { type: string }) => void;
    listenerCount: () => number;
  };
}

function collect() {
  const frames: { frame: PitchFrame; note: NoteEvent | null }[] = [];
  const notes: NoteEvent[] = [];
  return {
    frames,
    notes,
    handlers: {
      onFrame: (frame: PitchFrame, note: NoteEvent | null) => {
        frames.push({ frame, note });
        if (note) notes.push(note);
      },
    },
  };
}

describe('PitchProcessor three-gate port', () => {
  it('gate 1: rejects frequencies below silence_threshold_hz and clears the streak', () => {
    const node = fakeNode();
    const sink = collect();
    const detector = attachPitchDetector(node, CONFIG, sink.handlers);

    // Two stable frames, then a sub-threshold frame, then two more: the streak
    // must restart, so no note is ever emitted.
    node.emit({ freq: 110, confidence: 0.99, db: -20 });
    node.emit({ freq: 110, confidence: 0.99, db: -20 });
    node.emit({ freq: 0, confidence: 0.99, db: -96 }); // silence (aubio zeroes it)
    node.emit({ freq: 110, confidence: 0.99, db: -20 });
    node.emit({ freq: 110, confidence: 0.99, db: -20 });

    expect(sink.notes).toHaveLength(0);
    expect(detector.streak()).toBe(2);
    expect(sink.frames).toHaveLength(5);
    detector.cleanup();
  });

  it('gate 2: rejects low-confidence frames and clears the streak', () => {
    const node = fakeNode();
    const sink = collect();
    const detector = attachPitchDetector(node, CONFIG, sink.handlers);

    node.emit({ freq: 220, confidence: 0.99, db: -20 });
    node.emit({ freq: 220, confidence: 0.5, db: -20 }); // below threshold
    node.emit({ freq: 220, confidence: 0.99, db: -20 });
    node.emit({ freq: 220, confidence: 0.99, db: -20 });

    expect(sink.notes).toHaveLength(0);
    expect(sink.frames.every((entry) => entry.note === null)).toBe(true);
    detector.cleanup();
  });

  it('gate 3: emits only after `stability_frames` consecutive frames of the same MIDI note', () => {
    const node = fakeNode();
    const sink = collect();
    const detector = attachPitchDetector(node, CONFIG, sink.handlers);

    // A4 = 440 Hz, then A4 again with a small detune (same MIDI note).
    node.emit({ freq: 440, confidence: 0.99, db: -20 });
    node.emit({ freq: 436, confidence: 0.99, db: -20 });
    expect(sink.notes).toHaveLength(0);
    node.emit({ freq: 441, confidence: 0.99, db: -20 });
    expect(sink.notes).toHaveLength(1);
    expect(sink.notes[0]).toEqual({ midiNote: 69, frequency: 441, confidence: 0.99 });

    // Continuing the same note keeps emitting (Python scored every frame).
    node.emit({ freq: 440, confidence: 0.95, db: -20 });
    expect(sink.notes).toHaveLength(2);

    // A different note restarts the streak (attack transients are filtered).
    node.emit({ freq: 494, confidence: 0.99, db: -20 }); // B4
    node.emit({ freq: 494, confidence: 0.99, db: -20 });
    expect(sink.notes).toHaveLength(2);
    node.emit({ freq: 494, confidence: 0.99, db: -20 });
    expect(sink.notes).toHaveLength(3);
    expect(sink.notes[2].midiNote).toBe(71);
    detector.cleanup();
  });

  it('resetStreak() forces the note to be re-confirmed (main.py: processor.reset())', () => {
    const node = fakeNode();
    const sink = collect();
    const detector = attachPitchDetector(node, CONFIG, sink.handlers);

    for (let i = 0; i < 4; i++) node.emit({ freq: 110, confidence: 0.99, db: -20 });
    expect(sink.notes).toHaveLength(2);

    detector.resetStreak();
    node.emit({ freq: 110, confidence: 0.99, db: -20 });
    expect(sink.notes).toHaveLength(2); // needs 3 fresh frames again
    expect(detector.streak()).toBe(1);
    detector.cleanup();
  });

  it('uses the same MIDI conversion as Python (round(69 + 12*log2(f/440)))', () => {
    const node = fakeNode();
    const sink = collect();
    const detector = attachPitchDetector(node, { ...CONFIG, stabilityFrames: 1 }, sink.handlers);

    const cases: Array<[number, number]> = [
      [82.41, 40], // E2
      [110.0, 45], // A2
      [146.83, 50], // D3
      [196.0, 55], // G3
      [246.94, 59], // B3
      [329.63, 64], // E4
      [440.0, 69], // A4
    ];
    for (const [freq, midi] of cases) {
      node.emit({ freq, confidence: 0.99, db: -20 });
      expect(sink.notes[sink.notes.length - 1].midiNote, `${freq} Hz`).toBe(midi);
    }
    detector.cleanup();
  });

  it('ignores the worklet "ready" notice and detaches on cleanup', () => {
    const node = fakeNode();
    const sink = collect();
    const detector = attachPitchDetector(node, CONFIG, sink.handlers);

    node.emit({ type: 'ready' } as never);
    expect(sink.frames).toHaveLength(0);

    expect(node.listenerCount()).toBe(1);
    detector.cleanup();
    expect(node.listenerCount()).toBe(0);

    node.emit({ freq: 440, confidence: 0.99, db: -20 });
    expect(sink.frames).toHaveLength(0);
  });
});
