/**
 * Persisted settings + theme. Theme defaults to prefers-color-scheme on the
 * first visit, then follows the stored toggle.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  applyTheme,
  loadSettings,
  saveSettings,
  type UserSettings,
} from '../storage/settings';

export function useSettings(): {
  settings: UserSettings;
  update: (next: UserSettings | ((current: UserSettings) => UserSettings)) => void;
} {
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings());

  useEffect(() => {
    applyTheme(settings.theme);
    saveSettings(settings);
  }, [settings]);

  const update = useCallback((next: UserSettings | ((current: UserSettings) => UserSettings)) => {
    setSettings((current) => (typeof next === 'function' ? next(current) : next));
  }, []);

  return { settings, update };
}
