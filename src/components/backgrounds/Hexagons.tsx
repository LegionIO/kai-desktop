import { useRef, useEffect, type FC } from 'react';
import { attachCanvasResizeFade } from '@/lib/canvasResizeFade';

const Hexagons: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useHexGridCanvas()} className="absolute inset-0 h-full w-full" style={{ opacity: 0.95 }} />
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

    // Theme-aware palette — derives colors from global --brand-hue + dark mode
    const palette = { stroke: '', strokeBright: '', glow: '', hot: '' };
    const refreshPalette = () => {
      const isDark = document.documentElement.classList.contains('dark');
      const s = getComputedStyle(document.documentElement);
      const hue = s.getPropertyValue('--brand-hue').trim() || '85';
      if (isDark) {
        palette.stroke = `oklch(0.78 0.12 ${hue})`;
        palette.strokeBright = `oklch(0.88 0.08 ${hue})`;
        palette.glow = `oklch(0.60 0.12 ${hue})`;
        palette.hot = `oklch(0.92 0.08 ${hue})`;
      } else {
        palette.stroke = `oklch(0.32 0.16 ${hue})`;
        palette.strokeBright = `oklch(0.42 0.14 ${hue})`;
        palette.glow = `oklch(0.25 0.14 ${hue})`;
        palette.hot = `oklch(0.48 0.12 ${hue})`;
      }
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

      const centerX = width / 2;
      const centerY = height / 2;
      const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

      for (let row = -1; row < rows; row++) {
        for (let col = -1; col < cols; col++) {
          const cx = col * HEX_W + (row % 2 !== 0 ? HEX_W / 2 : 0);
          const cy = row * HEX_H;

          const dx = cx - centerX;
          const dy = cy - centerY;
          const distFromCenter = Math.sqrt(dx * dx + dy * dy) / maxDist;

          const r = Math.random();
          let tier: number;
          if (r < 0.04) tier = 3;
          else if (r < 0.15) tier = 2;
          else if (r < 0.45) tier = 1;
          else tier = 0;

          const baseAlpha =
            tier === 3 ? rand(0.7, 1.0) :
            tier === 2 ? rand(0.4, 0.7) :
            tier === 1 ? rand(0.15, 0.35) :
            rand(0.06, 0.15);

          hexes.push({
            col, row, cx, cy,
            baseAlpha: baseAlpha * Math.max(0, 1 - distFromCenter * 1.2),
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

    const hexAlpha = (hex: Hex, now: number) => {
      const breathe = hex.tier >= 2
        ? Math.sin(now * 0.3 + hex.pulseDelay) * 0.15 + 0.85
        : 1;
      return Math.min(1, hex.baseAlpha * breathe + hex.glowAlpha);
    };

    const drawHexFill = (hex: Hex, now: number) => {
      const alpha = hexAlpha(hex, now);
      if (alpha < 0.005) return;

      const r = HEX_RADIUS * hex.scale;

      // Glow for bright hexes
      if (hex.tier >= 2 && alpha > 0.15) {
        const glowR = r * 2.8;
        const glow = context.createRadialGradient(hex.cx, hex.cy, r * 0.5, hex.cx, hex.cy, glowR);
        glow.addColorStop(0, palette.glow);
        glow.addColorStop(1, 'transparent');
        context.fillStyle = glow;
        context.globalAlpha = alpha * 0.18;
        context.beginPath();
        context.arc(hex.cx, hex.cy, glowR, 0, Math.PI * 2);
        context.fill();
      }

      // Fill for tier 2+ (ambient)
      if (hex.tier >= 2) {
        hexPath(hex.cx, hex.cy, r * 0.95);
        context.fillStyle = palette.stroke;
        context.globalAlpha = alpha * 0.06;
        context.fill();
      }

      // Solid illumination fill from click ripple
      if (hex.rippleAlpha > 0.01) {
        hexPath(hex.cx, hex.cy, r * 0.95);
        context.fillStyle = palette.strokeBright;
        context.globalAlpha = hex.rippleAlpha * 0.35;
        context.fill();
      }

      context.globalAlpha = 1;
    };

    const drawHexStroke = (hex: Hex, now: number) => {
      const pulse = Math.sin(now * 0.5 + hex.phase) * 0.5 + 0.5;
      const alpha = hexAlpha(hex, now);
      if (alpha < 0.005) return;

      const r = HEX_RADIUS * hex.scale;

      // Stroke
      hexPath(hex.cx, hex.cy, r);
      const strokeAlpha = hex.tier >= 3
        ? alpha * (0.7 + pulse * 0.3)
        : hex.tier >= 2
          ? alpha * 0.6
          : alpha;

      context.strokeStyle = hex.tier >= 3
        ? palette.strokeBright
        : hex.tier >= 2
          ? palette.stroke
          : palette.glow;

      context.globalAlpha = Math.min(1, strokeAlpha);
      context.lineWidth = hex.tier >= 3 ? 1.8 : hex.tier >= 2 ? 1.2 : 0.6;
      context.stroke();

      // Inner bright ring for hottest hexes
      if (hex.tier === 3) {
        hexPath(hex.cx, hex.cy, r * 0.7);
        context.strokeStyle = palette.hot;
        context.globalAlpha = alpha * 0.3 * pulse;
        context.lineWidth = 0.8;
        context.stroke();
      }

      context.globalAlpha = 1;
    };

    const drawConnector = (conn: Connector, now: number) => {
      const pulse = Math.sin(now * 0.4 + conn.pulseOffset) * 0.5 + 0.5;
      const alpha = conn.alpha * pulse;
      if (alpha < 0.005) return;

      context.strokeStyle = palette.glow;
      context.globalAlpha = alpha;
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
      dotGlow.addColorStop(0, palette.strokeBright);
      dotGlow.addColorStop(1, 'transparent');
      context.fillStyle = dotGlow;
      context.globalAlpha = alpha * 1.5;
      context.beginPath();
      context.arc(px, py, 6, 0, Math.PI * 2);
      context.fill();

      context.globalAlpha = 1;
    };

    const draw = (time: number) => {
      const now = time / 1000;
      context.clearRect(0, 0, width, height);

      // Pass 1: connectors and hex fills (behind strokes)
      connectors.forEach((c) => drawConnector(c, now));
      hexes.forEach((h) => drawHexFill(h, now));
      // Pass 2: hex strokes on top so they're never covered by neighboring fills
      hexes.forEach((h) => drawHexStroke(h, now));
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

    const stopAnimation = () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
    };

    const startAnimation = () => {
      disposed = false;
      lastTime = performance.now();
      animationFrame = window.requestAnimationFrame(tick);
    };

    resize();
    animationFrame = window.requestAnimationFrame(tick);

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') stopAnimation();
      else startAnimation();
    };

    const disposeResize = attachCanvasResizeFade({
      canvas,
      container,
      setup: resize,
      start: startAnimation,
      stop: stopAnimation,
      baseOpacity: '0.95',
    });

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    container.addEventListener('pointerleave', onPointerLeave);
    container.addEventListener('click', onClick);
    reducedMotion.addEventListener('change', onReducedMotionChange);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', stopAnimation);
    window.addEventListener('focus', startAnimation);

    return () => {
      stopAnimation();
      disposeResize();
      window.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      container.removeEventListener('click', onClick);
      reducedMotion.removeEventListener('change', onReducedMotionChange);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', stopAnimation);
      window.removeEventListener('focus', startAnimation);
      themeObserver.disconnect();
    };
  }, []);

  return canvasRef;
}

export default Hexagons;
