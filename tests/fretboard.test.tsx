import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Fretboard } from '../src/components/Fretboard';
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

  it('dims inactive strings and omits their dots from the practice set', () => {
    const targets = buildTargets(getTuning('guitar6-standard'), { minFret: 0, maxFret: 2 });
    const html = renderToStaticMarkup(
      <Fretboard
        stringCount={6}
        maxFret={2}
        activeStrings={[1]}
        targets={targets}
        currentTarget={null}
        dotKinds={{}}
      />,
    );
    expect(html).toContain('is-inactive');
    expect(html).toContain('is-active');
    const dots = html.match(/note-dot /g) ?? [];
    // Only string 1 across frets 0–2.
    expect(dots.length).toBe(3);
  });

  it('uses CSS classes for FSRS colours and the breathing current target (no inline hex)', () => {
    const targets = buildTargets(getTuning('guitar6-standard'), { minFret: 0, maxFret: 0, strings: [6] });
    const html = renderToStaticMarkup(
      <Fretboard
        stringCount={6}
        maxFret={0}
        activeStrings={[6]}
        targets={targets}
        currentTarget={targets[0]}
        dotKinds={{ [targets[0].key]: 'learning' }}
        feedback="correct"
      />,
    );
    expect(html).toContain('state-learning');
    expect(html).toContain('is-current');
    expect(html).toContain('flash-correct');
    expect(html).toContain('breathing-ring');
    expect(html).not.toContain('#4d94ff');
    expect(html).not.toContain('#ff6b6b');
  });
});
