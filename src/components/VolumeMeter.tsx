/**
 * VolumeMeter.tsx — port of `TerminalDisplay._build_volume_bar()`.
 *
 * Maps -96 dB -> 0 blocks and 0 dB -> full bar, coloured green -> yellow -> red
 * at the same thresholds as the terminal version (< 50% green, < 80% yellow,
 * else red), and prints the dBFS value with Python's `{:+5.1f}` format.
 */

export interface VolumeMeterProps {
  /** Input level in dBFS (Python: `rms_to_db(samples)`). */
  db: number;
  /** Number of blocks — TerminalDisplay.METER_WIDTH was 40. */
  width?: number;
  label?: string;
}

/** Python: `f"{db_level:+5.1f} dB"`. */
export function formatDb(db: number): string {
  const clamped = Math.max(-96, Math.min(0, Number.isFinite(db) ? db : -96));
  return `${clamped >= 0 ? '+' : ''}${clamped.toFixed(1)} dB`;
}

export function VolumeMeter({ db, width = 40, label = 'Volume' }: VolumeMeterProps) {
  // Python: level = max(0.0, min(1.0, (db + 96.0) / 96.0))
  const level = Math.max(0, Math.min(1, ((Number.isFinite(db) ? db : -96) + 96) / 96));
  const filled = Math.floor(level * width);
  const empty = width - filled;

  return (
    <div className="meter">
      <span className="label">{label}:</span>
      <span className="meter-bar" role="meter" aria-valuemin={-96} aria-valuemax={0} aria-valuenow={db}>
        {Array.from({ length: filled }, (_, index) => {
          const fraction = index / width; // Python uses i / METER_WIDTH
          const tone = fraction < 0.5 ? 'low' : fraction < 0.8 ? 'mid' : 'high';
          return (
            <span key={`f${index}`} className={`block ${tone}`}>
              █
            </span>
          );
        })}
        {Array.from({ length: empty }, (_, index) => (
          <span key={`e${index}`} className="block empty">
            ░
          </span>
        ))}
      </span>
      <span className="dim">{formatDb(db)}</span>
    </div>
  );
}
