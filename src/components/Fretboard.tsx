/**
 * SVG fretboard — string count is a prop, never hardcoded.
 *
 * Dots are coloured by live FSRS card state (CSS custom properties + glow).
 * The current target adds a pulsing blue ring; correct/wrong flashes are CSS
 * transitions, never instant style swaps.
 */

import type { FretboardTarget } from '../deck/types';
import type { DotKind } from '../storage/progress-idb';
import type { TargetFeedback } from '../hooks/useSrsSession';

export interface FretboardProps {
  stringCount: number;
  minFret?: number;
  maxFret: number;
  activeStrings: readonly number[];
  targets: FretboardTarget[];
  currentTarget: FretboardTarget | null;
  dotKinds: Record<string, DotKind>;
  feedback?: TargetFeedback;
}

const FRET_W = 52;
const STRING_GAP = 30;
const PAD_LEFT = 54;
const PAD_RIGHT = 18;
const PAD_TOP = 28;
const PAD_BOTTOM = 28;
const DOT_R = 8;
const MARKERS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);
const DOUBLE_MARKERS = new Set([12, 24]);

function stringY(stringNumber: number): number {
  // String 1 (highest / thinnest) at the top — tab convention, works for 4–7.
  return PAD_TOP + (stringNumber - 1) * STRING_GAP;
}

function fretMidX(fret: number): number {
  if (fret <= 0) return PAD_LEFT - 22;
  return PAD_LEFT + (fret - 0.5) * FRET_W;
}

export function Fretboard({
  stringCount,
  minFret = 0,
  maxFret,
  activeStrings,
  targets,
  currentTarget,
  dotKinds,
  feedback = 'idle',
}: FretboardProps) {
  const width = PAD_LEFT + maxFret * FRET_W + PAD_RIGHT;
  const height = PAD_TOP + Math.max(0, stringCount - 1) * STRING_GAP + PAD_BOTTOM;
  const active = new Set(activeStrings);
  const byPos = new Map(targets.map((target) => [`${target.stringNumber}:${target.fret}`, target]));

  const strings: number[] = [];
  for (let n = 1; n <= stringCount; n++) strings.push(n);

  return (
    <div className="fretboard-wrap">
      <svg
        className="fretboard"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={`${stringCount}-string fretboard, frets ${minFret} to ${maxFret}`}
      >
        <rect className="fb-board" x={PAD_LEFT} y={PAD_TOP - 10} width={maxFret * FRET_W} height={(stringCount - 1) * STRING_GAP + 20} rx="2" />

        {/* Nut */}
        <rect className="fb-nut" x={PAD_LEFT - 4} y={PAD_TOP - 10} width="5" height={(stringCount - 1) * STRING_GAP + 20} />

        {/* Fret wires + numbers + inlays */}
        {Array.from({ length: maxFret + 1 }, (_, fret) => {
          const x = PAD_LEFT + fret * FRET_W;
          return (
            <g key={`fret-${fret}`}>
              {fret > 0 ? <line className="fb-fret" x1={x} y1={PAD_TOP - 10} x2={x} y2={PAD_TOP + (stringCount - 1) * STRING_GAP + 10} /> : null}
              {fret >= 1 && fret <= maxFret ? (
                <text className="fb-fret-num" x={fretMidX(fret)} y={height - 8} textAnchor="middle">
                  {fret}
                </text>
              ) : null}
              {fret >= 1 && MARKERS.has(fret) ? (
                DOUBLE_MARKERS.has(fret) ? (
                  <>
                    <circle className="fb-inlay" cx={fretMidX(fret)} cy={PAD_TOP + STRING_GAP * 0.7} r="3.5" />
                    <circle className="fb-inlay" cx={fretMidX(fret)} cy={PAD_TOP + (stringCount - 1.7) * STRING_GAP} r="3.5" />
                  </>
                ) : (
                  <circle className="fb-inlay" cx={fretMidX(fret)} cy={PAD_TOP + ((stringCount - 1) * STRING_GAP) / 2} r="3.5" />
                )
              ) : null}
            </g>
          );
        })}

        {/* Open-string (fret 0) label */}
        <text className="fb-fret-num" x={fretMidX(0)} y={height - 8} textAnchor="middle">
          0
        </text>

        {/* Strings */}
        {strings.map((stringNumber) => {
          const y = stringY(stringNumber);
          const isActive = active.has(stringNumber);
          const thickness = 1 + (stringCount - stringNumber) * 0.35;
          return (
            <g key={`string-${stringNumber}`}>
              <text className="fb-string-label" x={PAD_LEFT - 14} y={y + 4} textAnchor="end">
                {stringNumber}
              </text>
              <line
                className={`fb-string ${isActive ? 'is-active' : 'is-inactive'}`}
                x1={PAD_LEFT - 4}
                y1={y}
                x2={PAD_LEFT + maxFret * FRET_W}
                y2={y}
                strokeWidth={thickness}
              />
            </g>
          );
        })}

        {/* Note dots — selected strings in range only */}
        {strings.flatMap((stringNumber) => {
          if (!active.has(stringNumber)) return [];
          const y = stringY(stringNumber);
          const dots = [];
          for (let fret = minFret; fret <= maxFret; fret++) {
            const target = byPos.get(`${stringNumber}:${fret}`);
            if (!target) continue;
            const kind = dotKinds[target.key] ?? 'new';
            const isCurrent = currentTarget?.key === target.key;
            const flash = isCurrent ? feedback : 'idle';
            dots.push(
              <g
                key={target.key}
                className={[
                  'note-dot',
                  `state-${kind}`,
                  isCurrent ? 'is-current' : '',
                  flash === 'correct' ? 'flash-correct' : '',
                  flash === 'wrong' ? 'flash-wrong' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                transform={`translate(${fretMidX(fret)}, ${y})`}
              >
                {isCurrent ? <circle className="breathing-ring" r={DOT_R + 6} /> : null}
                <circle className="note-dot-core" r={DOT_R} />
                <text className="note-dot-label" y="3.5" textAnchor="middle">
                  {target.pitchClass}
                </text>
              </g>,
            );
          }
          return dots;
        })}
      </svg>
    </div>
  );
}
