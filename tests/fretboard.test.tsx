import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Fretboard, resolveDotVariant } from '../src/components/Fretboard';
import { buildTargets } from '../src/deck/deck';
import { getTuning } from '../src/deck/tuning';

describe('Fretboard SVG', () => {
  it('lays out 4 strings for ukulele and 6 for guitar', () => {
    const ukeTuning = getTuning('ukulele4-standard');
    const ukeTargets = buildTargets(ukeTuning, { minFret: 0, maxFret: 12 });
    const uke = renderToStaticMarkup(
      <Fretboard
        stringCount={4}
        maxFret={12}
        activeStrings={[4, 3, 2, 1]}
        targets={ukeTargets}
        currentTarget={ukeTargets[0]}
        dotKinds={{ [ukeTargets[0].key]: 'new' }}
        feedback="idle"
      />,
    );
    expect(uke).toContain('<svg');
    expect(uke).toContain('4-string fretboard');
    expect(uke.match(/fb-string /g)?.length).toBe(4);

    const guitar = buildTargets(getTuning('guitar6-standard'), { minFret: 0, maxFret: 12 });
    const html = renderToStaticMarkup(
      <Fretboard
        stringCount={6}
        maxFret={12}
        activeStrings={[6, 5, 4, 3, 2, 1]}
        targets={guitar}
        currentTarget={null}
        dotKinds={{}}
      />,
    );
    expect(html.match(/fb-string /g)?.length).toBe(6);
  });

  it('omits dots on inactive strings; count matches the filtered target list', () => {
    const targets = buildTargets(getTuning('guitar6-standard'), { minFret: 0, maxFret: 2 });
    const active = [1];
    const filtered = targets.filter((target) => active.includes(target.stringNumber));
    const html = renderToStaticMarkup(
      <Fretboard
        stringCount={6}
        maxFret={2}
        activeStrings={active}
        targets={filtered}
        currentTarget={null}
        dotKinds={{}}
      />,
    );
    expect(html).toContain('is-inactive');
    expect(html).toContain('is-active');
    const dots = html.match(/note-dot/g) ?? [];
    expect(dots.length).toBe(filtered.length);
    expect(dots.length).toBe(3);
  });

  it('hides note names by default and labels every dot when the toggle is on', () => {
    const targets = buildTargets(getTuning('guitar6-standard'), { minFret: 0, maxFret: 0, strings: [6] });
    const unlabeled = renderToStaticMarkup(
      <Fretboard
        stringCount={6}
        maxFret={0}
        activeStrings={[6]}
        targets={targets}
        currentTarget={targets[0]}
        dotKinds={{ [targets[0].key]: 'new' }}
      />,
    );
    expect(unlabeled).not.toContain('note-dot-label');
    expect(unlabeled).not.toContain(`>${targets[0].pitchClass}<`);

    const labeled = renderToStaticMarkup(
      <Fretboard
        stringCount={6}
        maxFret={0}
        activeStrings={[6]}
        targets={targets}
        currentTarget={targets[0]}
        dotKinds={{ [targets[0].key]: 'new' }}
        showNoteNames
      />,
    );
    expect(labeled).toContain('note-dot-label');
    expect(labeled).toContain(targets[0].pitchClass);
  });

  it('applies wrong/correct overlay only to the current target, never by MIDI match', () => {
    const all = buildTargets(getTuning('guitar6-standard'), { minFret: 7, maxFret: 7, strings: [4, 5] });
    const d7 = all.find((target) => target.stringNumber === 4)!; // A3
    const a7 = all.find((target) => target.stringNumber === 5)!; // E3 — same fret, different string
    expect(d7.pitchClass).not.toBe(a7.pitchClass);

    const html = renderToStaticMarkup(
      <Fretboard
        stringCount={6}
        maxFret={12}
        activeStrings={[4, 5]}
        targets={[d7, a7]}
        currentTarget={d7}
        dotKinds={{ [d7.key]: 'review-due', [a7.key]: 'learning' }}
        feedback="wrong"
      />,
    );

    expect(html).toContain(`data-target-key="${d7.key}"`);
    expect(html).toContain(`data-target-key="${a7.key}"`);
    const d7Tag = html.match(new RegExp(`<div[^>]*data-target-key="${d7.key}"[^>]*>`))?.[0] ?? '';
    const a7Tag = html.match(new RegExp(`<div[^>]*data-target-key="${a7.key}"[^>]*>`))?.[0] ?? '';
    expect(d7Tag).toContain('data-variant="wrong"');
    expect(a7Tag).not.toContain('data-variant="wrong"');
    expect(html).not.toContain('breathing-ring');
  });

  it('resolveDotVariant never uses detected MIDI — only FSRS state + current target', () => {
    expect(resolveDotVariant('learning', false, 'wrong')).toBe('learning');
    expect(resolveDotVariant('learning', true, 'wrong')).toBe('wrong');
    expect(resolveDotVariant('review-due', true, 'correct')).toBe('correct');
    expect(resolveDotVariant('new', true, 'idle')).toBe('target');
    expect(resolveDotVariant('review-future', false, 'correct')).toBe('future');
  });
});
