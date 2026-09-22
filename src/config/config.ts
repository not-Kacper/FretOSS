/**
 * config/config.ts — port of main.py's `ConfigManager`.
 *
 * Loads config.json once at app start and exposes the same typed accessors, so
 * every default and clamp in Python (`.get(..., default)` + `max(0, ...)`) is
 * preserved here. Browser-only differences:
 *
 *   - `progress_path` / `app_state_path` (files) have no meaning in the browser;
 *     they are kept in the schema for cross-compatibility but the equivalents
 *     are IndexedDB (progress) and localStorage (remembered input device).
 *   - `create_scheduler()` is delegated to src/srs/scheduler.ts.
 */

import { createScheduler, type Scheduler } from '../srs/scheduler';
import type { SrsConfig } from '../srs/types';
import type { DeckConfig } from '../deck/deck';

export interface AudioConfig {
  sample_rate: number;
  buffer_size: number;
}

export interface PitchDetectionConfig {
  algorithm: string;
  confidence_threshold: number;
  silence_threshold_hz: number;
  pitch_tolerance: number;
}

export interface StabilityConfig {
  required_consecutive_frames: number;
}

export interface RawConfig {
  app_state_path?: string;
  audio: AudioConfig;
  pitch_detection: PitchDetectionConfig;
  stability: StabilityConfig;
  deck: DeckConfig;
  srs: SrsConfig;
}

/** The URL the client-side config is served from (public/config.json). */
export const CONFIG_URL = `${import.meta.env.BASE_URL}config.json`;

/** main.py: ConfigManager with the same accessors, camelCased. */
export class ConfigManager {
  readonly path: string;
  readonly raw: RawConfig;

  constructor(raw: RawConfig, path = CONFIG_URL) {
    this.raw = raw;
    this.path = path;
  }

  // -- audio ---------------------------------------------------------------

  get sampleRate(): number {
    return Math.trunc(this.raw.audio.sample_rate);
  }

  get bufferSize(): number {
    return Math.trunc(this.raw.audio.buffer_size);
  }

  // -- pitch detection -----------------------------------------------------

  get algorithm(): string {
    return String(this.raw.pitch_detection.algorithm);
  }

  get confidenceThreshold(): number {
    return Number(this.raw.pitch_detection.confidence_threshold);
  }

  get silenceThresholdHz(): number {
    return Number(this.raw.pitch_detection.silence_threshold_hz);
  }

  get pitchTolerance(): number {
    return Number(this.raw.pitch_detection.pitch_tolerance);
  }

  /** main.py: `stability.required_consecutive_frames`. */
  get stabilityFrames(): number {
    return Math.trunc(this.raw.stability.required_consecutive_frames);
  }

  // -- deck / srs ----------------------------------------------------------

  get deckConfig(): DeckConfig {
    return { ...(this.raw.deck ?? {}) };
  }

  get srsConfig(): SrsConfig {
    return { ...(this.raw.srs ?? {}) };
  }

  /** Kept for schema compatibility with the Python progress file. */
  get progressPath(): string {
    return String(this.srsConfig.progress_path ?? 'progress.json');
  }

  /** Kept for schema compatibility with the Python app_state.json. */
  get appStatePath(): string {
    return String(this.raw.app_state_path ?? 'app_state.json');
  }

  // -- session pacing (used by the SRS session hook) -----------------------

  get easyThresholdSec(): number {
    return Number(this.srsConfig.easy_threshold_sec ?? 2.0);
  }

  get hardThresholdSec(): number {
    return Number(this.srsConfig.hard_threshold_sec ?? 6.0);
  }

  get wrongRepeatCooldownSec(): number {
    return Number(this.srsConfig.wrong_repeat_cooldown_sec ?? 1.5);
  }

  get successPauseSec(): number {
    return Number(this.srsConfig.success_pause_sec ?? 0.8);
  }

  get initialNewCards(): number {
    return Math.max(0, Math.trunc(this.srsConfig.initial_new_cards ?? 3));
  }

  get newCardIntervalSec(): number {
    return Math.max(1.0, Number(this.srsConfig.new_card_interval_sec ?? 45.0));
  }

  get randomCandidateWindow(): number {
    return Math.max(1, Math.trunc(this.srsConfig.random_candidate_window ?? 8));
  }

  /**
   * main.py: `ConfigManager.new_card_allowance(session_elapsed_sec)`.
   * (The pure implementation lives in srs/queue.ts; this is the same function
   * bound to the configured knobs.)
   */
  newCardAllowance(sessionElapsedSec: number): number {
    const extra = Math.floor(Math.max(0, sessionElapsedSec) / this.newCardIntervalSec);
    return this.initialNewCards + extra;
  }

  /**
   * main.py: `ConfigManager.create_scheduler()` — build the FSRS scheduler from
   * the `srs` block.
   */
  createScheduler(): Scheduler {
    return createScheduler(this.srsConfig);
  }
}

/**
 * main.py: `ConfigManager._load()` — parse a config.json payload.
 *
 * Throws on a malformed payload (Python prints and `sys.exit(1)`s).
 */
export function parseConfig(raw: unknown, path = CONFIG_URL): ConfigManager {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`config.json must contain a JSON object (${path}).`);
  }
  const config = raw as Partial<RawConfig>;
  if (!config.audio || !config.pitch_detection || !config.stability) {
    throw new Error(
      `config.json is missing required sections (audio / pitch_detection / stability) in ${path}.`,
    );
  }
  return new ConfigManager(
    {
      ...(config as RawConfig),
      deck: config.deck ?? {},
      srs: config.srs ?? {},
    },
    path,
  );
}

/**
 * Loads config.json once at app start (main.py reads the file synchronously at
 * startup; the browser equivalent is a single fetch).
 */
export async function loadConfig(path = CONFIG_URL): Promise<ConfigManager> {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Could not load '${path}' (HTTP ${response.status}).`);
  }
  return parseConfig(await response.json(), path);
}
