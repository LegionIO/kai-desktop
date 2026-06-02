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

      // The `config:changed` broadcast payload is intentionally redacted
      // before it crosses the IPC and WebSocket boundaries (see
      // `electron/ipc/config.ts` and `electron/plugins/safe-config.ts`),
      // so we cannot use it directly to refresh local state — settings
      // inputs that bind to fields like `realtime.openai.apiKey` would
      // be emptied on every external config change. Instead we treat the
      // event as a "something changed" signal and re-fetch the full
      // config over the dedicated `config:get` channel. The fetched copy
      // is only ever seen by first-party renderer code, never by plugin
      // renderer scripts loaded via the plugin-sandbox API.
      const unsubscribe = app.config.onChanged(() => {
        app.config
          .get()
          .then((cfg) => setConfig(cfg as AppConfig))
          .catch((err) => console.error('[Config] Failed to refresh after broadcast:', err));
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
