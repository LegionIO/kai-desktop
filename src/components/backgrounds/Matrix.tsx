import { useRef, useEffect, type FC } from 'react';
import { attachCanvasResizeFade } from '@/lib/canvasResizeFade';

const MATRIX_GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890@#$%^&*+-/~{[|`]}<>01';

const Matrix: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useMatrixCanvas()} className="absolute inset-0 h-full w-full opacity-75" />
    <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background via-background/70 to-transparent" />
    <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/75 to-transparent" />
    <div className="absolute inset-y-0 left-0 w-28 bg-gradient-to-r from-background via-background/85 to-transparent" />
    <div className="absolute inset-y-0 right-0 w-28 bg-gradient-to-l from-background via-background/85 to-transparent" />
  </div>
);

function useMatrixCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const container = canvas.parentElement;
    if (!container) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let frameId = 0;
    let animationFrame = 0;
    let drops: number[] = [];
    let columnCount = 0;
    const fontSize = 14;

    // Second canvas for hover-highlighted version, third for clean default (never has hover color)
    const hoverCanvas = document.createElement('canvas');
    const hoverCtx = hoverCanvas.getContext('2d')!;
    const goldCanvas = document.createElement('canvas');
    const goldCtx = goldCanvas.getContext('2d')!;

    // Theme-aware palette
    const palette = { fade: '', glyph: '', glyphDim: '', glyphHover: '', bg: '' };
    const refreshPalette = () => {
      const s = getComputedStyle(document.documentElement);
      palette.fade = s.getPropertyValue('--app-matrix-fade').trim() || 'rgba(250, 248, 244, 0.12)';
      palette.glyph = s.getPropertyValue('--app-matrix-glyph').trim() || 'rgba(120, 110, 90, 0.55)';
      palette.glyphDim = s.getPropertyValue('--app-matrix-glyph-dim').trim() || 'rgba(120, 110, 90, 0.1)';
      palette.glyphHover = s.getPropertyValue('--app-matrix-glyph-hover').trim() || 'rgba(255, 255, 255, 0.9)';
      palette.bg = s.getPropertyValue('--background').trim() || '#000';
      // Reset all canvases with opaque background on theme change
      for (const [ctx, cvs] of [[context, canvas], [hoverCtx, hoverCanvas], [goldCtx, goldCanvas]] as const) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = palette.bg;
        ctx.fillRect(0, 0, cvs.width, cvs.height);
        ctx.restore();
      }
    };
    refreshPalette();

    const themeObserver = new MutationObserver(refreshPalette);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Pointer tracking for column highlight
    const pointer = { col: -1 };
    let prevCol = -1;
    const HOVER_RADIUS = 3; // columns on each side of cursor also highlight
    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x >= 0 && x <= rect.width && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        pointer.col = Math.floor(x / fontSize);
      } else {
        pointer.col = -1;
      }
    };
    const onPointerLeave = () => { pointer.col = -1; };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onPointerLeave);

    const setup = () => {
      const width = container.offsetWidth || window.innerWidth;
      const height = container.offsetHeight || window.innerHeight;
      const devicePixelRatio = window.devicePixelRatio || 1;

      canvas.width = Math.floor(width * devicePixelRatio);
      canvas.height = Math.floor(height * devicePixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.scale(devicePixelRatio, devicePixelRatio);

      hoverCanvas.width = canvas.width;
      hoverCanvas.height = canvas.height;
      hoverCtx.setTransform(1, 0, 0, 1, 0, 0);
      hoverCtx.scale(devicePixelRatio, devicePixelRatio);

      goldCanvas.width = canvas.width;
      goldCanvas.height = canvas.height;
      goldCtx.setTransform(1, 0, 0, 1, 0, 0);
      goldCtx.scale(devicePixelRatio, devicePixelRatio);

      columnCount = Math.ceil(width / fontSize);
      const rows = Math.ceil(height / fontSize);
      drops = Array.from({ length: columnCount }, () => -Math.floor(Math.random() * rows));

      // Draw a dim static base layer of glyphs across the entire grid
      for (const ctx of [context, hoverCtx, goldCtx]) {
        ctx.fillStyle = palette.glyphDim;
        ctx.font = `${fontSize}px Monaco, "Cascadia Code", monospace`;
        for (let col = 0; col < columnCount; col += 1) {
          for (let row = 0; row < rows; row += 1) {
            ctx.fillText(MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)], col * fontSize, row * fontSize);
          }
        }
      }
    };

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      // Fade all three canvases
      context.fillStyle = palette.fade;
      context.fillRect(0, 0, width, height);
      hoverCtx.fillStyle = palette.fade;
      hoverCtx.fillRect(0, 0, width, height);
      goldCtx.fillStyle = palette.fade;
      goldCtx.fillRect(0, 0, width, height);

      context.font = `${fontSize}px Monaco, "Cascadia Code", monospace`;
      hoverCtx.font = `${fontSize}px Monaco, "Cascadia Code", monospace`;
      goldCtx.font = `${fontSize}px Monaco, "Cascadia Code", monospace`;

      for (let index = 0; index < drops.length; index += 1) {
        const x = index * fontSize;
        const y = drops[index] * fontSize;
        const glyph = MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)];

        // Gold on main + gold canvas
        context.fillStyle = palette.glyph;
        context.fillText(glyph, x, y);
        goldCtx.fillStyle = palette.glyph;
        goldCtx.fillText(glyph, x, y);

        // Hover color on offscreen canvas
        hoverCtx.fillStyle = palette.glyphHover;
        hoverCtx.fillText(glyph, x, y);

        if (y > height && Math.random() > 0.975) drops[index] = 0;
        drops[index] += 1;
      }

      // Swap hovered columns: replace with hover-colored version
      const dpr = window.devicePixelRatio || 1;
      const hoverMin = pointer.col >= 0 ? Math.max(0, pointer.col - HOVER_RADIUS) : -1;
      const hoverMax = pointer.col >= 0 ? Math.min(columnCount - 1, pointer.col + HOVER_RADIUS) : -1;
      const prevMin = prevCol >= 0 ? Math.max(0, prevCol - HOVER_RADIUS) : -1;
      const prevMax = prevCol >= 0 ? Math.min(columnCount - 1, prevCol + HOVER_RADIUS) : -1;

      // Draw hover-highlighted columns
      if (hoverMin >= 0) {
        const srcX = Math.floor(hoverMin * fontSize * dpr);
        const srcW = Math.ceil((hoverMax - hoverMin + 1) * fontSize * dpr);
        const srcH = canvas.height;
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(hoverCanvas, srcX, 0, srcW, srcH, srcX, 0, srcW, srcH);
        context.restore();
      }

      // Restore previously hovered columns that are no longer in range
      if (prevMin >= 0 && prevCol !== pointer.col) {
        for (let c = prevMin; c <= prevMax; c += 1) {
          if (hoverMin >= 0 && c >= hoverMin && c <= hoverMax) continue; // still hovered
          const srcX = Math.floor(c * fontSize * dpr);
          const srcW = Math.ceil(fontSize * dpr);
          const srcH = canvas.height;
          context.save();
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.drawImage(goldCanvas, srcX, 0, srcW, srcH, srcX, 0, srcW, srcH);
          context.restore();
        }
      }
      prevCol = pointer.col;

      frameId = window.setTimeout(() => {
        animationFrame = window.requestAnimationFrame(draw);
      }, 65);
    };

    const stop = () => {
      window.clearTimeout(frameId);
      window.cancelAnimationFrame(animationFrame);
    };

    const start = () => {
      stop();
      draw();
    };

    setup();
    start();

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') stop(); else start();
    };
    const handleBlur = () => stop();
    const handleFocus = () => start();

    const disposeResize = attachCanvasResizeFade({
      canvas,
      container,
      setup,
      start,
      stop,
      baseOpacity: '0.75',
    });

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      stop();
      disposeResize();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      themeObserver.disconnect();
    };
  }, []);

  return canvasRef;
}

export default Matrix;
