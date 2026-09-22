/**
 * StatusBar.tsx — port of TerminalDisplay.draw()'s status line plus main()'s
 * end-of-session messages.
 *
 * Python statuses:
 *   is_match True  -> "🎉  Note validated!  Saving progress and picking the next prompt."
 *   is_match False -> "⏳  Expected {prompt_label} — keep trying!"
 *   else           -> "Waiting for {prompt_label}..."
 *
 * End of session (main() after the loop):
 *   "✓ Session complete: N due card(s) reviewed."
 *   "Next due: {prompt_label} at {datetime} ({wait})."
 *   "No cards are ready right now." / adaptive new-card unlock note.
 */

import { formatLocalDateTime, formatWait } from '../audio/note-helpers';
import { promptLabel, type FretboardTarget } from '../deck/types';
import type { SessionNote } from '../hooks/useSrsSession';
import type { CardDict } from '../srs/types';

export interface StatusBarProps {
  sessionEnded: boolean;
  target: FretboardTarget | null;
  /** The note currently displayed (drives the same branches Python used). */
  detected: SessionNote | null;
  completedCards: number;
  nextDue: { target: FretboardTarget; card: CardDict } | null;
  hasNewCards: boolean;
  initialNewCards: number;
  newCardIntervalSec: number;
  loading: boolean;
  error: string | null;
}

export function StatusBar({
  sessionEnded,
  target,
  detected,
  completedCards,
  nextDue,
  hasNewCards,
  initialNewCards,
  newCardIntervalSec,
  loading,
  error,
}: StatusBarProps) {
  if (error) {
    return <div className="status error">⚠️  {error}</div>;
  }
  if (loading) {
    return <div className="status">Loading progress&hellip;</div>;
  }

  if (sessionEnded) {
    return (
      <div className="status">
        <div className="ok">
          ✓ Session complete: {completedCards} due card(s) reviewed.
        </div>
        {nextDue ? (
          <div className="dim">
            Next due: <span className="warn">{promptLabel(nextDue.target)}</span> at{' '}
            {formatLocalDateTime(new Date(nextDue.card.due))} (
            {formatWait(new Date(nextDue.card.due).getTime() - Date.now())}).
          </div>
        ) : hasNewCards ? (
          <div className="dim">
            New cards unlock adaptively while you practice: {initialNewCards} now, then one more
            every {formatWait(newCardIntervalSec * 1000)}.
          </div>
        ) : (
          <div className="dim">No cards are ready right now.</div>
        )}
      </div>
    );
  }

  if (detected?.isMatch) {
    return (
      <div className="status ok">🎉  Note validated!  Saving progress and picking the next prompt.</div>
    );
  }

  if (detected) {
    return (
      <div className="status warn">
        ⏳  Expected {target ? promptLabel(target) : 'the prompt'} — keep trying!
      </div>
    );
  }

  return (
    <div className="status dim">
      Waiting for {target ? promptLabel(target) : 'a card'}&hellip;
    </div>
  );
}
