/**
 * App.tsx — the single view, wiring the hooks together.
 *
 * Phase 2 adds the SVG fretboard (visual centrepiece), a settings modal, and
 * a theme toggle. Still one screen and no router.
 */

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { midiToName } from './audio/note-helpers';
import { DevicePicker } from './components/DevicePicker';
import { Fretboard } from './components/Fretboard';
import { NoteDisplay } from './components/NoteDisplay';
import { QueueStats } from './components/QueueStats';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { TargetPrompt } from './components/TargetPrompt';
import { VolumeMeter } from './components/VolumeMeter';
import { buildTargets, filterTargetsByFretRange, filterTargetsByStrings } from './deck/deck';
import { getInstrument } from './deck/instruments';
import { useAudio } from './hooks/useAudio';
import { useConfig } from './hooks/useConfig';
import { useSettings } from './hooks/useSettings';
import { useSrsSession, type SessionNote } from './hooks/useSrsSession';
import { createProgressSync } from './storage/sync';
import {
  activeStringsFor,
  fretWindowFor,
  maxFretFor,
  resolveTuning,
} from './storage/settings';

export function App() {
  const { config, error: configError, loading: configLoading } = useConfig();
  const { settings, update: updateSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const instrument = getInstrument(settings.instrumentId);
  const tuning = resolveTuning(settings);
  const deckId = tuning.id;
  const { minFret, maxFret } = fretWindowFor(settings);
  const generationMax = maxFretFor(settings);
  const activeStrings = activeStringsFor(settings, tuning);

  const allTargets = useMemo(
    () =>
      buildTargets(tuning, {
        minFret: 0,
        maxFret: generationMax,
        notesToLearn: config?.deckConfig.notes_to_learn ?? config?.deckConfig.notes,
      }),
    [tuning, generationMax, config],
  );
  const viewTargets = useMemo(
    () => filterTargetsByFretRange(allTargets, minFret, maxFret),
    [allTargets, minFret, maxFret],
  );
  const queueTargets = useMemo(
    () => filterTargetsByStrings(viewTargets, activeStrings),
    [viewTargets, activeStrings],
  );

  const sync = useMemo(() => createProgressSync({ deckId }), [deckId]);

  const resetStreakRef = useRef<() => void>(() => {});
  const resetStreak = useCallback(() => resetStreakRef.current(), []);

  const session = useSrsSession({
    config,
    sync,
    resetStreak,
    deckId,
    queueTargets,
    viewTargets,
    reloadToken,
  });

  const audio = useAudio({
    config,
    onNoteEvent: session.handleNoteEvent,
    inputGain: settings.inputGain,
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

  const displayedNote = session.frozen
    ? session.heldMatch
    : liveNote ?? (session.status === 'ended' ? session.heldMatch : null);

  const error = configError?.message ?? audio.error ?? session.error ?? null;
  const loading = configLoading || session.status === 'loading';

  const toggleListening = useCallback(() => {
    if (audio.isListening) void audio.stop();
    else void audio.start();
  }, [audio]);

  const toggleTheme = useCallback(() => {
    updateSettings((current) => ({ ...current, theme: current.theme === 'dark' ? 'light' : 'dark' }));
  }, [updateSettings]);

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
        <div className="title-row">
          <h1>
            <span aria-hidden="true">🎸</span> SRS Fretboard Learner
          </h1>
          <div className="header-actions">
            <button type="button" onClick={toggleTheme} aria-label="Toggle theme">
              {settings.theme === 'dark' ? '☀ Light' : '☾ Dark'}
            </button>
            <button type="button" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </div>
        </div>
        <div className="rule" />
        <div className="header-row">
          <span className="label">Device:</span>{' '}
          <span className="device-name">
            {audio.isListening ? (audio.deviceLabel ?? 'input') : 'not listening'}
          </span>
          {sampleInfo ? <span className="dim small">{sampleInfo}</span> : null}
        </div>
        <div className="header-row dim small">
          <span>
            {instrument.label} · {tuning.label} · frets {minFret}–{maxFret}
          </span>
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

      <Fretboard
        stringCount={instrument.stringCount}
        minFret={minFret}
        maxFret={maxFret}
        activeStrings={activeStrings}
        targets={viewTargets}
        currentTarget={session.target}
        dotKinds={session.dotKinds}
        feedback={session.targetFeedback}
      />

      <TargetPrompt target={session.target} />
      {session.revealed && session.target ? (
        <div className="reveal-box" role="status">
          The note is <strong>{session.target.noteName}</strong>
          <span className="dim"> — play it to continue (this review counts as Again)</span>
        </div>
      ) : null}
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

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
        onImported={() => setReloadToken((n) => n + 1)}
      />
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
