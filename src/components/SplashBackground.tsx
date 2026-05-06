/**
 * SplashBackground — Reusable animated background for empty/splash states.
 *
 * Used by both the chat Thread (empty conversation) and TaskCreationView
 * (before the user submits their first prompt). Encapsulates:
 *
 * 1. Random background selection (never repeats consecutively)
 * 2. Fade-in animation on mount (2 s ease-out)
 * 3. Fade-out when `visible` becomes false (300 ms)
 * 4. Full-bleed positioning that extends behind the title bar
 * 5. Left-edge gradient mask
 */

import { useState, useEffect, useRef, type FC } from 'react';
import { backgrounds } from '@/components/backgrounds';

// ── Background picker ────────────────────────────────────────────────

function pickBackground(storageKey: string): FC {
  const lastIndex = parseInt(sessionStorage.getItem(storageKey) ?? '-1', 10);
  const available =
    backgrounds.length > 1 ? backgrounds.filter((_, i) => i !== lastIndex) : backgrounds;
  return available[Math.floor(Math.random() * available.length)];
}

// ── Props ────────────────────────────────────────────────────────────

interface SplashBackgroundProps {
  /**
   * Whether the splash is visible.
   * - `true`  → fade in (2 s) on mount / re-mount.
   * - `false` → fade out (300 ms), then unmount children.
   */
  visible: boolean;
  /**
   * When transitioning visible → false, skip the 300 ms fade and hide
   * instantly. Useful when loading an existing thread that already has
   * many messages — avoids a brief flash of the background.
   */
  instant?: boolean;
  /** SessionStorage key used to persist the last-used background index. */
  storageKey?: string;
}

// ── Component ────────────────────────────────────────────────────────

export const SplashBackground: FC<SplashBackgroundProps> = ({
  visible,
  instant = false,
  storageKey = '__bg_last_index',
}) => {
  const [mounted, setMounted] = useState(visible);
  const [fadingOut, setFadingOut] = useState(false);
  const [fadedIn, setFadedIn] = useState(false);
  const prevVisibleRef = useRef(visible);

  // Track the `visible` prop and trigger fade-in / fade-out.
  useEffect(() => {
    const prev = prevVisibleRef.current;
    prevVisibleRef.current = visible;

    if (visible && !prev) {
      // Becoming visible — mount + fade in
      setMounted(true);
      setFadingOut(false);
      setFadedIn(false);
      // Double RAF: first frame paints at opacity 0, second triggers transition
      requestAnimationFrame(() => requestAnimationFrame(() => setFadedIn(true)));
    } else if (!visible && prev) {
      // Becoming hidden — start fade-out (or instant hide)
      if (instant) {
        setMounted(false);
        setFadingOut(false);
      } else {
        setFadingOut(true);
      }
    }
  }, [visible, instant]);

  // Initial mount — if starting visible, kick the fade-in
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    if (visible) {
      requestAnimationFrame(() => requestAnimationFrame(() => setFadedIn(true)));
    }
  }, [visible]);

  // Unmount children after fade-out completes
  useEffect(() => {
    if (!fadingOut) return;
    const timer = setTimeout(() => {
      setMounted(false);
      setFadingOut(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [fadingOut]);

  if (!mounted) return null;

  return (
    <div
      className="absolute inset-0 -top-28 z-10 transition-opacity ease-out md:-top-[8.5rem]"
      style={{
        opacity: fadingOut ? 0 : fadedIn ? 1 : 0,
        transitionDuration: fadingOut ? '300ms' : '2000ms',
      }}
    >
      <div
        className="relative h-full w-full"
        style={{ maskImage: 'linear-gradient(to right, transparent, black 8%)' }}
      >
        <BackgroundImage storageKey={storageKey} />
      </div>
    </div>
  );
};

// ── Internal: picks + renders the actual background ──────────────────

const BackgroundImage: FC<{ storageKey: string }> = ({ storageKey }) => {
  const [Background] = useState<FC>(() => pickBackground(storageKey));

  // Persist which background is displayed — useEffect only commits once,
  // unlike useState initializers which StrictMode may call twice.
  useEffect(() => {
    const idx = backgrounds.indexOf(Background);
    if (idx !== -1) sessionStorage.setItem(storageKey, String(idx));
  }, [Background, storageKey]);

  return (
    <div className="absolute inset-0">
      <Background />
    </div>
  );
};
