/**
 * TargetPrompt.tsx — port of TerminalDisplay.draw()'s "Target" line.
 *
 * Python: `Target:  {note_name}  {string_label} string` (note in bold yellow).
 * The web version adds the fret number and MIDI note, which the terminal UI
 * implied via the string+note pair.
 */

import { promptLabel, type FretboardTarget } from '../deck/types';

export interface TargetPromptProps {
  target: FretboardTarget | null;
}

export function TargetPrompt({ target }: TargetPromptProps) {
  if (!target) {
    return (
      <div className="target">
        <span className="label">Target:</span> <span className="dim">no card ready</span>
      </div>
    );
  }

  return (
    <div className="target">
      <span className="label">Target:</span>{' '}
      <span className="target-note" title={promptLabel(target)}>
        {target.noteName}
      </span>{' '}
      <span className="target-string">{target.stringLabel} string</span>{' '}
      <span className="dim small">
        fret {target.fret} &middot; string {target.stringNumber} &middot; MIDI {target.midiNote}
      </span>
    </div>
  );
}
