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
    const BOOST_RADIUS = 300;

    // Offscreen canvas renders the rain with brighter glyphs.
    // Each frame we copy a radial region from it onto the main canvas near the cursor.
    const brightCanvas = document.createElement('canvas');
    const brightCtx = brightCanvas.getContext('2d')!;
    // Clean canvas stores the un-boosted state for restoring previously-boosted areas
    const cleanCanvas = document.createElement('canvas');
    const cleanCtx = cleanCanvas.getContext('2d')!;
    // Small scratch canvas for radial masking (sized to boost diameter)
    const scratchCanvas = document.createElement('canvas');
    const scratchCtx = scratchCanvas.getContext('2d')!;

    // Theme-aware palette
    const palette = { fade: '', glyph: '', glyphBright: '', glyphDim: '', bg: '' };
    const refreshPalette = () => {
      const isDark = document.documentElement.classList.contains('dark');
      const s = getComputedStyle(document.documentElement);
      const hue = s.getPropertyValue('--brand-hue').trim() || '85';
      palette.bg = s.getPropertyValue('--background').trim() || (isDark ? '#000' : '#fff');
      if (isDark) {
        palette.fade = `oklch(0.10 0.006 ${hue} / 8%)`;
        palette.glyph = `oklch(0.62 0.08 ${hue} / 50%)`;
        palette.glyphBright = `oklch(0.85 0.14 ${hue} / 90%)`;
        palette.glyphDim = `oklch(0.40 0.04 ${hue} / 10%)`;
      } else {
        palette.fade = `oklch(0.99 0.003 ${hue} / 10%)`;
        palette.glyph = `oklch(0.40 0.10 ${hue} / 55%)`;
        palette.glyphBright = `oklch(0.55 0.18 ${hue} / 90%)`;
        palette.glyphDim = `oklch(0.50 0.06 ${hue} / 10%)`;
      }
      for (const [ctx, cvs] of [[context, canvas], [brightCtx, brightCanvas], [cleanCtx, cleanCanvas]] as const) {
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

    // Pointer tracking
    const pointer = { x: -1, y: -1, active: false };
    let prevPointer = { x: -1, y: -1, active: false };
    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
        pointer.x = x;
        pointer.y = y;
        pointer.active = true;
      } else {
        pointer.active = false;
      }
    };
    const onPointerLeave = () => { pointer.active = false; };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
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

      brightCanvas.width = canvas.width;
      brightCanvas.height = canvas.height;
      brightCtx.setTransform(1, 0, 0, 1, 0, 0);
      brightCtx.scale(devicePixelRatio, devicePixelRatio);

      cleanCanvas.width = canvas.width;
      cleanCanvas.height = canvas.height;
      cleanCtx.setTransform(1, 0, 0, 1, 0, 0);
      cleanCtx.scale(devicePixelRatio, devicePixelRatio);

      // Scratch canvas sized to boost diameter
      const scratchSize = Math.ceil(BOOST_RADIUS * 2 * devicePixelRatio);
      scratchCanvas.width = scratchSize;
      scratchCanvas.height = scratchSize;

      columnCount = Math.ceil(width / fontSize);
      const rows = Math.ceil(height / fontSize);
      drops = Array.from({ length: columnCount }, () => -Math.floor(Math.random() * rows));

      // Draw dim static base layer on all canvases
      for (const ctx of [context, brightCtx, cleanCtx]) {
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
      brightCtx.fillStyle = palette.fade;
      brightCtx.fillRect(0, 0, width, height);
      cleanCtx.fillStyle = palette.fade;
      cleanCtx.fillRect(0, 0, width, height);

      const font = `${fontSize}px Monaco, "Cascadia Code", monospace`;
      context.font = font;
      brightCtx.font = font;
      cleanCtx.font = font;

      for (let index = 0; index < drops.length; index += 1) {
        const x = index * fontSize;
        const y = drops[index] * fontSize;
        const glyph = MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)];

        // Normal color on main + clean canvas
        context.fillStyle = palette.glyph;
        context.fillText(glyph, x, y);
        cleanCtx.fillStyle = palette.glyph;
        cleanCtx.fillText(glyph, x, y);

        // Bright color on offscreen canvas
        brightCtx.fillStyle = palette.glyphBright;
        brightCtx.fillText(glyph, x, y);

        if (y > height && Math.random() > 0.975) drops[index] = 0;
        drops[index] += 1;
      }

      // Restore previous cursor area from clean canvas
      if (prevPointer.active) {
        context.save();
        context.beginPath();
        context.arc(prevPointer.x, prevPointer.y, BOOST_RADIUS, 0, Math.PI * 2);
        context.clip();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(cleanCanvas, 0, 0);
        context.restore();
      }

      // Stamp bright canvas with soft radial falloff around cursor
      if (pointer.active) {
        const dpr = window.devicePixelRatio || 1;
        const r = BOOST_RADIUS;
        const size = scratchCanvas.width;
        const center = size / 2;

        // Copy the bright canvas region into the scratch buffer
        const sx = Math.round((pointer.x - r) * dpr);
        const sy = Math.round((pointer.y - r) * dpr);
        scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
        scratchCtx.clearRect(0, 0, size, size);
        scratchCtx.drawImage(brightCanvas, sx, sy, size, size, 0, 0, size, size);

        // Mask with radial gradient (opaque center → transparent edge)
        scratchCtx.globalCompositeOperation = 'destination-in';
        const grad = scratchCtx.createRadialGradient(center, center, 0, center, center, center);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        scratchCtx.fillStyle = grad;
        scratchCtx.fillRect(0, 0, size, size);
        scratchCtx.globalCompositeOperation = 'source-over';

        // Draw the masked scratch buffer onto the main canvas
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(scratchCanvas, sx, sy);
        context.restore();
      }

      prevPointer = { ...pointer };

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
