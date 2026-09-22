/**
 * hooks/useAudio.ts — React wrapper around engine.ts + pitch-detector.ts.
 *
 * Returns the live readouts the TerminalDisplay used to receive from the main
 * loop (`detected_name`, `db_level`) plus the controls the browser needs that
 * PyAudio did not: a user-gesture `start()`, a device picker and permission
 * error reporting.
 *
 * Latency path (acceptance criterion): the AudioWorklet posts one message per
 * analysis frame (`buffer_size` samples on the audio thread -> YIN -> gates on
 * the main thread), so a confirmed note reaches React within one frame
 * (~93 ms at 4096 @ 44.1 kHz, ~46 ms at 2048) with no network involved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  listInputDevices,
  rememberDevice,
  savedDevice,
  savedDeviceId,
  startAudioEngine,
  type EngineHandle,
  type InputDevice,
} from '../audio/engine';
import { attachPitchDetector, type PitchDetector } from '../audio/pitch-detector';
import type { ConfigManager } from '../config/config';
import type { NoteEvent } from '../deck/types';

export interface UseAudioOptions {
  config: ConfigManager | null;
  /**
   * Called for every confirmed note (the `PitchProcessor.process()` return
   * value), i.e. the session's scoring input.
   */
  onNoteEvent?: (event: NoteEvent) => void;
  /** Linear gain 0–3 applied before pitch detection. Default 1. */
  inputGain?: number;
}

export interface UseAudioResult {
  /** Last confirmed note, or null once a frame fails the gates (Python: "Listening..."). */
  detectedNote: NoteEvent | null;
  /** Input level in dBFS, updated every analysis frame. */
  dbLevel: number;
  isListening: boolean;
  error: string | null;
  devices: InputDevice[];
  deviceId: string | null;
  deviceLabel: string | null;
  sampleRate: number | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  selectDevice: (deviceId: string | null) => void;
  /** main.py: `processor.reset()` — called between prompts and after mistakes. */
  resetStreak: () => void;
}

export function useAudio({ config, onNoteEvent, inputGain = 1 }: UseAudioOptions): UseAudioResult {
  const [detectedNote, setDetectedNote] = useState<NoteEvent | null>(null);
  const [dbLevel, setDbLevel] = useState(-96);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<InputDevice[]>(() => {
    const saved = savedDevice();
    return saved ? [{ deviceId: saved.device_id, label: saved.name, groupId: saved.group_id, isDefault: true }] : [];
  });
  const [deviceId, setDeviceId] = useState<string | null>(() => savedDeviceId());
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [sampleRate, setSampleRate] = useState<number | null>(null);

  const handleRef = useRef<EngineHandle | null>(null);
  const detectorRef = useRef<PitchDetector | null>(null);
  const noteHandlerRef = useRef(onNoteEvent);
  const configRef = useRef(config);
  const deviceIdRef = useRef(deviceId);
  const listeningRef = useRef(false);
  const gainRef = useRef(inputGain);

  configRef.current = config;
  noteHandlerRef.current = onNoteEvent;
  gainRef.current = inputGain;

  const setListening = useCallback((value: boolean) => {
    listeningRef.current = value;
    setIsListening(value);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listInputDevices());
    } catch {
      // enumerateDevices can reject before a permission grant — keep the last list.
    }
  }, []);

  const stop = useCallback(async () => {
    detectorRef.current?.cleanup();
    detectorRef.current = null;
    const handle = handleRef.current;
    handleRef.current = null;
    if (handle) await handle.close();
    setListening(false);
    setDetectedNote(null);
    setDbLevel(-96);
  }, [setListening]);

  const start = useCallback(async () => {
    const currentConfig = configRef.current;
    if (!currentConfig || handleRef.current) return;

    setError(null);
    try {
      const handle = await startAudioEngine({
        config: currentConfig,
        deviceId: deviceIdRef.current,
      });

      const detector = attachPitchDetector(
        handle.node,
        {
          silenceThresholdHz: currentConfig.silenceThresholdHz,
          confidenceThreshold: currentConfig.confidenceThreshold,
          stabilityFrames: currentConfig.stabilityFrames,
        },
        {
          onFrame: (frame, note) => {
            setDbLevel(frame.db);
            // Python's loop: `if event is None: display.draw(db_level=...)`.
            setDetectedNote(note);
            if (note) noteHandlerRef.current?.(note);
          },
        },
      );

      handleRef.current = handle;
      detectorRef.current = detector;
      setDeviceLabel(handle.deviceLabel);
      setSampleRate(handle.sampleRate);
      setListening(true);

      // Device labels are only revealed after a permission grant; remember the
      // one we actually opened (main.py: `remember_audio_device`).
      const opened = (await listInputDevices()).find(
        (device) => device.label === handle.deviceLabel,
      );
      if (opened) {
        rememberDevice(opened);
        deviceIdRef.current = opened.deviceId;
        setDeviceId(opened.deviceId);
      }
      await refreshDevices();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        /Permission|NotAllowed/i.test(message)
          ? 'Microphone permission was denied — allow it in the browser and press Start again.'
          : message,
      );
      setListening(false);
    }
  }, [refreshDevices, setListening]);

  const selectDevice = useCallback((nextDeviceId: string | null) => {
    deviceIdRef.current = nextDeviceId;
    setDeviceId(nextDeviceId);
  }, []);

  const resetStreak = useCallback(() => {
    detectorRef.current?.resetStreak();
  }, []);

  // main.py asks for the device *before* opening the stream; here a change
  // restarts the engine so the picker behaves the same way.
  useEffect(() => {
    if (!listeningRef.current) return;
    let cancelled = false;
    void (async () => {
      await stop();
      if (!cancelled) await start();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  useEffect(() => {
    handleRef.current?.setInputGain(inputGain);
  }, [inputGain]);

  useEffect(() => {
    void refreshDevices();
    return () => {
      // main.py's `finally: engine.close()`.
      detectorRef.current?.cleanup();
      detectorRef.current = null;
      void handleRef.current?.close();
      handleRef.current = null;
    };
  }, [refreshDevices]);

  return {
    detectedNote,
    dbLevel,
    isListening,
    error,
    devices,
    deviceId,
    deviceLabel,
    sampleRate,
    start,
    stop,
    selectDevice,
    resetStreak,
  };
}
