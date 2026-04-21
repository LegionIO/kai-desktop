import { useCallback, useState } from 'react';

export function useSplitButtonHover(opts: { popoverOpen: boolean; forceExpanded?: boolean }) {
  const [hovered, setHovered] = useState(false);

  const onMouseEnter = useCallback(() => setHovered(true), []);
  const onMouseLeave = useCallback(() => setHovered(false), []);

  const expanded = hovered || opts.popoverOpen || !!opts.forceExpanded;

  return {
    expanded,
    containerProps: { onMouseEnter, onMouseLeave },
  };
}
