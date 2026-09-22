/**
 * audio/engine.ts — port of main.py's `AudioEngine` device/stream lifecycle.
 *
 *   AudioEngine.list_input_devices -> listInputDevices()
 *   AudioEngine.select_device      -> rememberDeviceId()/selectDevice
 *   AudioEngine.open               -> startAudioEngine()
 *   AudioEngine.close              -> handle.close()
 *
 * Differences from the PyAudio version are limited to what the platform forces:
 *
 *   - The "input device" is a MediaDevice, remembered in localStorage (the
 *     browser's equivalent of app_state.json's `audio_device` block).
 *   - Constraint flags mirror a raw instrument input exactly like the Python
 *     app does: echoCancellation / noiseSuppression / autoGainControl all off.
 *   - `getUserMedia`/`AudioContext` must be created from a user gesture, and
 *     the worklet needs an *audible-silent* path to the destination: Web Audio
 *     only pulls nodes that reach the destination, so an AudioWorkletNode that
 *     is never connected would not run at all. It is therefore routed through a
 *     `GainNode` with `gain = 0` — nothing is ever played back (the processor
 *     only analyses), but the graph is pulled.
 */

import type { ConfigManager } from '../config/config';

/** Served as-is from /public/worklets/ (never bundled — see vite.config.ts). */
export const WORKLET_URL = `${import.meta.env.BASE_URL}worklets/pitch-processor.js`;

/** localStorage key mirroring app_state.json's `audio_device`. */
const DEVICE_STATE_KEY = 'srs-fretboard.audio_device';

export interface InputDevice {
  deviceId: string;
  label: string;
  groupId: string;
  isDefault: boolean;
}

export interface RememberedDevice {
  device_id: string;
  name: string;
  group_id: string;
  saved_at: string;
}

export interface EngineHandle {
  /** The analysis node; feed it to src/audio/pitch-detector.ts. */
  node: AudioWorkletNode;
  context: AudioContext;
  stream: MediaStream;
  /** Actual hardware rate — the worklet's YIN uses this, not config.sample_rate. */
  sampleRate: number;
  /** Human-readable name of the open input (shown in the header). */
  deviceLabel: string;
  /** Ready/rejected data from the processor (useful for diagnostics). */
  processorParams: { bufferSize: number; tolerance: number; sampleRate: number } | null;
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
//  Device selection
// ---------------------------------------------------------------------------

function readSavedDevice(): RememberedDevice | null {
  try {
    const raw = localStorage.getItem(DEVICE_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedDevice;
    return typeof parsed?.device_id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** main.py: `remember_audio_device(path, device)`. */
export function rememberDevice(device: { deviceId: string; label: string; groupId: string }): void {
  const state: RememberedDevice = {
    device_id: device.deviceId,
    name: device.label,
    group_id: device.groupId,
    saved_at: new Date().toISOString(),
  };
  try {
    localStorage.setItem(DEVICE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Private mode / storage disabled — device memory is a convenience only.
  }
}

export function savedDeviceId(): string | null {
  return readSavedDevice()?.device_id ?? null;
}

/** The remembered device block (main.py: the `audio_device` entry of app_state.json). */
export function savedDevice(): RememberedDevice | null {
  return readSavedDevice();
}

/**
 * main.py: `AudioEngine.list_input_devices()`.
 *
 * Labels are only populated after a permission grant, so the UI should call
 * this again once listening has started (the hook does).
 */
export async function listInputDevices(): Promise<InputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  const saved = readSavedDevice();
  const inputs = devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label || 'Input device',
      groupId: device.groupId,
      isDefault: device.deviceId === 'default' || device.deviceId === saved?.device_id,
    }));

  // Put the remembered device first, mirroring the Python picker's "remembered
  // device is reused automatically" behaviour.
  if (saved) {
    inputs.sort((a, b) => Number(b.deviceId === saved.device_id) - Number(a.deviceId === saved.device_id));
  }
  return inputs;
}

/** main.py: `find_remembered_device(devices, state)`. */
export function findRememberedDevice(
  devices: InputDevice[],
  saved: RememberedDevice | null,
): InputDevice | null {
  if (!saved) return null;
  const exact = devices.find(
    (device) => device.deviceId === saved.device_id && device.label === saved.name,
  );
  if (exact) return exact;
  const byId = devices.find((device) => device.deviceId === saved.device_id);
  if (byId) return byId;
  return devices.find((device) => device.label === saved.name) ?? null;
}

// ---------------------------------------------------------------------------
//  Lifecycle
// ---------------------------------------------------------------------------

export interface StartEngineOptions {
  config: ConfigManager;
  /** `deviceId` of the input to open; null/undefined = system default. */
  deviceId?: string | null;
  /** Overrides `config.pitch_detection.silence_threshold…` for the worklet gate. */
  extraProcessorOptions?: Record<string, unknown>;
}

/**
 * main.py: `AudioEngine.open()` — microphone -> AudioWorkletNode, with no
 * playback processing enabled on the input.
 */
export async function startAudioEngine(options: StartEngineOptions): Promise<EngineHandle> {
  const { config } = options;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not expose getUserMedia (microphone) support.');
  }

  // Same intent as PyAudio opening a single raw input channel: no processing.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const context = new AudioContext({ latencyHint: 'interactive' });
  if (context.state === 'suspended') await context.resume();

  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw new Error(
      `Could not load the AudioWorklet from ${WORKLET_URL}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const node = new AudioWorkletNode(context, 'pitch-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      bufferSize: config.bufferSize,
      tolerance: config.pitchTolerance,
      algorithm: config.algorithm,
      ...options.extraProcessorOptions,
    },
  });

  const source = context.createMediaStreamSource(stream);
  source.connect(node);

  // Silent sink: keeps the graph pulled without ever producing sound.
  const silentSink = context.createGain();
  silentSink.gain.value = 0;
  node.connect(silentSink);
  silentSink.connect(context.destination);

  const track = stream.getAudioTracks()[0];
  const deviceLabel = track?.label || 'default input';

  const handle: EngineHandle = {
    node,
    context,
    stream,
    sampleRate: context.sampleRate,
    deviceLabel,
    processorParams: null,
    close: async () => {
      try {
        node.port.postMessage('stop');
      } catch {
        // Port may already be closed.
      }
      try {
        source.disconnect();
        node.disconnect();
        silentSink.disconnect();
      } catch {
        // Nodes may already be torn down.
      }
      stream.getTracks().forEach((t) => t.stop());
      if (context.state !== 'closed') await context.close();
    },
  };

  // The processor announces the parameters it actually runs with.
  node.port.onmessage = (event) => {
    const data = event.data as { type?: string; bufferSize?: number; tolerance?: number; sampleRate?: number };
    if (data?.type === 'ready') {
      handle.processorParams = {
        bufferSize: Number(data.bufferSize),
        tolerance: Number(data.tolerance),
        sampleRate: Number(data.sampleRate),
      };
    }
  };

  return handle;
}

/** main.py: the `finally: engine.close()` teardown. */
export async function stopAudioEngine(handle: EngineHandle | null): Promise<void> {
  if (!handle) return;
  await handle.close();
}
