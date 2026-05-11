import { useConfig } from '@/providers/ConfigProvider';

/**
 * Returns true when the user has enabled "Full width content" in settings,
 * meaning content areas should not be constrained by max-w-3xl.
 */
export function useFullWidthContent(): boolean {
  const { config } = useConfig();
  const ui = (config as Record<string, unknown> | null)?.ui as
    | { fullWidthContent?: boolean }
    | undefined;
  return !!ui?.fullWidthContent;
}
