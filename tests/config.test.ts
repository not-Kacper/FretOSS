/**
 * Config + helper parity — the parts of main.py that were pure functions.
 *
 * Also guards the one structural compromise of this port: the browser needs
 * `public/config.json` while the Python app keeps reading the repo-root
 * `config.json`, so the two files must stay byte-identical.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  formatWait,
  freqToMidi,
  midiToFreq,
  midiToName,
  rmsToDb,
  semitoneInterval,
} from '../src/audio/note-helpers';
import { parseConfig, type RawConfig } from '../src/config/config';
import { ratingForCorrectAnswer, createScheduler } from '../src/srs/scheduler';
import { Rating } from '../src/srs/types';
import publicConfig from '../public/config.json';
import rootConfig from '../config.json';

const config = parseConfig(publicConfig);

describe('config.json', () => {
  it('is identical in the repo root (Python app) and public/ (browser)', () => {
    const rootPath = fileURLToPath(new URL('../config.json', import.meta.url));
    const publicPath = fileURLToPath(new URL('../public/config.json', import.meta.url));
    // Compare parsed JSON and the raw bytes: a whitespace-only diff would still
    // mean the two front-ends disagree about their defaults.
    expect(JSON.parse(readFileSync(publicPath, 'utf8'))).toEqual(
      JSON.parse(readFileSync(rootPath, 'utf8')),
    );
    expect(readFileSync(publicPath, 'utf8')).toBe(readFileSync(rootPath, 'utf8'));
    expect(publicConfig).toEqual(rootConfig);
  });

  it('exposes the same accessors (and defaults) as ConfigManager', () => {
    expect(config.sampleRate).toBe(44100);
    expect(config.bufferSize).toBe(4096);
    expect(config.algorithm).toBe('yin');
    expect(config.confidenceThreshold).toBe(0.8);
    expect(config.silenceThresholdHz).toBe(60.0);
    expect(config.pitchTolerance).toBe(0.8);
    expect(config.stabilityFrames).toBe(3);
    expect(config.easyThresholdSec).toBe(2.0);
    expect(config.hardThresholdSec).toBe(6.0);
    expect(config.wrongRepeatCooldownSec).toBe(1.5);
    expect(config.successPauseSec).toBe(0.8);
    expect(config.initialNewCards).toBe(3);
    expect(config.newCardIntervalSec).toBe(45.0);
    expect(config.randomCandidateWindow).toBe(8);
    expect(config.deckConfig.max_fret).toBe(12);
    expect(config.progressPath).toBe('progress.json');
    expect(config.appStatePath).toBe('app_state.json');
  });

  it('applies the same clamps and fallbacks as Python `.get(..., default)` calls', () => {
    const empty = parseConfig({
      audio: { sample_rate: 48000, buffer_size: 2048 },
      pitch_detection: {
        algorithm: 'yin',
        confidence_threshold: 0.9,
        silence_threshold_hz: 70,
        pitch_tolerance: 0.2,
      },
      stability: { required_consecutive_frames: 5 },
    });

    expect(empty.easyThresholdSec).toBe(2.0);
    expect(empty.hardThresholdSec).toBe(6.0);
    expect(empty.wrongRepeatCooldownSec).toBe(1.5);
    expect(empty.successPauseSec).toBe(0.8);
    expect(empty.initialNewCards).toBe(3);
    expect(empty.newCardIntervalSec).toBe(45.0);
    expect(empty.randomCandidateWindow).toBe(8);

    // max(0, ...) / max(1, ...) / max(1.0, ...) clamps
    expect(
      parseConfig({
        ...(publicConfig as RawConfig),
        srs: { ...config.srsConfig, initial_new_cards: -5, new_card_interval_sec: 0, random_candidate_window: 0 },
      }).initialNewCards,
    ).toBe(0);
    expect(
      parseConfig({
        ...(publicConfig as RawConfig),
        srs: { ...config.srsConfig, new_card_interval_sec: 0.2 },
      }).newCardIntervalSec,
    ).toBe(1.0);
    expect(
      parseConfig({
        ...(publicConfig as RawConfig),
        srs: { ...config.srsConfig, random_candidate_window: 0 },
      }).randomCandidateWindow,
    ).toBe(1);
  });

  it('rejects configs missing required sections, like main.py erroring on a bad file', () => {
    expect(() => parseConfig(null)).toThrow(/JSON object/);
    expect(() => parseConfig({ audio: { sample_rate: 44100, buffer_size: 4096 } })).toThrow(
      /missing required sections/,
    );
  });

  it('builds the same scheduler as ConfigManager.create_scheduler()', () => {
    const scheduler = config.createScheduler();
    expect(scheduler.desiredRetention).toBe(0.9);
    expect(scheduler.learningStepsMs).toEqual([60_000, 600_000]);
    expect(scheduler.relearningStepsMs).toEqual([600_000]);
    expect(scheduler.maximumInterval).toBe(36500);
    expect(scheduler.enableFuzzing).toBe(true);
    expect(scheduler.parameters).toHaveLength(21);

    // py-fsrs `Scheduler.to_dict()` (the `scheduler` block of progress.json).
    expect(scheduler.toDict()).toEqual({
      parameters: [
        0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
        0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
      ],
      desired_retention: 0.9,
      learning_steps: [60, 600],
      relearning_steps: [600],
      maximum_interval: 36500,
      enable_fuzzing: true,
    });
  });

  it('honours a custom `srs.parameters` list (py-fsrs `parameters=` argument)', () => {
    const custom = createScheduler({ parameters: Array(21).fill(0.5) });
    expect(custom.parameters).toEqual(Array(21).fill(0.5));
  });
});

describe('note helpers', () => {
  it('midi_to_name matches the Python lookup table', () => {
    expect(midiToName(40)).toBe('E2');
    expect(midiToName(45)).toBe('A2');
    expect(midiToName(64)).toBe('E4');
    expect(midiToName(69)).toBe('A4');
    expect(midiToName(0)).toBe('C-1');
    expect(midiToName(76)).toBe('E5');
  });

  it('freqToMidi uses round(69 + 12*log2(f/440))', () => {
    expect(freqToMidi(440)).toBe(69);
    expect(freqToMidi(220)).toBe(57);
    expect(freqToMidi(82.41)).toBe(40);
    expect(freqToMidi(0)).toBe(0);
    expect(freqToMidi(-5)).toBe(0);
    // 444 Hz is closer to A4 (0.4 semitones) than to A#4.
    expect(freqToMidi(444)).toBe(69);
  });

  it('midiToFreq inverts freqToMidi', () => {
    for (const midi of [40, 45, 50, 55, 59, 64, 69]) {
      expect(freqToMidi(midiToFreq(midi))).toBe(midi);
    }
  });

  it('rms_to_db floors at -96 dB like Python', () => {
    expect(rmsToDb(new Float32Array(1024))).toBe(-96);
    const quiet = new Float32Array(1024).fill(1e-7);
    expect(rmsToDb(quiet)).toBe(-96);
    // 20*log10(0.5 / sqrt(2)) for a full-scale sine at half amplitude
    const amp = 0.5;
    const sine = new Float32Array(1000);
    for (let i = 0; i < sine.length; i++) sine[i] = amp * Math.sin(i / 5);
    expect(rmsToDb(sine)).toBeCloseTo(20 * Math.log10(amp / Math.SQRT2), 1);
  });

  it('semitoneInterval is instrument-agnostic MIDI math', () => {
    expect(semitoneInterval(40, 45)).toBe(5);
    expect(semitoneInterval(64, 64)).toBe(0);
    expect(semitoneInterval(67, 60)).toBe(-7);
  });

  it('formatWait matches Python `_format_wait`', () => {
    expect(formatWait(12_000)).toBe('12s');
    expect(formatWait(200_000)).toBe('3m 20s');
    expect(formatWait(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
    expect(formatWait(-1000)).toBe('0s');
    expect(formatWait(45_000)).toBe('45s');
  });
});

describe('rating_for_correct_answer', () => {
  const cfg = { easyThresholdSec: 2.0, hardThresholdSec: 6.0 };

  it('maps elapsed time and wrong attempts exactly like Python', () => {
    expect(ratingForCorrectAnswer(0.5, 0, cfg)).toBe(Rating.Easy);
    expect(ratingForCorrectAnswer(2.0, 0, cfg)).toBe(Rating.Easy);
    expect(ratingForCorrectAnswer(2.1, 0, cfg)).toBe(Rating.Good);
    expect(ratingForCorrectAnswer(6.0, 0, cfg)).toBe(Rating.Good);
    expect(ratingForCorrectAnswer(6.1, 0, cfg)).toBe(Rating.Hard);
    // Any correct answer after a mistake is Hard, however fast it was.
    expect(ratingForCorrectAnswer(0.2, 1, cfg)).toBe(Rating.Hard);
    expect(ratingForCorrectAnswer(1.0, 3, cfg)).toBe(Rating.Hard);
  });
});
