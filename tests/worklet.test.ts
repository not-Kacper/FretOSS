/**
 * AudioWorklet test — loads /public/worklets/pitch-processor.js *as-is* and
 * checks it against the behaviour the Python app got from
 * `aubio.pitch(method="yin", ...)`:
 *
 *   - a clean guitar-range tone is detected within a few cents
 *   - parabolic interpolation beats the integer-lag resolution (sub-sample)
 *   - `db` follows Python's `rms_to_db()` (20*log10(rms), floor -96)
 *   - aubio's -50 dBFS silence gate zeroes the frequency
 *   - the analysis frame is exactly `bufferSize` samples, so one message is
 *     posted per frame (this is the mic -> UI latency budget)
 *
 * The file is evaluated with `new Function(...)` and the AudioWorklet globals
 * injected, which also proves it is a standalone script: it must not need any
 * bundler, import or other Vite processing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { rmsToDb } from '../src/audio/note-helpers';

const WORKLET_PATH = fileURLToPath(
  new URL('../public/worklets/pitch-processor.js', import.meta.url),
);

interface Frame {
  freq: number;
  confidence: number;
  db: number;
}

interface ProcessorInstance {
  process(inputs: Float32Array[][]): boolean;
  port: { postMessage: (message: unknown) => void };
}

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 4096;

function loadProcessor(options: { bufferSize?: number; tolerance?: number } = {}) {
  const source = readFileSync(WORKLET_PATH, 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    `${source}\nreturn PitchProcessor;`,
  );

  class BaseProcessor {
    port = { postMessage: (_message: unknown) => {}, onmessage: null as unknown };
  }

  let registered: string | null = null;
  const messages: Frame[] = [];
  const ProcessorClass = factory(
    BaseProcessor,
    (name: string, processor: unknown) => {
      registered = name;
      return processor;
    },
    SAMPLE_RATE,
  );

  const processor: ProcessorInstance = new ProcessorClass({
    processorOptions: { bufferSize: options.bufferSize ?? BUFFER_SIZE, tolerance: options.tolerance ?? 0.8 },
  });
  processor.port.postMessage = (message: unknown) => {
    const payload = message as Frame & { type?: string };
    if (payload.type !== 'ready') messages.push(payload);
  };

  return {
    processor,
    messages,
    registered: () => registered,
    /** Feed `samples` in 128-sample render quanta, exactly like the audio thread. */
    feed(samples: Float32Array, quantum = 128): void {
      let offset = 0;
      while (offset < samples.length) {
        const chunk = samples.subarray(offset, Math.min(offset + quantum, samples.length));
        processor.process([[chunk]]);
        offset += chunk.length;
      }
    },
  };
}

/** A steady tone at `freq` Hz, shaped like a plucked string. */
function tone(freq: number, length: number, amplitude = 0.3): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }
  return samples;
}

describe('pitch-processor.js (aubio-compatible YIN)', () => {
  it('registers itself as "pitch-processor"', () => {
    const { registered } = loadProcessor();
    expect(registered()).toBe('pitch-processor');
  });

  it('detects guitar-range tones within a few cents', () => {
    // E2, A2, D3, G3, B3, E4 — the standard tuning open strings.
    const expected = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63];
    for (const freq of expected) {
      const { messages, feed } = loadProcessor();
      feed(tone(freq, BUFFER_SIZE * 3));
      expect(messages.length, `${freq} Hz frame count`).toBe(3);

      const detected = messages[messages.length - 1];
      expect(detected.freq, `${freq} Hz detected`).toBeCloseTo(freq, 0);
      const cents = 1200 * Math.log2(detected.freq / freq);
      expect(Math.abs(cents), `${freq} Hz cents error`).toBeLessThan(20);
      expect(detected.confidence).toBeGreaterThan(0.8);
    }
  });

  it('posts exactly one message per bufferSize samples (latency budget)', () => {
    const { messages, feed } = loadProcessor({ bufferSize: 2048 });
    feed(tone(110, 2048 * 5));
    expect(messages.length).toBe(5);
    expect(2048 / SAMPLE_RATE).toBeCloseTo(0.0464, 4); // ~46 ms per frame
  });

  it('reports the level like Python rms_to_db()', () => {
    const amplitude = 0.5;
    const samples = tone(220, BUFFER_SIZE, amplitude);
    const { messages, feed } = loadProcessor();
    feed(samples);

    // Exactly the main-thread port of `rms_to_db()` over the same samples.
    expect(messages[0].db).toBeCloseTo(rmsToDb(samples), 9);
    // ...and the analytic RMS of a sine (a whole number of periods never fits
    // the window exactly, hence the 0.05 dB bound).
    expect(Math.abs(messages[0].db - 20 * Math.log10(amplitude / Math.SQRT2))).toBeLessThan(0.05);
  });

  it('floors silence at -96 dB and zeroes the pitch (aubio silence gate)', () => {
    const { messages, feed } = loadProcessor();
    feed(new Float32Array(BUFFER_SIZE * 2));
    expect(messages.length).toBe(2);
    for (const frame of messages) {
      expect(frame.freq).toBe(0);
      expect(frame.db).toBe(-96);
      expect(frame.confidence).toBe(0);
    }
  });

  it('applies the -50 dBFS silence gate exactly like aubio_pitch_do()', () => {
    // Just above the gate: -49 dBFS
    const loudEnough = tone(220, BUFFER_SIZE, Math.sqrt(2) * 10 ** (-49 / 20));
    const { messages: above, feed: feedAbove } = loadProcessor();
    feedAbove(loudEnough);
    expect(above[0].freq).toBeGreaterThan(0);

    // Just below the gate: -51 dBFS
    const tooQuiet = tone(220, BUFFER_SIZE, Math.sqrt(2) * 10 ** (-51 / 20));
    const { messages: below, feed: feedBelow } = loadProcessor();
    feedBelow(tooQuiet);
    expect(below[0].freq).toBe(0);
  });

  it('interpolates sub-sample period accuracy (parabolic peak)', () => {
    // A tone whose period is deliberately not an integer number of samples:
    // 44100 / 512.5 ≈ 86.05 Hz. Integer-lag YIN alone would land on 86.13 Hz.
    const freq = 86.0487; // 44100 / 512.5
    const { messages, feed } = loadProcessor();
    feed(tone(freq, BUFFER_SIZE * 2));
    const detected = messages[messages.length - 1].freq;
    const integerLagFreq = SAMPLE_RATE / 512; // what a non-interpolated lag gives
    expect(Math.abs(detected - freq)).toBeLessThan(Math.abs(integerLagFreq - freq));
    expect(detected).toBeCloseTo(freq, 1);
  });

  it('uses the configured tolerance (config.pitch_detection.pitch_tolerance)', () => {
    // With a very strict threshold, noisy input no longer crosses it early and
    // the detector falls back to the global minimum of the YIN function — the
    // confidence reported comes from that minimum either way.
    const { messages, feed } = loadProcessor({ tolerance: 0.01 });
    const noisy = tone(146.83, BUFFER_SIZE);
    for (let i = 0; i < noisy.length; i++) noisy[i] += (Math.random() - 0.5) * 0.01;
    feed(noisy);
    expect(messages[0].confidence).toBeGreaterThan(0.5);
    expect(messages[0].freq).toBeGreaterThan(100);
    expect(messages[0].freq).toBeLessThan(200);
  });
});
