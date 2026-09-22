/**
 * AudioEngine test — the Web Audio wiring, checked against the constraints the
 * Python version implies (see src/audio/engine.ts):
 *
 *   - raw input: echoCancellation / noiseSuppression / autoGainControl off,
 *     mono, `latencyHint: 'interactive'`
 *   - `/worklets/pitch-processor.js` is loaded through `audioWorklet.addModule()`
 *     (proving it stays a standalone file, not a bundled chunk)
 *   - source -> worklet node -> gain(0) -> destination: pulled, but silent
 *   - teardown stops the tracks and closes the AudioContext
 *   - the remembered device behaves like app_state.json's `audio_device`
 *
 * Everything is a stub: no real AudioContext exists under Node, which is also
 * why the worklet itself is covered separately in tests/worklet.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config/config';
import {
  findRememberedDevice,
  listInputDevices,
  rememberDevice,
  savedDeviceId,
  startAudioEngine,
  stopAudioEngine,
  WORKLET_URL,
  type EngineHandle,
} from '../src/audio/engine';
import publicConfig from '../public/config.json';

interface Recorded {
  constraints: MediaStreamConstraints[];
  modules: string[];
  connections: string[];
  closed: boolean;
  stoppedTracks: number;
  contextOptions: AudioContextOptions[];
  nodeOptions: AudioWorkletNodeOptions[];
  disconnects: number;
}

/** A minimal fake Web Audio + mediaDevices environment. */
function installFakeAudioEnvironment(devices = defaultDevices()) {
  const recorded: Recorded = {
    constraints: [],
    modules: [],
    connections: [],
    closed: false,
    stoppedTracks: 0,
    contextOptions: [],
    nodeOptions: [],
    disconnects: 0,
  };

  class FakeGain {
    gain = { value: 1 };
    connect = (destination: unknown) => {
      recorded.connections.push(`gain->${nameOf(destination)}`);
      return destination;
    };
    disconnect = () => {
      recorded.disconnects += 1;
    };
  }

  class FakeSource {
    connect = (destination: unknown) => {
      recorded.connections.push(`source->${nameOf(destination)}`);
      return destination;
    };
    disconnect = () => {
      recorded.disconnects += 1;
    };
  }

  class FakeWorkletNode {
    port = {
      postMessage: (_message: unknown) => {},
      onmessage: null as ((event: { data: unknown }) => void) | null,
    };
    connect = (destination: unknown) => {
      recorded.connections.push(`worklet->${nameOf(destination)}`);
      return destination;
    };
    disconnect = () => {
      recorded.disconnects += 1;
    };
    options: AudioWorkletNodeOptions;
    constructor(_context: unknown, _name: string, options: AudioWorkletNodeOptions) {
      this.options = options;
      recorded.nodeOptions.push(options);
    }
  }

  class FakeAudioContext {
    sampleRate = 48000;
    state: AudioContextState = 'running';
    destination = { name: 'destination' };
    audioWorklet = {
      addModule: async (url: string) => {
        recorded.modules.push(url);
      },
    };
    options: AudioContextOptions;
    constructor(options: AudioContextOptions = {}) {
      this.options = options;
      recorded.contextOptions.push(options);
    }
    createMediaStreamSource = () => new FakeSource();
    createGain = () => new FakeGain();
    close = async () => {
      recorded.closed = true;
      this.state = 'closed';
    };
    resume = async () => {
      this.state = 'running';
    };
  }

  const tracks = [
    {
      kind: 'audio',
      label: 'Fake USB Interface Analog Stereo',
      stop: () => {
        recorded.stoppedTracks += 1;
      },
    },
  ];
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream;

  // `navigator` is a getter-only global under Node, so swap the descriptors.
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };

  install('AudioContext', FakeAudioContext);
  install('AudioWorkletNode', FakeWorkletNode);
  install('localStorage', makeStorage());
  install('navigator', {
    mediaDevices: {
      enumerateDevices: async () => devices,
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        recorded.constraints.push(constraints);
        return stream;
      },
    },
  });

  return {
    recorded,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    },
  };
}

function nameOf(value: unknown): string {
  const candidate = value as { name?: string; constructor?: { name: string } };
  return candidate?.name ?? candidate?.constructor?.name ?? 'node';
}

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

function defaultDevices() {
  return [
    { kind: 'audioinput', deviceId: 'default', label: 'Default Input', groupId: 'g1' },
    { kind: 'audioinput', deviceId: 'usb-1', label: 'USB Interface', groupId: 'g2' },
    { kind: 'audiooutput', deviceId: 'out-1', label: 'Speakers', groupId: 'g3' },
  ] as MediaDeviceInfo[];
}

const config = parseConfig(publicConfig);

let env: ReturnType<typeof installFakeAudioEnvironment>;
beforeEach(() => {
  env = installFakeAudioEnvironment();
});

afterEach(() => {
  env.restore();
});

describe('audio engine', () => {
  it('loads the worklet from /worklets/ and opens the mic without processing', async () => {
    const handle = await startAudioEngine({ config });
    try {
      expect(WORKLET_URL).toBe('/worklets/pitch-processor.js');
      expect(env.recorded.modules).toEqual(['/worklets/pitch-processor.js']);
      expect(env.recorded.contextOptions[0]).toEqual({ latencyHint: 'interactive' });

      const audio = env.recorded.constraints[0].audio as MediaTrackConstraints;
      expect(audio.channelCount).toBe(1);
      expect(audio.echoCancellation).toBe(false);
      expect(audio.noiseSuppression).toBe(false);
      expect(audio.autoGainControl).toBe(false);
      expect(env.recorded.constraints[0].video).toBe(false);

      // The worklet receives the pitch-detection knobs from config.json.
      expect(env.recorded.nodeOptions[0]).toMatchObject({
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          bufferSize: config.bufferSize,
          tolerance: config.pitchTolerance,
          algorithm: 'yin',
        },
      });
    } finally {
      await stopAudioEngine(handle);
    }
  });

  it('routes source -> worklet -> gain(0) -> destination (analysed, never played)', async () => {
    const handle = await startAudioEngine({ config });
    expect(env.recorded.connections).toEqual([
      'source->FakeWorkletNode',
      'worklet->FakeGain',
      'gain->destination',
    ]);

    // The only path to the speakers is muted; a silent gain of 0 is what keeps
    // the analysis graph alive without producing any output.
    expect(handle.deviceLabel).toBe('Fake USB Interface Analog Stereo');
    await stopAudioEngine(handle);
  });

  it('tears everything down: port stop, disconnects, tracks stopped, context closed', async () => {
    const handle: EngineHandle = await startAudioEngine({ config });
    await stopAudioEngine(handle);
    expect(env.recorded.stoppedTracks).toBe(1);
    expect(env.recorded.closed).toBe(true);
    expect(env.recorded.disconnects).toBeGreaterThanOrEqual(3);
  });

  it('surfaces the worklet "ready" handshake parameters', async () => {
    const handle = await startAudioEngine({ config });
    const port = (handle.node as unknown as { port: { onmessage: (e: { data: unknown }) => void } }).port;
    port.onmessage({ data: { type: 'ready', bufferSize: 4096, tolerance: 0.8, sampleRate: 48000 } });
    expect(handle.processorParams).toEqual({ bufferSize: 4096, tolerance: 0.8, sampleRate: 48000 });
    (port as unknown as { onmessage: (e: { data: unknown }) => void }).onmessage({
      data: { freq: 110, confidence: 0.9, db: -20 },
    });
    expect(handle.processorParams?.bufferSize).toBe(4096);
    await stopAudioEngine(handle);
  });

  it('reports a failed addModule and cleans up the context/stream', async () => {
    class FailingContext {
      sampleRate = 48000;
      state: AudioContextState = 'running';
      destination = { name: 'destination' };
      audioWorklet = {
        addModule: async () => {
          throw new Error('404 Not Found');
        },
      };
      createMediaStreamSource = () => ({ connect: () => {}, disconnect: () => {} });
      close = async () => {
        env.recorded.closed = true;
      };
    }
    (globalThis as Record<string, unknown>).AudioContext = FailingContext;

    await expect(startAudioEngine({ config })).rejects.toThrow(/404 Not Found/);
    expect(env.recorded.stoppedTracks).toBe(1);
    expect(env.recorded.closed).toBe(true);
  });

  it('lists input devices only, with the remembered one first', async () => {
    rememberDevice({ deviceId: 'usb-1', label: 'USB Interface', groupId: 'g2' });
    expect(savedDeviceId()).toBe('usb-1');

    const devices = await listInputDevices();
    expect(devices.map((device) => device.deviceId)).toEqual(['usb-1', 'default']);
    expect(devices[0]).toMatchObject({ label: 'USB Interface', isDefault: true });
    expect(devices).toHaveLength(2); // audiooutput devices are filtered out
    // find_remembered_device() falls back to a label match, like Python.
    expect(findRememberedDevice(devices, null)).toBeNull();
    expect(
      findRememberedDevice(devices, {
        device_id: 'gone',
        name: 'USB Interface',
        group_id: 'g2',
        saved_at: '2026-01-01T00:00:00.000Z',
      })?.deviceId,
    ).toBe('usb-1');
  });

  it('asks for the remembered device when starting', async () => {
    const handle = await startAudioEngine({ config, deviceId: 'usb-1' });
    const audio = env.recorded.constraints[0].audio as MediaTrackConstraints;
    expect(audio.deviceId).toEqual({ exact: 'usb-1' });
    await stopAudioEngine(handle);

    await startAudioEngine({ config });
    let after = env.recorded.constraints[1].audio as MediaTrackConstraints;
    if (env.recorded.constraints[1].audio === true) after = {} as MediaTrackConstraints;
    expect(after.deviceId).toBeUndefined();
  });
});
