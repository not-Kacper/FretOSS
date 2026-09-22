/**
 * Settings modal — instrument/tuning, fret range, per-string selection,
 * theme, input gain, export/import. One view, no router.
 */

import { useMemo, useRef, useState } from 'react';

import { midiToName } from '../audio/note-helpers';
import { INSTRUMENTS, getInstrument, stringNumbersFor } from '../deck/instruments';
import {
  getTuning,
  makeCustomTuning,
  stringLabelsFor,
  stringNumbersOf,
  tuningsForInstrument,
  type TuningDef,
} from '../deck/tuning';
import {
  applyImport,
  buildBackup,
  downloadBackup,
  inspectImport,
  parseBackupFile,
} from '../storage/backup';
import { getOrCreateUserId, setUserId } from '../storage/identity';
import type { UserSettings } from '../storage/settings';

export interface SettingsPanelProps {
  open: boolean;
  settings: UserSettings;
  onChange: (next: UserSettings) => void;
  onClose: () => void;
  onImported: () => void;
}

const MIDI_MIN = 16;
const MIDI_MAX = 88;
const MIDI_OPTIONS = Array.from({ length: MIDI_MAX - MIDI_MIN + 1 }, (_, i) => MIDI_MIN + i);

type ImportStep =
  | null
  | { kind: 'token'; backup: ReturnType<typeof parseBackupFile>; conflicts: number }
  | { kind: 'conflicts'; backup: ReturnType<typeof parseBackupFile> }
  | { kind: 'error'; message: string }
  | { kind: 'done'; message: string };

export function SettingsPanel({ open, settings, onChange, onClose, onImported }: SettingsPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importStep, setImportStep] = useState<ImportStep>(null);
  const [busy, setBusy] = useState(false);
  const [customDraft, setCustomDraft] = useState<Record<number, number> | null>(null);

  const instrument = getInstrument(settings.instrumentId);
  const tuning = getTuning(settings.tuningId, settings.customTunings);
  const presets = tuningsForInstrument(settings.instrumentId, settings.customTunings);
  const strings = stringNumbersOf(tuning);
  const labels = stringLabelsFor(tuning);
  const active = new Set(settings.activeStringsByDeck[tuning.id] ?? strings);
  const usingCustom = customDraft !== null || !presets.some((entry) => entry.id === settings.tuningId && !entry.id.startsWith('custom-'));

  const pickerMidi = useMemo(() => {
    if (customDraft) return customDraft;
    return { ...tuning.openStringMidi };
  }, [customDraft, tuning]);

  if (!open) return null;

  const patch = (partial: Partial<UserSettings>) => onChange({ ...settings, ...partial });

  const selectInstrument = (instrumentId: string) => {
    const nextInstrument = getInstrument(instrumentId);
    const available = tuningsForInstrument(instrumentId, settings.customTunings);
    const nextTuning = available[0] ?? getTuning('guitar6-standard');
    setCustomDraft(null);
    patch({ instrumentId: nextInstrument.id, tuningId: nextTuning.id });
  };

  const selectTuning = (tuningId: string) => {
    if (tuningId === '__custom__') {
      const seed = { ...getTuning(settings.tuningId, settings.customTunings).openStringMidi };
      // Ensure exactly instrument.stringCount pickers.
      const next: Record<number, number> = {};
      for (const n of stringNumbersFor(instrument)) {
        next[n] = seed[n] ?? 40 + (instrument.stringCount - n) * 5;
      }
      setCustomDraft(next);
      const custom = makeCustomTuning(instrument.id, next);
      const extras = upsertCustom(settings.customTunings, custom);
      patch({ tuningId: custom.id, customTunings: extras });
      return;
    }
    setCustomDraft(null);
    patch({ tuningId });
  };

  const updateCustomString = (stringNumber: number, midi: number) => {
    const next = { ...(customDraft ?? pickerMidi), [stringNumber]: midi };
    setCustomDraft(next);
    const custom = makeCustomTuning(instrument.id, next);
    const extras = upsertCustom(settings.customTunings, custom);
    patch({ tuningId: custom.id, customTunings: extras });
  };

  const toggleString = (stringNumber: number) => {
    const current = settings.activeStringsByDeck[tuning.id] ?? strings;
    const set = new Set(current);
    if (set.has(stringNumber)) {
      if (set.size === 1) return; // keep at least one string
      set.delete(stringNumber);
    } else {
      set.add(stringNumber);
    }
    patch({
      activeStringsByDeck: {
        ...settings.activeStringsByDeck,
        [tuning.id]: strings.filter((n) => set.has(n)),
      },
    });
  };

  const exportProgress = async () => {
    setBusy(true);
    try {
      const backup = await buildBackup();
      downloadBackup(backup);
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        setImportStep({ kind: 'error', message: 'File is not valid JSON.' });
        return;
      }
      const plan = await inspectImport(raw);
      if (plan.tokenDiffers) {
        setImportStep({ kind: 'token', backup: plan.backup, conflicts: plan.conflicts });
      } else if (plan.conflicts > 0) {
        setImportStep({ kind: 'conflicts', backup: plan.backup });
      } else {
        await applyImport(plan.backup, 'overwrite');
        setImportStep({ kind: 'done', message: 'Progress imported.' });
        onImported();
      }
    } catch (error) {
      setImportStep({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const finishImport = async (backup: ReturnType<typeof parseBackupFile>, strategy: 'keep-local' | 'overwrite') => {
    setBusy(true);
    try {
      await applyImport(backup, strategy);
      setImportStep({ kind: 'done', message: 'Progress imported.' });
      onImported();
    } catch (error) {
      setImportStep({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const adoptTokenThen = async (
    backup: ReturnType<typeof parseBackupFile>,
    adopt: boolean,
    conflicts: number,
  ) => {
    if (adopt && backup.user_token) setUserId(backup.user_token);
    if (conflicts > 0) {
      setImportStep({ kind: 'conflicts', backup });
      return;
    }
    await finishImport(backup, 'overwrite');
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <section className="settings-section">
          <h3>Appearance</h3>
          <label className="settings-row">
            <span>Theme</span>
            <select
              value={settings.theme}
              onChange={(event) => patch({ theme: event.target.value as UserSettings['theme'] })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </section>

        <section className="settings-section">
          <h3>Instrument &amp; tuning</h3>
          <label className="settings-row">
            <span>Instrument</span>
            <select value={settings.instrumentId} onChange={(event) => selectInstrument(event.target.value)}>
              {INSTRUMENTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-row">
            <span>Tuning</span>
            <select
              value={customDraft ? '__custom__' : settings.tuningId}
              onChange={(event) => selectTuning(event.target.value)}
            >
              {presets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                  {entry.id.startsWith('custom-') ? ' (custom)' : ''}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
          </label>
          {(customDraft || usingCustom && settings.tuningId.startsWith('custom-')) && (
            <div className="custom-tuners">
              <p className="dim small">
                {instrument.stringCount} strings — pick each open note. Instrument is fixed first so the
                picker count always matches.
              </p>
              {stringNumbersFor(instrument).map((stringNumber) => (
                <label key={stringNumber} className="settings-row">
                  <span>
                    String {stringNumber}
                    {labels[stringNumber] ? ` (${labels[stringNumber]})` : ''}
                  </span>
                  <select
                    value={pickerMidi[stringNumber] ?? 40}
                    onChange={(event) => updateCustomString(stringNumber, Number(event.target.value))}
                  >
                    {MIDI_OPTIONS.map((midi) => (
                      <option key={midi} value={midi}>
                        {midiToName(midi)} ({midi})
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
        </section>

        <section className="settings-section">
          <h3>Fret range</h3>
          <label className="settings-row">
            <span>
              Frets {instrument.fretRangeDefault[0]}–{instrument.fretRangeDefault[1]} (default)
            </span>
            <input
              type="radio"
              name="fret-range"
              checked={settings.fretRangeMode === 'default'}
              onChange={() => patch({ fretRangeMode: 'default' })}
            />
          </label>
          <label className="settings-row">
            <span>
              Extend to {instrument.fretRangeMax[1]} (saved progress on extra frets is kept either way)
            </span>
            <input
              type="radio"
              name="fret-range"
              checked={settings.fretRangeMode === 'max'}
              onChange={() => patch({ fretRangeMode: 'max' })}
            />
          </label>
        </section>

        <section className="settings-section">
          <h3>Active strings</h3>
          <p className="dim small">Stored per tuning. Inactive strings dim on the board and leave the queue.</p>
          <div className="string-toggles">
            {strings.map((stringNumber) => (
              <label key={stringNumber} className="chip">
                <input
                  type="checkbox"
                  checked={active.has(stringNumber)}
                  onChange={() => toggleString(stringNumber)}
                />
                {stringNumber} {labels[stringNumber] ?? ''}
              </label>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Input gain</h3>
          <label className="settings-row">
            <span>{settings.inputGain.toFixed(1)}× (before pitch detection)</span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={settings.inputGain}
              onChange={(event) => patch({ inputGain: Number(event.target.value) })}
            />
          </label>
        </section>

        <section className="settings-section">
          <h3>Backup</h3>
          <p className="dim small">
            JSON file of every deck plus your anonymous sync token. No cloud login in this version —
            drop the file in Drive/Dropbox yourself if you want.
          </p>
          <div className="settings-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void exportProgress()}>
              Export Progress
            </button>
            <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
              Import Progress
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => void onPickFile(event.target.files?.[0])}
            />
          </div>
          <p className="dim small">This browser&apos;s token: {shortToken(getOrCreateUserId())}</p>
        </section>

        {importStep ? (
          <div className="import-dialog">
            {importStep.kind === 'token' ? (
              <>
                <p>
                  This backup belongs to a different anonymous identity. Adopt that token to reclaim
                  its cloud sync row, or keep this browser&apos;s token and import progress data only.
                </p>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void adoptTokenThen(importStep.backup, true, importStep.conflicts)}
                  >
                    Adopt imported identity
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void adoptTokenThen(importStep.backup, false, importStep.conflicts)}
                  >
                    Keep current identity
                  </button>
                </div>
              </>
            ) : null}
            {importStep.kind === 'conflicts' ? (
              <>
                <p>
                  Some cards exist in both this browser and the backup. Overwrite local progress, or
                  keep local cards and only fill in missing ones?
                </p>
                <div className="settings-actions">
                  <button type="button" disabled={busy} onClick={() => void finishImport(importStep.backup, 'keep-local')}>
                    Keep all local
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void finishImport(importStep.backup, 'overwrite')}
                  >
                    Overwrite all
                  </button>
                </div>
              </>
            ) : null}
            {importStep.kind === 'error' ? <p className="error">{importStep.message}</p> : null}
            {importStep.kind === 'done' ? <p className="ok">{importStep.message}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function upsertCustom(list: TuningDef[], custom: TuningDef): TuningDef[] {
  const withoutSameInstrumentDrafts = list.filter(
    (entry) => !(entry.instrumentId === custom.instrumentId && entry.id.startsWith('custom-')),
  );
  return [...withoutSameInstrumentDrafts, custom];
}

function shortToken(token: string): string {
  if (token.length < 12) return token;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}
