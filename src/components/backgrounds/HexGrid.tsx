import { useRef, useEffect, type FC } from 'react';

const HexGrid: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useHexGridCanvas()} className="absolute inset-0 h-full w-full" style={{ opacity: 0.95 }} />
    <div
      className="absolute inset-0"
      style={{
        background: [
          'radial-gradient(circle at 50% 32%, var(--app-hex-vignette-glow), transparent 30%)',
          'radial-gradient(circle at 50% 70%, var(--app-hex-vignette-mid), var(--app-hex-vignette-outer) 72%)',
          'linear-gradient(180deg, var(--app-hex-vignette-top) 0%, var(--app-hex-vignette-fade) 30%, var(--app-hex-vignette-bottom) 100%)',
        ].join(', '),
        pointerEvents: 'none',
      }}
    />
    <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background via-background/70 to-transparent" />
    <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/75 to-transparent" />
    <div className="absolute inset-y-0 left-0 w-28 bg-gradient-to-r from-background via-background/85 to-transparent" />
    <div className="absolute inset-y-0 right-0 w-28 bg-gradient-to-l from-background via-background/85 to-transparent" />
  </div>
);

interface Hex {
  col: number;
  row: number;
  cx: number;
  cy: number;
  baseAlpha: number;
  glowAlpha: number;
  glowTarget: number;
  glowSpeed: number;
  rippleAlpha: number;
  rippleTarget: number;
  phase: number;
  tier: number;
  pulseDelay: number;
  scale: number;
  scaleTarget: number;
}

interface Connector {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  alpha: number;
  pulseOffset: number;
}

interface Ripple {
  cx: number;
  cy: number;
  radius: number;
  speed: number;
  life: number;
  maxLife: number;
  noise: number[];
}

/** Resolve a CSS color (including oklch) to "r, g, b" via a probe element. */
function resolveToRgb(cssColor: string, fallback: string): string {
  if (!cssColor) return fallback;
  const probe = document.createElement('div');
  probe.style.color = cssColor;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const match = resolved.match(/[\d.]+/g);
  return match ? `${match[0]}, ${match[1]}, ${match[2]}` : fallback;
}

function useHexGridCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const container = canvas.parentElement;
    if (!container) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let dpr = 1;
    let animationFrame = 0;
    let disposed = false;
    let lastTime = performance.now();

    // Theme-aware palette resolved from CSS variables
    const palette = { stroke: '', strokeBright: '', glow: '', hot: '' };
    const refreshPalette = () => {
      const s = getComputedStyle(document.documentElement);
      palette.stroke = resolveToRgb(s.getPropertyValue('--app-hex-stroke').trim(), '120, 100, 160');
      palette.strokeBright = resolveToRgb(s.getPropertyValue('--app-hex-stroke-bright').trim(), '160, 140, 200');
      palette.glow = resolveToRgb(s.getPropertyValue('--app-hex-glow').trim(), '90, 70, 130');
      palette.hot = resolveToRgb(s.getPropertyValue('--app-hex-hot').trim(), '190, 170, 220');
    };
    refreshPalette();

    const themeObserver = new MutationObserver(refreshPalette);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const pointer = { x: 0, y: 0, active: false };

    const HEX_RADIUS = 32;
    const HEX_GAP = 4;
    const HEX_W = Math.sqrt(3) * (HEX_RADIUS + HEX_GAP);
    const HEX_H = 1.5 * (HEX_RADIUS + HEX_GAP);

    const ripples: Ripple[] = [];
    let hexes: Hex[] = [];
    let connectors: Connector[] = [];

    const rand = (min: number, max: number) => Math.random() * (max - min) + min;

    const hexPath = (cx: number, cy: number, r: number) => {
      context.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
    };

    const buildGrid = () => {
      hexes = [];
      connectors = [];

      const cols = Math.ceil(width / HEX_W) + 2;
      const rows = Math.ceil(height / HEX_H) + 2;

      const centerCol = cols / 2;
      const centerRow = rows / 2;

      for (let row = -1; row < rows; row++) {
        for (let col = -1; col < cols; col++) {
          const cx = col * HEX_W + (row % 2 !== 0 ? HEX_W / 2 : 0);
          const cy = row * HEX_H;

          const dc = Math.abs(col - centerCol) / centerCol;
          const dr = Math.abs(row - centerRow) / centerRow;
          const distFromCenter = Math.sqrt(dc * dc + dr * dr);

          const r = Math.random();
          let tier: number;
          if (r < 0.04) tier = 3;
          else if (r < 0.15) tier = 2;
          else if (r < 0.45) tier = 1;
          else tier = 0;

          const baseAlpha =
            tier === 3 ? rand(0.6, 0.9) :
            tier === 2 ? rand(0.25, 0.5) :
            tier === 1 ? rand(0.08, 0.18) :
            rand(0.02, 0.06);

          hexes.push({
            col, row, cx, cy,
            baseAlpha: baseAlpha * (1 - distFromCenter * 0.3),
            glowAlpha: 0,
            glowTarget: 0,
            glowSpeed: rand(0.8, 2.5),
            rippleAlpha: 0,
            rippleTarget: 0,
            phase: rand(0, Math.PI * 2),
            tier,
            pulseDelay: rand(0, 12),
            scale: 1,
            scaleTarget: 1,
          });
        }
      }

      // Build connector lines between bright hex clusters
      const brightHexes = hexes.filter((h) => h.tier >= 2);
      for (let i = 0; i < brightHexes.length; i++) {
        for (let j = i + 1; j < brightHexes.length; j++) {
          const a = brightHexes[i];
          const b = brightHexes[j];
          const dx = a.cx - b.cx;
          const dy = a.cy - b.cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < HEX_W * 5 && Math.random() < 0.3) {
            connectors.push({
              x1: a.cx, y1: a.cy,
              x2: b.cx, y2: b.cy,
              alpha: rand(0.06, 0.18),
              pulseOffset: rand(0, Math.PI * 2),
            });
          }
        }
      }
    };

    const resize = () => {
      const newWidth = Math.max(1, container.offsetWidth || window.innerWidth);
      const newHeight = Math.max(1, container.offsetHeight || window.innerHeight);
      const newDpr = Math.min(window.devicePixelRatio || 1, 2);

      const changed = newWidth !== width || newDpr !== dpr;

      width = newWidth;
      height = newHeight;
      dpr = newDpr;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (changed) buildGrid();
      draw(lastTime);
    };

    const drawHex = (hex: Hex, now: number) => {
      const pulse = Math.sin(now * 0.5 + hex.phase) * 0.5 + 0.5;
      const breathe = hex.tier >= 2
        ? Math.sin(now * 0.3 + hex.pulseDelay) * 0.15 + 0.85
        : 1;

      const alpha = (hex.baseAlpha * breathe + hex.glowAlpha);
      if (alpha < 0.005) return;

      const r = HEX_RADIUS * hex.scale;

      // Glow for bright hexes
      if (hex.tier >= 2 && alpha > 0.15) {
        const glowR = r * 2.8;
        const glow = context.createRadialGradient(hex.cx, hex.cy, r * 0.5, hex.cx, hex.cy, glowR);
        glow.addColorStop(0, `rgba(${palette.glow}, ${alpha * 0.18})`);
        glow.addColorStop(1, `rgba(${palette.glow}, 0)`);
        context.fillStyle = glow;
        context.beginPath();
        context.arc(hex.cx, hex.cy, glowR, 0, Math.PI * 2);
        context.fill();
      }

      // Fill for tier 2+ (ambient)
      if (hex.tier >= 2) {
        hexPath(hex.cx, hex.cy, r * 0.95);
        const fillAlpha = alpha * 0.06;
        context.fillStyle = `rgba(${palette.stroke}, ${fillAlpha})`;
        context.fill();
      }

      // Solid illumination fill from click ripple
      if (hex.rippleAlpha > 0.01) {
        hexPath(hex.cx, hex.cy, r * 0.95);
        context.fillStyle = `rgba(${palette.strokeBright}, ${hex.rippleAlpha * 0.35})`;
        context.fill();
      }

      // Stroke
      hexPath(hex.cx, hex.cy, r);
      const strokeAlpha = hex.tier >= 3
        ? alpha * (0.7 + pulse * 0.3)
        : hex.tier >= 2
          ? alpha * 0.6
          : alpha;

      context.strokeStyle = hex.tier >= 3
        ? `rgba(${palette.strokeBright}, ${strokeAlpha})`
        : hex.tier >= 2
          ? `rgba(${palette.stroke}, ${strokeAlpha})`
          : `rgba(${palette.glow}, ${strokeAlpha})`;

      context.lineWidth = hex.tier >= 3 ? 1.8 : hex.tier >= 2 ? 1.2 : 0.6;
      context.stroke();

      // Inner bright ring for hottest hexes
      if (hex.tier === 3) {
        hexPath(hex.cx, hex.cy, r * 0.7);
        context.strokeStyle = `rgba(${palette.hot}, ${alpha * 0.3 * pulse})`;
        context.lineWidth = 0.8;
        context.stroke();
      }
    };

    const drawConnector = (conn: Connector, now: number) => {
      const pulse = Math.sin(now * 0.4 + conn.pulseOffset) * 0.5 + 0.5;
      const alpha = conn.alpha * pulse;
      if (alpha < 0.005) return;

      context.strokeStyle = `rgba(${palette.glow}, ${alpha})`;
      context.lineWidth = 0.8;
      context.beginPath();
      context.moveTo(conn.x1, conn.y1);
      context.lineTo(conn.x2, conn.y2);
      context.stroke();

      // Traveling pulse dot
      const t = (now * 0.08 + conn.pulseOffset) % 1;
      const px = conn.x1 + (conn.x2 - conn.x1) * t;
      const py = conn.y1 + (conn.y2 - conn.y1) * t;
      const dotGlow = context.createRadialGradient(px, py, 0, px, py, 6);
      dotGlow.addColorStop(0, `rgba(${palette.strokeBright}, ${alpha * 1.5})`);
      dotGlow.addColorStop(1, `rgba(${palette.strokeBright}, 0)`);
      context.fillStyle = dotGlow;
      context.beginPath();
      context.arc(px, py, 6, 0, Math.PI * 2);
      context.fill();
    };

    const draw = (time: number) => {
      const now = time / 1000;
      context.clearRect(0, 0, width, height);

      connectors.forEach((c) => drawConnector(c, now));
      hexes.forEach((h) => drawHex(h, now));
    };

    const tick = (time: number) => {
      if (disposed) return;

      const delta = Math.min((time - lastTime) / 1000, 0.033);
      lastTime = time;

      if (!reducedMotion.matches) {
        // Advance ripples
        for (let i = ripples.length - 1; i >= 0; i--) {
          const rip = ripples[i];
          rip.radius += delta * rip.speed;
          rip.life -= delta;
          if (rip.life <= 0) { ripples.splice(i, 1); continue; }
        }

        // Pointer proximity glow + ripple wave
        hexes.forEach((hex) => {
          let hoverGlow = 0;
          let hoverScale = 1;

          if (pointer.active) {
            const dx = hex.cx - pointer.x;
            const dy = hex.cy - pointer.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const influence = Math.max(0, 1 - dist / 220);
            hoverGlow = influence * 0.7;
            hoverScale = 1 + influence * 0.12;
          }

          // Ripple wave contributions (brightness only, no scale)
          let rippleGlow = 0;
          for (const rip of ripples) {
            const dx = hex.cx - rip.cx;
            const dy = hex.cy - rip.cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const band = 60;
            const diff = Math.abs(dist - rip.radius);
            if (diff < band) {
              const wave = 1 - diff / band;
              const fade = Math.min(1, rip.life / (rip.maxLife * 0.4));
              const jitter = 0.5 + rip.noise[Math.abs(Math.round(hex.col * 7 + hex.row * 13)) % rip.noise.length] * 0.5;
              rippleGlow = Math.max(rippleGlow, wave * fade * jitter * 0.8);
            }
          }

          hex.glowTarget = Math.min(1, hoverGlow + rippleGlow);
          hex.rippleTarget = rippleGlow;
          hex.scaleTarget = hoverScale;

          hex.glowAlpha += (hex.glowTarget - hex.glowAlpha) * delta * hex.glowSpeed * 3;
          hex.rippleAlpha += (hex.rippleTarget - hex.rippleAlpha) * delta * hex.glowSpeed * 3;
          hex.scale += (hex.scaleTarget - hex.scale) * delta * 5;
        });
      }

      draw(time);
      animationFrame = window.requestAnimationFrame(tick);
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.active = true;
    };

    const onPointerLeave = () => {
      pointer.active = false;
    };

    const onClick = (event: MouseEvent) => {
      if (reducedMotion.matches) return;

      const rect = container.getBoundingClientRect();
      const noise = Array.from({ length: 32 }, () => Math.random());
      ripples.push({
        cx: event.clientX - rect.left,
        cy: event.clientY - rect.top,
        radius: 0,
        speed: rand(280, 420),
        life: 2.2,
        maxLife: 2.2,
        noise,
      });
    };

    const onReducedMotionChange = () => {
      if (reducedMotion.matches) {
        pointer.active = false;
      }
    };

    resize();
    animationFrame = window.requestAnimationFrame(tick);

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        disposed = true;
        window.cancelAnimationFrame(animationFrame);
      } else {
        disposed = false;
        lastTime = performance.now();
        animationFrame = window.requestAnimationFrame(tick);
      }
    };

    const handleBlur = () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
    };

    const handleFocus = () => {
      disposed = false;
      lastTime = performance.now();
      animationFrame = window.requestAnimationFrame(tick);
    };

    let ro: ResizeObserver | undefined;
    if (container) {
      ro = new ResizeObserver(() => resize());
      ro.observe(container);
    }

    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    container.addEventListener('pointerleave', onPointerLeave);
    container.addEventListener('click', onClick);
    reducedMotion.addEventListener('change', onReducedMotionChange);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      container.removeEventListener('click', onClick);
      reducedMotion.removeEventListener('change', onReducedMotionChange);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      themeObserver.disconnect();
      ro?.disconnect();
    };
  }, []);

  return canvasRef;
}

export default HexGrid;
