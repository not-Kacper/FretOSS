/**
 * SVG fretboard + Framer Motion dots.
 *
 * Dots are unlabeled by default. Color/glow comes from Framer Motion variants:
 * each cell's own FSRS state, plus a target/correct/wrong overlay ONLY on the
 * current target. Wrong-note MIDI is never mapped onto other cells — a
 * monophonic detector cannot know which string was played.
 */

import { motion, type Variants } from 'framer-motion';

import type { FretboardTarget } from '../deck/types';
import type { DotKind } from '../storage/progress-idb';
import type { TargetFeedback } from '../hooks/useSrsSession';

export type DotVariant = 'new' | 'learning' | 'review' | 'future' | 'target' | 'correct' | 'wrong';

export interface FretboardProps {
  stringCount: number;
  minFret?: number;
  maxFret: number;
  activeStrings: readonly number[];
  /** Already filtered to the active deck + fret range + selected strings. */
  targets: FretboardTarget[];
  currentTarget: FretboardTarget | null;
  dotKinds: Record<string, DotKind>;
  feedback?: TargetFeedback;
  /** Beginner/debug: paint pitch-class text on every dot. Default off. */
  showNoteNames?: boolean;
}

const FRET_W = 52;
const STRING_GAP = 30;
const PAD_LEFT = 54;
const PAD_RIGHT = 18;
const PAD_TOP = 28;
const PAD_BOTTOM = 28;
const DOT_PX = 16;
const MARKERS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);
const DOUBLE_MARKERS = new Set([12, 24]);

function stringY(stringNumber: number): number {
  return PAD_TOP + (stringNumber - 1) * STRING_GAP;
}

function fretMidX(fret: number): number {
  if (fret <= 0) return PAD_LEFT - 22;
  return PAD_LEFT + (fret - 0.5) * FRET_W;
}

/**
 * Variant is FSRS state, unless this cell IS the current target — in which
 * case feedback (idle → breathing, correct, wrong) wins. Never derived from
 * detected MIDI / pitch class of other cells.
 */
export function resolveDotVariant(
  kind: DotKind,
  isCurrent: boolean,
  feedback: TargetFeedback,
): DotVariant {
  if (isCurrent) {
    if (feedback === 'correct') return 'correct';
    if (feedback === 'wrong') return 'wrong';
    return 'target';
  }
  if (kind === 'new') return 'new';
  if (kind === 'learning') return 'learning';
  if (kind === 'review-due') return 'review';
  return 'future';
}

const dotVariants: Variants = {
  new: {
    backgroundColor: '#4d94ff',
    boxShadow: '0 0 6px 1px rgba(77,148,255,0.35)',
    scale: 1,
  },
  learning: {
    backgroundColor: '#ff6b6b',
    boxShadow: '0 0 6px 1px rgba(255,107,107,0.35)',
    scale: 1,
  },
  review: {
    backgroundColor: '#5ec26a',
    boxShadow: '0 0 6px 1px rgba(94,194,106,0.3)',
    scale: 1,
  },
  future: {
    backgroundColor: '#3a3a3a',
    boxShadow: 'none',
    scale: 1,
  },
  target: {
    backgroundColor: '#388eff',
    boxShadow: [
      '0 0 8px 2px rgba(56,142,255,0.4)',
      '0 0 18px 6px rgba(56,142,255,0.9)',
      '0 0 8px 2px rgba(56,142,255,0.4)',
    ],
    scale: [1, 1.08, 1],
    transition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
  },
  correct: {
    backgroundColor: '#5ec26a',
    boxShadow: '0 0 16px 5px rgba(94,194,106,0.8)',
    scale: 1.15,
    transition: { duration: 0.35, ease: 'easeOut' },
  },
  wrong: {
    backgroundColor: '#ff4d4d',
    boxShadow: '0 0 16px 5px rgba(255,77,77,0.8)',
    scale: 1,
    transition: { duration: 0.25, ease: 'easeOut' },
  },
};

export function Fretboard({
  stringCount,
  minFret = 0,
  maxFret,
  activeStrings,
  targets,
  currentTarget,
  dotKinds,
  feedback = 'idle',
  showNoteNames = false,
}: FretboardProps) {
  const width = PAD_LEFT + maxFret * FRET_W + PAD_RIGHT;
  const height = PAD_TOP + Math.max(0, stringCount - 1) * STRING_GAP + PAD_BOTTOM;
  const active = new Set(activeStrings);

  const strings: number[] = [];
  for (let n = 1; n <= stringCount; n++) strings.push(n);

  const visibleTargets = targets.filter(
    (target) =>
      active.has(target.stringNumber) && target.fret >= minFret && target.fret <= maxFret,
  );

  return (
    <div className="fretboard-wrap">
      <div className="fretboard-stage">
        <svg
          className="fretboard"
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="img"
          aria-label={`${stringCount}-string fretboard, frets ${minFret} to ${maxFret}`}
        >
          <rect
            className="fb-board"
            x={PAD_LEFT}
            y={PAD_TOP - 10}
            width={maxFret * FRET_W}
            height={(stringCount - 1) * STRING_GAP + 20}
            rx="2"
          />
          <rect className="fb-nut" x={PAD_LEFT - 4} y={PAD_TOP - 10} width="5" height={(stringCount - 1) * STRING_GAP + 20} />

          {Array.from({ length: maxFret + 1 }, (_, fret) => {
            const x = PAD_LEFT + fret * FRET_W;
            return (
              <g key={`fret-${fret}`}>
                {fret > 0 ? (
                  <line
                    className="fb-fret"
                    x1={x}
                    y1={PAD_TOP - 10}
                    x2={x}
                    y2={PAD_TOP + (stringCount - 1) * STRING_GAP + 10}
                  />
                ) : null}
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

          <text className="fb-fret-num" x={fretMidX(0)} y={height - 8} textAnchor="middle">
            0
          </text>

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
        </svg>

        <div className="fretboard-dots" aria-hidden={showNoteNames ? undefined : true}>
          {visibleTargets.map((target) => {
            const isCurrent = currentTarget?.key === target.key;
            const variant = resolveDotVariant(dotKinds[target.key] ?? 'new', isCurrent, feedback);
            const x = fretMidX(target.fret);
            const y = stringY(target.stringNumber);
            return (
              <motion.div
                key={target.key}
                className="note-dot"
                data-variant={variant}
                data-target-key={target.key}
                data-current={isCurrent ? 'true' : 'false'}
                variants={dotVariants}
                animate={variant}
                initial={false}
                transition={{ duration: 0.35, ease: 'easeInOut' }}
                style={{
                  left: `${(x / width) * 100}%`,
                  top: `${(y / height) * 100}%`,
                  width: DOT_PX,
                  height: DOT_PX,
                  marginLeft: -DOT_PX / 2,
                  marginTop: -DOT_PX / 2,
                  borderRadius: '50%',
                }}
              >
                {showNoteNames ? <span className="note-dot-label">{target.pitchClass}</span> : null}
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
