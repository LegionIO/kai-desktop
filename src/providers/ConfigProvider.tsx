import { createContext, useContext, useEffect, useState, useMemo, useCallback, type ReactNode } from 'react';
import { app } from '@/lib/ipc-client';

type AppConfig = Record<string, unknown>;

type ConfigContextValue = {
  config: AppConfig | null;
  updateConfig: (path: string, value: unknown) => Promise<void>;
};

const ConfigContext = createContext<ConfigContextValue>({
  config: null,
  updateConfig: async () => {},
});

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    try {
      app.config
        .get()
        .then((cfg) => setConfig(cfg as AppConfig))
        .catch((err) => console.error('[Config] Failed to load:', err));

      // config:changed carries a REDACTED payload (secrets stripped before the
      // broadcast fans out to plugin renderers + web-socket peers), so treat it
      // as a "something changed" signal and re-fetch the full config via the
      // first-party config:get pull channel rather than trusting the payload
      // (which would blank the API-key fields in the settings UI).
      const unsubscribe = app.config.onChanged(() => {
        app.config
          .get()
          .then((cfg) => setConfig(cfg as AppConfig))
          .catch((err) => console.error('[Config] Failed to refetch after change:', err));
      });

      return unsubscribe;
    } catch (err) {
      console.error('[Config] IPC bridge not available:', err);
    }
  }, []);

  const updateConfig = useCallback(async (path: string, value: unknown) => {
    try {
      const updated = await app.config.set(path, value);
      setConfig(updated as AppConfig);
    } catch (err) {
      console.error('[Config] Failed to update:', err);
    }
  }, []);

  const value = useMemo(() => ({ config, updateConfig }), [config, updateConfig]);

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig() {
  return useContext(ConfigContext);
}
