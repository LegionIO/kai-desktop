import { useRef, useEffect, type FC } from 'react';

const MATRIX_GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890@#$%^&*+-/~{[|`]}<>01';

const Matrix: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useMatrixCanvas()} className="absolute inset-0 h-full w-full opacity-50" />
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

    const context = canvas.getContext('2d');
    if (!context) return;

    let frameId = 0;
    let animationFrame = 0;
    let drops: number[] = [];
    let columnCount = 0;
    const fontSize = 14;

    const setup = () => {
      const parent = canvas.parentElement;
      const width = parent?.clientWidth ?? window.innerWidth;
      const height = parent?.clientHeight ?? window.innerHeight;
      const devicePixelRatio = window.devicePixelRatio || 1;

      canvas.width = Math.floor(width * devicePixelRatio);
      canvas.height = Math.floor(height * devicePixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.scale(devicePixelRatio, devicePixelRatio);

      columnCount = Math.ceil(width / fontSize);
      drops = Array.from({ length: columnCount }, () => 1);
    };

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const styles = getComputedStyle(document.documentElement);

      context.fillStyle = styles.getPropertyValue('--app-matrix-fade').trim() || 'rgba(250, 248, 244, 0.12)';
      context.fillRect(0, 0, width, height);

      context.fillStyle = styles.getPropertyValue('--app-matrix-glyph').trim() || 'rgba(120, 110, 90, 0.55)';
      context.font = `${fontSize}px Monaco, "Cascadia Code", monospace`;

      for (let index = 0; index < drops.length; index += 1) {
        const glyph = MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)];
        const x = index * fontSize;
        const y = drops[index] * fontSize;

        context.fillText(glyph, x, y);

        if (y > height && Math.random() > 0.975) {
          drops[index] = 0;
        }

        drops[index] += 1;
      }

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

    const handleResize = () => { stop(); setup(); start(); };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') stop(); else start();
    };
    const handleBlur = () => stop();
    const handleFocus = () => start();

    // Clear canvas fully on theme change to prevent white/dark flash
    const themeObserver = new MutationObserver(() => {
      context.clearRect(0, 0, canvas.width, canvas.height);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    window.addEventListener('resize', handleResize);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      stop();
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      themeObserver.disconnect();
    };
  }, []);

  return canvasRef;
}

export default Matrix;
