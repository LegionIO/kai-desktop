interface CanvasResizeFadeConfig {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  setup: () => void;
  start: () => void;
  stop: () => void;
  debounceMs?: number;
  fadeDurationMs?: number;
  baseOpacity?: string;
}

/**
 * Attaches a resize handler to a canvas background that:
 *   1. Immediately stops the animation and fades the canvas out.
 *   2. Debounces rapid resize events.
 *   3. After the debounce settles, calls setup() + start() and fades back in.
 *
 * Returns a dispose function that removes all listeners.
 */
export function attachCanvasResizeFade({
  canvas,
  container,
  setup,
  start,
  stop,
  debounceMs = 200,
  fadeDurationMs = 180,
  baseOpacity = '1',
}: CanvasResizeFadeConfig): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resizing = false;

  canvas.style.transition = `opacity ${fadeDurationMs}ms ease-out`;
  canvas.style.opacity = baseOpacity;

  const onResize = () => {
    if (!resizing) {
      resizing = true;
      stop();
      canvas.style.opacity = '0';
    }

    if (timer) clearTimeout(timer);

    timer = setTimeout(() => {
      resizing = false;
      setup();
      start();
      canvas.style.opacity = baseOpacity;
      timer = null;
    }, debounceMs);
  };

  const ro = new ResizeObserver(onResize);
  ro.observe(container);
  window.addEventListener('resize', onResize, { passive: true });

  return () => {
    if (timer) clearTimeout(timer);
    ro.disconnect();
    window.removeEventListener('resize', onResize);
  };
}
