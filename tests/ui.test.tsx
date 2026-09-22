/**
 * UI test — renders the components (and the whole App) to static markup and
 * checks that every piece of information `TerminalDisplay.draw()` showed is
 * still on screen: device line, target note + string, points / correct / wrong
 * + queue counts, the 40-block dB meter, the big detected note with Hz and
 * confidence, and the three status lines.
 *
 * `react-dom/server` is used instead of a DOM: it exercises the real render
 * path (props, branches, formatting) without a browser, and the interactive
 * parts (mic, hooks) are covered by the other test files.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import App from '../src/App';
import { NoteDisplay, formatConfidence } from '../src/components/NoteDisplay';

import { QueueStats, formatPoints } from '../src/components/QueueStats';
import { StatusBar } from '../src/components/StatusBar';
import { TargetPrompt } from '../src/components/TargetPrompt';
import { VolumeMeter, formatDb } from '../src/components/VolumeMeter';
import { buildTargets } from '../src/deck/deck';
import { promptLabel } from '../src/deck/types';
import type { SessionNote } from '../src/hooks/useSrsSession';
import type { FretboardTarget } from '../src/deck/types';
import publicConfig from '../public/config.json';

const targets = buildTargets(publicConfig.deck);
const target = targets.find((entry) => entry.key === 's5_f02') as FretboardTarget; // B2 on the A string

const targetLabel = promptLabel(target);

const matchNote: SessionNote = {
  midiNote: target.midiNote,
  noteName: target.noteName,
  frequency: 110.04,
  confidence: 0.913,
  isMatch: true,
  detectedAt: 0,
};

const missNote: SessionNote = { ...matchNote, midiNote: 62, noteName: 'D4', frequency: 293.66, isMatch: false };

describe('TerminalDisplay parity', () => {
  it('target line: "Target:  {note}  {string} string"', () => {
    const html = renderToStaticMarkup(<TargetPrompt target={target} />);
    expect(html).toContain('Target:');
    expect(html).toContain('B2');
    expect(html).toContain('A string');
    expect(html).toContain(targetLabel); // prompt_label, also used by the status line
    // The web version may add detail, but never less than Python showed.
    expect(html).toContain('fret 2');
  });

  it('progress line: points, correct/wrong and queue counts', () => {
    const html = renderToStaticMarkup(
      <QueueStats
        stats={{ points: 3, attempts: 9, correct: 2, wrong: 1 }}
        queue={{ learningDue: 4, reviewDue: 1, newAvailable: 3, newTotal: 71, future: 2, available: 8 }}
        completedCards={2}
      />,
    );
    expect(html).toContain('Progress:');
    expect(html).toContain('points');
    expect(html).toContain('+3');
    expect(html).toContain('2 correct / 1 wrong');
    expect(html).toContain('queue: learn 4, review 1, new 3/71');
    expect(formatPoints(-1)).toBe('-1');
    expect(formatPoints(0)).toBe('+0');
  });

  it('volume meter: 40 blocks, -96 dB -> 0 -> full, same gradient thresholds', () => {
    const quiet = renderToStaticMarkup(<VolumeMeter db={-96} />);
    expect(quiet.match(/block empty/g)).toHaveLength(40);
    expect(quiet).not.toContain('block low');

    const half = renderToStaticMarkup(<VolumeMeter db={-48} />);
    expect(half.match(/block low/g)).toHaveLength(20);
    expect(half.match(/block mid/g)).toBeNull();
    expect(half).toContain('-48.0 dB');

    const loud = renderToStaticMarkup(<VolumeMeter db={-5} />);
    expect(loud.match(/block low/g)).toHaveLength(20); // < 50% of the *bar width*
    expect(loud.match(/block mid/g)).toHaveLength(12);
    expect(loud.match(/block high/g)).toHaveLength(5);
    expect(loud).toContain('-5.0 dB');

    // Python: `f"{db_level:+5.1f} dB"`
    expect(formatDb(-3.14)).toBe('-3.1 dB');
    expect(formatDb(0)).toBe('+0.0 dB');
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBe('-96.0 dB');
  });

  it('detected note: big note + ✅/❌ + Hz + confidence, or "Listening..."', () => {
    const waiting = renderToStaticMarkup(<NoteDisplay note={null} />);
    expect(waiting).toContain('Listening');
    expect(waiting).toContain('play a note');

    const good = renderToStaticMarkup(<NoteDisplay note={matchNote} />);
    expect(good).toContain('✅');
    expect(good).toContain('B2');
    expect(good).toContain('110.0 Hz');
    expect(good).toContain('conf 91%');

    const bad = renderToStaticMarkup(<NoteDisplay note={missNote} />);
    expect(bad).toContain('❌');
    expect(bad).toContain('D4');
    expect(bad).toContain('293.7 Hz');
    expect(formatConfidence(0.8)).toBe('80%');
    expect(formatConfidence(Number.NaN)).toBe('0%');
  });

  it('status line: waiting / wrong / validated / session complete', () => {
    const base = {
      sessionEnded: false,
      target,
      completedCards: 0,
      nextDue: null,
      hasNewCards: true,
      initialNewCards: 3,
      newCardIntervalSec: 45,
      loading: false,
      error: null,
    };

    expect(renderToStaticMarkup(<StatusBar {...base} detected={null} />)).toContain(
      `Waiting for ${targetLabel}`,
    );
    expect(renderToStaticMarkup(<StatusBar {...base} detected={missNote} />)).toContain(
      `Expected ${targetLabel}`,
    );
    expect(renderToStaticMarkup(<StatusBar {...base} detected={matchNote} />)).toContain(
      'Note validated!',
    );
    expect(renderToStaticMarkup(<StatusBar {...base} detected={matchNote} />)).toContain(
      'Saving progress and picking the next prompt.',
    );
    expect(renderToStaticMarkup(<StatusBar {...base} detected={null} loading />)).toContain(
      'Loading progress',
    );
    expect(
      renderToStaticMarkup(<StatusBar {...base} detected={null} error="mic denied" />),
    ).toContain('mic denied');

    const ended = renderToStaticMarkup(
      <StatusBar
        {...base}
        sessionEnded
        detected={null}
        completedCards={4}
        nextDue={{
          target,
          card: {
            card_id: 5002,
            state: 2,
            step: null,
            stability: 3.2,
            difficulty: 5.1,
            // Snapped to the whole second so `formatWait` is deterministic.
            due: new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000).toISOString(),
            last_review: new Date().toISOString(),
          },
        }}
      />,
    );
    expect(ended).toContain('Session complete: 4 due card(s) reviewed.');
    expect(ended).toContain('Next due:');
    expect(ended).toContain(targetLabel);
    // Python's `_format_wait(next_card.due - _utc_now())`; the clock advances a
    // little between building the props and rendering, hence the tolerance.
    expect(ended).toMatch(/\((1h 0m|59m \d+s)\)/);
  });

  it('renders the single App view without a browser (config still loading)', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('SRS Fretboard Learner');
    expect(html).toContain('Device:');
    expect(html).toContain('Start listening');
    expect(html).toContain('Input:');
    expect(html).toContain('System default');
    expect(html).toContain('Target:');
    expect(html).toContain('Progress:');
    expect(html).toContain('Volume:');
    expect(html).toContain('Listening');
    // One screen, no router: nothing that would need a second view.
    expect(html).not.toContain('<nav');
  });
});
