/**
 * hooks/useConfig.ts — loads config.json once at app start.
 *
 * main.py constructs `ConfigManager()` at the top of `main()` and passes it
 * down; the hook is the React equivalent, with a module-level cache so a
 * double-mount (StrictMode) or a re-render never re-fetches the file.
 */

import { useEffect, useState } from 'react';

import { ConfigManager, loadConfig } from '../config/config';

let cached: Promise<ConfigManager> | null = null;

/** Test seam: clears the module-level config cache. */
export function resetConfigCache(): void {
  cached = null;
}

export interface UseConfigResult {
  config: ConfigManager | null;
  error: Error | null;
  loading: boolean;
}

export function useConfig(): UseConfigResult {
  const [config, setConfig] = useState<ConfigManager | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    cached ??= loadConfig();
    cached
      .then((loaded) => {
        if (cancelled) return;
        setConfig(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        cached = null; // allow a retry on the next mount
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, error, loading };
}
