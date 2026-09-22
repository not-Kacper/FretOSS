/**
 * NoteDisplay.tsx — port of TerminalDisplay.draw()'s "detected note" block.
 *
 * Python rendered the confirmed note BIG with a ✅/❌ icon and appended
 * `{frequency:.1f} Hz   conf {confidence:.0%}`; when no note was stable it
 * showed `Listening...  play a note`. Same information, same states.
 */

import type { SessionNote } from '../hooks/useSrsSession';

export interface NoteDisplayProps {
  /** The note currently on screen (null = waiting for a stable pitch). */
  note: SessionNote | null;
}

/** Python: `f"{confidence:.0%}"`. */
export function formatConfidence(confidence: number): string {
  return `${Math.round((Number.isFinite(confidence) ? confidence : 0) * 100)}%`;
}

export function NoteDisplay({ note }: NoteDisplayProps) {
  if (!note) {
    return (
      <div className="note-display waiting" data-state="waiting">
        <span className="dim italic">Listening&hellip;  play a note</span>
      </div>
    );
  }

  const state = note.isMatch ? 'match' : 'miss';
  return (
    <div className="note-display" data-state={state}>
      <span className="icon">{note.isMatch ? '✅' : '❌'}</span>
      <span className={`note-name ${state}`}>{note.noteName}</span>
      <span className="dim mono">
        {note.frequency.toFixed(1)} Hz&nbsp;&nbsp;&nbsp;conf {formatConfidence(note.confidence)}
      </span>
    </div>
  );
}
