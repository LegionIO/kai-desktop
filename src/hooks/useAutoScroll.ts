import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Smart auto-scroll hook for streaming content.
 *
 * Behavior:
 *   - Auto-scrolls to bottom when new content arrives (deps change)
 *   - Stops auto-scrolling when user explicitly scrolls UP (user override)
 *   - Resumes auto-scrolling when user scrolls back near the bottom
 *   - Distinguishes programmatic scroll from user scroll via isAutoScrollingRef
 *
 * Ported from fusion-app's useAutoScroll pattern.
 */
export function useAutoScroll<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const lastScrollTopRef = useRef(0);
  const isAutoScrollingRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // If we triggered this scroll programmatically, ignore it
    if (isAutoScrollingRef.current) return;

    const threshold = 80; // px from bottom considered "near bottom"
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;

    // Detect user scrolling UP (away from bottom) with 5px hysteresis
    const scrolledUp = el.scrollTop < lastScrollTopRef.current - 5;
    lastScrollTopRef.current = el.scrollTop;

    if (nearBottom) {
      // User scrolled back to bottom — resume auto-follow
      if (userScrolled) setUserScrolled(false);
    } else if (scrolledUp && !userScrolled) {
      // User scrolled up — pause auto-follow
      setUserScrolled(true);
    }
  }, [userScrolled]);

  // Auto-scroll when deps change (new messages, streaming content updates)
  useEffect(() => {
    const el = ref.current;
    if (!el || userScrolled) return;

    // Cancel any pending scroll
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);

    scrollRafRef.current = requestAnimationFrame(() => {
      isAutoScrollingRef.current = true;
      el.scrollTop = el.scrollHeight;
      // Reset the flag after the browser processes the scroll event
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false;
        lastScrollTopRef.current = el.scrollTop;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  return { ref, handleScroll, userScrolled, setUserScrolled };
}
