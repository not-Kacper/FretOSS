/**
 * pitch-processor.js — AudioWorkletProcessor: YIN pitch detection + RMS metering.
 * =============================================================================
 *
 * This file is served **as-is** from /public/worklets/ and loaded with
 * `audioWorklet.addModule()`: it is a standalone JS file, never bundled or
 * transpiled by Vite. It runs on the **audio rendering thread**, not the main
 * thread, which is the whole point of using an AudioWorkletProcessor instead of
 * the deprecated ScriptProcessorNode.
 *
 * It is a faithful port of the exact code path the Python app reaches through
 * `aubio.pitch(method="yin", buf_size=config.buffer_size,
 *                hop_size=config.buffer_size, samplerate=config.sample_rate)`:
 *
 *   aubio/src/pitch/pitchyin.c : aubio_pitchyin_do(), aubio_pitchyin_get_confidence()
 *   aubio/src/pitch/pitch.c    : aubio_pitch_do_yin(), aubio_pitch_do() (silence gate)
 *   aubio/src/mathutils.c      : fvec_quadratic_peak_pos(), fvec_min_elem(), aubio_db_spl()
 *   aubio/src/fvec.c           : frame handling (Python passes hop_size == buf_size,
 *                                so `aubio_pitch_slideblock()` is a no-op: each
 *                                analysis frame is exactly `buffer_size` fresh samples)
 *
 * Algorithm detail (do not "improve" — aubio compatibility is the point):
 *   1. YIN difference function d(tau) over the first `half = floor(n/2)` samples,
 *      with tau in [1, half).
 *   2. Cumulative-mean-normalised difference (CMND), computed in place exactly as
 *      aubio does (`tmp2` accumulates the *raw* d(tau) values, then the slot is
 *      scaled by `tau / tmp2`; a zero running sum yields 1.0).
 *   3. Absolute-threshold search: while walking tau upwards, the first tau > 4 that
 *      satisfies `yin[tau-3] < tol && yin[tau-3] < yin[tau-2]` wins, and the peak
 *      index is `tau - 3` (this is aubio's "period = tau - 3" early return).
 *   4. Otherwise the global minimum of the (normalised) function is used; ties go
 *      to the *last* index, exactly like aubio's `fvec_min_elem()`.
 *   5. Sub-sample accuracy via parabolic interpolation (`fvec_quadratic_peak_pos`).
 *   6. `period -> freq`: freq = sampleRate / period (aubio_pitch_do_yin).
 *   7. Confidence = 1 - yin[peak_pos] (aubio_pitchyin_get_confidence).
 *   8. Silence gate: aubio_pitch_do() zeroes the pitch when
 *      `10 * log10(mean(x^2)) < -50 dBFS` (DEFAULT_PITCH_SILENCE).
 *   9. `db` is the same level in dBFS as Python's `rms_to_db()`
 *      (20*log10(rms), floored at -96 dB).
 *
 * Note: unlike aubio (float32), the maths here runs in float64 (JS numbers).
 * That is *more* precise, and the thresholds used downstream
 * (silence_threshold_hz / confidence_threshold) are far coarser than the
 * resulting difference.
 *
 * Processor options (all optional; supplied by src/audio/engine.ts):
 *   bufferSize  {number}  analysis window in samples  (config.audio.buffer_size)
 *   tolerance   {number}  YIN absolute threshold      (config.pitch_detection.pitch_tolerance)
 *   algorithm   {string}  only "yin" is implemented
 */

const DEFAULT_TOLERANCE = 0.15; // aubio's new_aubio_pitchyin() default.
const DEFAULT_SILENCE_DB = -50; // aubio's DEFAULT_PITCH_SILENCE.
const DB_FLOOR = -96; // Python rms_to_db(): "silence floor".

class PitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = (options && options.processorOptions) || {};
    if (opts.algorithm && opts.algorithm !== 'yin') {
      // The Python config exposes `pitch_detection.algorithm`; only `yin` is ported.
      throw new Error(`pitch-processor: unsupported algorithm '${opts.algorithm}'`);
    }

    const requested = Math.floor(Number(opts.bufferSize));
    if (!Number.isFinite(requested) || requested < 4) {
      throw new Error(`pitch-processor: invalid bufferSize '${opts.bufferSize}'`);
    }

    // aubio requires bufsize >= hopsize and uses `bufsize / 2` for the difference
    // function; keep the window even so `half` is unambiguous.
    this.bufferSize = requested % 2 === 0 ? requested : requested + 1;
    this.half = Math.floor(this.bufferSize / 2);
    this.tolerance = Number.isFinite(Number(opts.tolerance))
      ? Number(opts.tolerance)
      : DEFAULT_TOLERANCE;
    this.silenceDb = Number.isFinite(Number(opts.silenceDb))
      ? Number(opts.silenceDb)
      : DEFAULT_SILENCE_DB;

    this.sampleRate = sampleRate; // AudioWorkletProcessor global.

    // Ring buffer holding the most recent `bufferSize` input samples.
    this.ring = new Float32Array(this.bufferSize);
    this.writePos = 0;

    // Scratch buffers (allocated once — no GC churn on the audio thread).
    this.window = new Float64Array(this.bufferSize); // chronological copy of the ring
    this.yin = new Float64Array(this.half);

    this.keepAlive = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.keepAlive = false;
    };

    this.port.postMessage({
      type: 'ready',
      bufferSize: this.bufferSize,
      half: this.half,
      sampleRate: this.sampleRate,
      tolerance: this.tolerance,
    });
  }

  /** Quadratic peak interpolation — aubio `fvec_quadratic_peak_pos()`. */
  quadraticPeakPos(x, pos) {
    if (pos === 0 || pos === x.length - 1) return pos;
    const s0 = x[pos - 1];
    const s1 = x[pos];
    const s2 = x[pos + 1];
    const denom = s0 - 2 * s1 + s2;
    if (denom === 0) return pos;
    return pos + 0.5 * (s0 - s2) / denom;
  }

  /**
   * YIN on the current window (aubio `aubio_pitchyin_do`).
   * Returns { period, peakPos } in samples; period === 0 when nothing was found.
   */
  detectPeriod() {
    const x = this.window;
    const half = this.half;
    const yin = this.yin;
    const tol = this.tolerance;

    yin[0] = 1;
    let runningSum = 0;
    let peakPos = 0;
    let period = 0;

    for (let tau = 1; tau < half; tau++) {
      // Difference function d(tau) over the first `half` samples.
      let acc = 0;
      for (let j = 0; j < half; j++) {
        const d = x[j] - x[j + tau];
        acc += d * d;
      }
      yin[tau] = acc;

      // Cumulative mean normalisation (in place, aubio's order of operations).
      runningSum += acc;
      yin[tau] = runningSum !== 0 ? yin[tau] * (tau / runningSum) : 1;

      // Absolute threshold: first minimum below `tol` (aubio checks tau - 3).
      const p = tau - 3;
      if (tau > 4 && yin[p] < tol && yin[p] < yin[p + 1]) {
        peakPos = p;
        period = this.quadraticPeakPos(yin, p);
        return { period, peakPos };
      }
    }

    // No threshold crossing: fall back to the global minimum (`fvec_min_elem`:
    // ties resolve to the last index).
    let pos = 0;
    let min = yin[0];
    for (let j = 0; j < half; j++) {
      if (!(min < yin[j])) {
        pos = j;
        min = yin[j];
      }
    }
    peakPos = pos;
    period = this.quadraticPeakPos(yin, pos);
    return { period, peakPos };
  }

  /** Analyse one full analysis frame and post {freq, confidence, db} upstream. */
  analyse() {
    const n = this.bufferSize;

    // Linearise the ring buffer into chronological order (oldest sample first).
    const ring = this.ring;
    const x = this.window;
    let read = this.writePos;
    for (let i = 0; i < n; i++) {
      x[i] = ring[read];
      read++;
      if (read === n) read = 0;
    }

    // ---- Level metering — Python `rms_to_db()` --------------------------
    let sumSquares = 0;
    for (let i = 0; i < n; i++) sumSquares += x[i] * x[i];
    const meanSquare = sumSquares / n;
    const rms = Math.sqrt(meanSquare);
    const db =
      rms < 1e-10 ? DB_FLOOR : Math.max(DB_FLOOR, 20 * Math.log10(rms));

    // ---- Silence gate — aubio `aubio_pitch_do()` / `aubio_db_spl()` -----
    // aubio zeroes the pitch when 10*log10(mean(x^2)) < -50 dBFS.
    const levelDb = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -Infinity;
    if (levelDb < this.silenceDb) {
      this.port.postMessage({ freq: 0, confidence: 0, db });
      return;
    }

    // ---- YIN -----------------------------------------------------------
    const { period, peakPos } = this.detectPeriod();
    const freq = period > 0 ? this.sampleRate / period : 0;
    const confidence = 1 - this.yin[peakPos];

    this.port.postMessage({ freq, confidence, db });
  }

  process(inputs) {
    if (!this.keepAlive) return false;

    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono tap: the Python app opens 1 input channel
    if (!channel) return true;

    const ring = this.ring;
    const n = this.bufferSize;
    let frameComplete = false;

    for (let i = 0; i < channel.length; i++) {
      ring[this.writePos] = channel[i];
      this.writePos++;
      if (this.writePos >= n) {
        this.writePos = 0;
        frameComplete = true; // hop_size == buffer_size, exactly like the Python app
      }
    }

    if (frameComplete) this.analyse();
    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
