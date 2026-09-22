/**
 * App.tsx — the single view, wiring the hooks together.
 *
 * This is the port of `TerminalDisplay.draw()` (header / target / progress /
 * volume meter / detected note / status) and of `main()`'s control flow
 * (start listening, score notes, stop). There is exactly one screen and no
 * router — the terminal UI had one screen too.
 *
 * Display rule for the big note readout (mirrors the Python loop):
 *   - while the success pause is running, the validated note is held on screen
 *     (Python blocked on `time.sleep(success_pause_sec)` with the success screen
 *     still drawn);
 *   - otherwise the latest confirmed note is shown, and it disappears as soon as
 *     a frame fails the three gates (`detected_note = None` -> "Listening...").
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';

import { midiToName } from './audio/note-helpers';
import { DevicePicker } from './components/DevicePicker';
import { NoteDisplay } from './components/NoteDisplay';
import { QueueStats } from './components/QueueStats';
import { StatusBar } from './components/StatusBar';
import { TargetPrompt } from './components/TargetPrompt';
import { VolumeMeter } from './components/VolumeMeter';
import { useAudio } from './hooks/useAudio';
import { useConfig } from './hooks/useConfig';
import { useSrsSession, type SessionNote } from './hooks/useSrsSession';
import { createProgressSync } from './storage/sync';

export function App() {
  const { config, error: configError, loading: configLoading } = useConfig();

  const sync = useMemo(() => createProgressSync({}), []);
  // useSrsSession needs `resetStreak()` from useAudio, while useAudio needs the
  // session's `handleNoteEvent` — the indirection below breaks that cycle with a
  // stable callback that always reads the current implementation.
  const resetStreakRef = useRef<() => void>(() => {});
  const resetStreak = useCallback(() => resetStreakRef.current(), []);

  const session = useSrsSession({ config, sync, resetStreak });

  const audio = useAudio({
    config,
    onNoteEvent: session.handleNoteEvent,
  });
  resetStreakRef.current = audio.resetStreak;

  const liveNote: SessionNote | null = audio.detectedNote
    ? {
        midiNote: audio.detectedNote.midiNote,
        noteName: midiToName(audio.detectedNote.midiNote),
        frequency: audio.detectedNote.frequency,
        confidence: audio.detectedNote.confidence,
        isMatch: session.target?.midiNote === audio.detectedNote.midiNote,
        detectedAt: performance.now(),
      }
    : null;

  // Python drew the success screen and then slept; hold that screen until the
  // next prompt is picked.
  const displayedNote = session.frozen
    ? session.heldMatch
    : liveNote ?? (session.status === 'ended' ? session.heldMatch : null);

  const error = configError?.message ?? audio.error ?? session.error ?? null;
  const loading = configLoading || session.status === 'loading';

  const toggleListening = useCallback(() => {
    if (audio.isListening) void audio.stop();
    else void audio.start();
  }, [audio]);

  const sampleInfo = audio.sampleRate
    ? `${config?.bufferSize ?? '?'} samples @ ${Math.round(audio.sampleRate)} Hz ≈ ${Math.round(
        ((config?.bufferSize ?? 0) / audio.sampleRate) * 1000,
      )} ms/frame`
    : config
      ? `${config.bufferSize} samples per analysis frame`
      : '';

  return (
    <main className="app">
      <header className="app-header">
        <h1>
          <span aria-hidden="true">🎸</span> SRS Fretboard Learner
        </h1>
        <div className="rule" />
        <div className="header-row">
          <span className="label">Device:</span>{' '}
          <span className="device-name">
            {audio.isListening ? (audio.deviceLabel ?? 'input') : 'not listening'}
          </span>
          {sampleInfo ? <span className="dim small">{sampleInfo}</span> : null}
        </div>
        <div className="header-row controls">
          <button type="button" className={audio.isListening ? 'danger' : 'primary'} onClick={toggleListening} disabled={!config}>
            {audio.isListening ? '■ Stop listening' : '▶ Start listening'}
          </button>
          <DevicePicker
            devices={audio.devices}
            value={audio.deviceId}
            onChange={audio.selectDevice}
            activeLabel={audio.isListening ? audio.deviceLabel : null}
          />
          <SyncIndicator sync={sync} />
        </div>
      </header>

      <TargetPrompt target={session.target} />
      <QueueStats stats={session.stats} queue={session.queue} completedCards={session.completedCards} />

      <VolumeMeter db={audio.dbLevel} />

      <div className="rule" />
      <NoteDisplay note={displayedNote} />
      <div className="rule" />

      <StatusBar
        sessionEnded={session.status === 'ended'}
        target={session.target}
        detected={displayedNote}
        completedCards={session.completedCards}
        nextDue={session.nextDue}
        hasNewCards={session.hasNewCards}
        initialNewCards={config?.initialNewCards ?? 3}
        newCardIntervalSec={config?.newCardIntervalSec ?? 45}
        loading={loading}
        error={error}
      />

      <footer className="footer dim small">
        <span>
          {config
            ? `YIN · buffer ${config.bufferSize} · conf ≥ ${config.confidenceThreshold} · `
              + `silence < ${config.silenceThresholdHz} Hz · ${config.stabilityFrames} stable frames`
            : 'loading configuration…'}
        </span>
        <span>
          {session.deck.length} fretboard targets
          {audio.isListening ? '' : ' · press Start to enable the microphone'}
        </span>
      </footer>
    </main>
  );
}

function SyncIndicator({ sync }: { sync: ReturnType<typeof createProgressSync> }) {
  const state = useSyncExternalStore(sync.subscribe, sync.getState, sync.getState);
  if (state.status === 'offline') {
    return <span className="dim small">sync: offline (local only)</span>;
  }
  if (state.status === 'error') {
    return <span className="dim small">sync: error</span>;
  }
  if (state.status === 'syncing') {
    return <span className="dim small">sync: saving…</span>;
  }
  if (state.status === 'synced') {
    return <span className="dim small">sync: synced</span>;
  }
  return <span className="dim small">sync: idle</span>;
}

export default App;
