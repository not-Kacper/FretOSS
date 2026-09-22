/**
 * QueueStats.tsx — port of TerminalDisplay.draw()'s "Progress" line.
 *
 * Python:
 *   Progress:  points {:+d}  {correct} correct / {wrong} wrong
 *              queue: learn {learning_due}, review {review_due},
 *                     new {new_available}/{new_total}
 *
 * The per-card counters come from `ProgressStore.stats_for(target)` and the
 * queue numbers from `ProgressStore.queue_stats(...)`, exactly as in Python.
 */

import type { CardStats, QueueStats as QueueStatsValue } from '../srs/types';

export interface QueueStatsProps {
  /** Per-card counters for the current target (Python: `stats_for(target)`). */
  stats: CardStats;
  /** Session queue counts (Python: `queue_stats(...)`). */
  queue: QueueStatsValue | null;
  /** Cards completed in this session (Python: `completed_cards`). */
  completedCards: number;
}

/** Python: `f"{points:+d}"`. */
export function formatPoints(points: number): string {
  return `${points >= 0 ? '+' : ''}${Math.trunc(points)}`;
}

export function QueueStats({ stats, queue, completedCards }: QueueStatsProps) {
  return (
    <div className="queue-stats">
      <span className="label">Progress:</span>{' '}
      <span className="mono">
        points <strong>{formatPoints(stats.points)}</strong>&nbsp;&nbsp;
        {stats.correct} correct / {stats.wrong} wrong&nbsp;&nbsp;
        <span className="dim">
          queue: learn {queue?.learningDue ?? 0}, review {queue?.reviewDue ?? 0}, new{' '}
          {queue?.newAvailable ?? 0}/{queue?.newTotal ?? 0}
          {queue && queue.future > 0 ? `, later ${queue.future}` : ''}
        </span>
      </span>
      <span className="dim small session-count">
        session: {completedCards} done &middot; {stats.attempts} attempts on this card
      </span>
    </div>
  );
}
