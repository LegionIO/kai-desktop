import { useCallback, useState } from 'react';

const VIEWPORT_MARGIN = 12;

export function usePopoverAlign() {
  const [offset, setOffset] = useState(0);

  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) { setOffset(0); return; }

    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;

    if (rect.right > vw - VIEWPORT_MARGIN) {
      setOffset(-(rect.right - vw + VIEWPORT_MARGIN));
    } else if (rect.left < VIEWPORT_MARGIN) {
      setOffset(VIEWPORT_MARGIN - rect.left);
    } else {
      setOffset(0);
    }
  }, []);

  const style = offset !== 0 ? { transform: `translateX(${offset}px)` } : undefined;

  return { ref, style };
}
