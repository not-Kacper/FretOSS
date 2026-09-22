/**
 * DevicePicker.tsx — the `choose_audio_device()` port.
 *
 * Python presented a numbered terminal list with the remembered device reused
 * automatically and `hw` devices flagged; here that becomes a dropdown. The
 * remembered device is pre-selected on load and re-used on the next visit (the
 * browser's equivalent of app_state.json's `audio_device`).
 */

import type { InputDevice } from '../audio/engine';

export interface DevicePickerProps {
  devices: InputDevice[];
  value: string | null;
  onChange: (deviceId: string | null) => void;
  disabled?: boolean;
  /** Name of the currently open input, shown once listening. */
  activeLabel?: string | null;
}

export function DevicePicker({
  devices,
  value,
  onChange,
  disabled = false,
  activeLabel = null,
}: DevicePickerProps) {
  return (
    <div className="device-picker">
      <label className="label" htmlFor="input-device">
        Input:
      </label>
      <select
        id="input-device"
        value={value ?? ''}
        disabled={disabled || devices.length === 0}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">System default</option>
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
            {device.isDefault ? '  (remembered)' : ''}
          </option>
        ))}
      </select>
      {activeLabel ? <span className="dim small">open: {activeLabel}</span> : null}
    </div>
  );
}
