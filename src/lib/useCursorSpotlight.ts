import { useRef, useEffect } from 'react';

/**
 * Creates a cursor-following spotlight overlay that dims the background
 * everywhere except near the cursor. Much cheaper than per-element
 * distance calculations — it's a single div with a radial gradient.
 *
 * The returned ref should be placed on a div with `absolute inset-0`.
 */
export function useCursorSpotlight(radius = 350) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let active = false;

    const dimBg = 'var(--background)';
    const dimOpacity = 0.6;
    const dim = `color-mix(in srgb, ${dimBg} ${dimOpacity * 100}%, transparent)`;

    overlay.style.background = dim;

    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion.matches) return;
      const rect = overlay.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (x >= 0 && y >= 0 && x <= rect.width && y <= rect.height) {
        active = true;
        overlay.style.background = `radial-gradient(circle at ${x}px ${y}px, transparent ${radius * 0.2}px, ${dim} ${radius}px)`;
      } else if (active) {
        active = false;
        overlay.style.background = dim;
      }
    };

    const onPointerLeave = () => {
      active = false;
      overlay.style.background = dim;
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [radius]);

  return overlayRef;
}
