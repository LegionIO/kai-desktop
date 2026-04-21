import { useRef, useEffect, type FC } from 'react';
import { attachCanvasResizeFade } from '@/lib/canvasResizeFade';

const Constellations: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useConstellationsCanvas()} className="absolute inset-0 h-full w-full" />
    <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background via-background/70 to-transparent" />
    <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/75 to-transparent" />
    <div className="absolute inset-y-0 left-0 w-28 bg-gradient-to-r from-background via-background/85 to-transparent" />
    <div className="absolute inset-y-0 right-0 w-28 bg-gradient-to-l from-background via-background/85 to-transparent" />
    <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, var(--brand-accent-subtle), transparent 58%)' }} />
  </div>
);

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
  connectable: boolean;
  twinklePhase: number;
  nudgeCountdown: number;
  age: number; // frames since spawn, used for fade-in
}

/** Draw a fuzzy glowing star with soft halo */
function drawGlowDot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, alpha: number) {
  // Outer soft halo
  ctx.globalAlpha = alpha * 0.08;
  const outerGlow = ctx.createRadialGradient(x, y, 0, x, y, radius * 8);
  outerGlow.addColorStop(0, color);
  outerGlow.addColorStop(0.3, color);
  outerGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = outerGlow;
  ctx.fillRect(x - radius * 8, y - radius * 8, radius * 16, radius * 16);

  // Inner glow
  ctx.globalAlpha = alpha * 0.25;
  const innerGlow = ctx.createRadialGradient(x, y, 0, x, y, radius * 3);
  innerGlow.addColorStop(0, color);
  innerGlow.addColorStop(0.5, color);
  innerGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = innerGlow;
  ctx.fillRect(x - radius * 3, y - radius * 3, radius * 6, radius * 6);

  // Bright core
  ctx.globalAlpha = alpha * 0.9;
  const core = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.2);
  core.addColorStop(0, '#fff');
  core.addColorStop(0.4, color);
  core.addColorStop(1, 'transparent');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.2, 0, Math.PI * 2);
  ctx.fill();
}

function useConstellationsCanvas() {
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
    let particles: Particle[] = [];
    let tick = 0;

    const nodeCount = 25;
    const starCount = 400;
    const totalCount = nodeCount + starCount;
    const connectionDistance = 160;
    const maxConnectionsPerNode = 3;
    const nodeSpeed = 0.14;
    const starSpeed = 0.025;

    const connections = new Map<string, { strength: number }>();
    const fadeInRate = 0.04;
    const fadeOutRate = 0.02;

    interface ShootingStar {
      x: number; y: number;
      vx: number; vy: number;
      life: number;
      maxLife: number;
      tailLength: number;
    }
    let shootingStar: ShootingStar | null = null;
    const shootingStarChance = 0.003;
    const shootingStarFrames = 60;

    // Theme-aware palette — derives colors from global --brand-hue + dark mode
    const palette = { dot: '', line: '', dotHover: '' };
    const refreshPalette = () => {
      const isDark = document.documentElement.classList.contains('dark');
      const s = getComputedStyle(document.documentElement);
      const hue = s.getPropertyValue('--brand-hue').trim() || '85';
      if (isDark) {
        palette.dot = `oklch(0.78 0.12 ${hue} / 72%)`;
        palette.line = `oklch(0.78 0.12 ${hue} / 45%)`;
        palette.dotHover = `oklch(0.90 0.14 ${hue} / 95%)`;
      } else {
        palette.dot = `oklch(0.35 0.16 ${hue} / 85%)`;
        palette.line = `oklch(0.35 0.16 ${hue} / 60%)`;
        palette.dotHover = `oklch(0.55 0.20 ${hue} / 95%)`;
      }
    };
    refreshPalette();

    const themeObserver = new MutationObserver(refreshPalette);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Pointer tracking — used for star brightness AND constellation line reveal
    const pointer = { x: -1, y: -1, active: false };
    const GLOW_RADIUS = 150;
    const LINE_REVEAL_RADIUS = 200;
    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (px >= 0 && py >= 0 && px <= rect.width && py <= rect.height) {
        pointer.x = px;
        pointer.y = py;
        pointer.active = true;
      } else {
        pointer.active = false;
      }
    };
    const onPointerLeave = () => { pointer.active = false; };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onPointerLeave);

    const FADE_IN_FRAMES = 40; // ~2s at 50ms/frame

    const makeParticle = (width: number, height: number, connectable: boolean, preAged = false): Particle => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * (connectable ? nodeSpeed : starSpeed) * 2,
      vy: (Math.random() - 0.5) * (connectable ? nodeSpeed : starSpeed) * 2,
      radius: connectable ? 2 + Math.random() * 2 : 0.8 + Math.random() * 1.5,
      opacity: connectable ? 0.6 + Math.random() * 0.35 : 0.3 + Math.random() * 0.6,
      connectable,
      twinklePhase: Math.random() * Math.PI * 2,
      nudgeCountdown: 60 + Math.floor(Math.random() * 200),
      age: preAged ? FADE_IN_FRAMES : 0,
    });

    let prevWidth = 0;
    let prevHeight = 0;

    const setup = () => {
      const width = container.offsetWidth || window.innerWidth;
      const height = container.offsetHeight || window.innerHeight;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.scale(dpr, dpr);

      if (prevWidth > 0 && prevHeight > 0 && (width > prevWidth || height > prevHeight)) {
        const sx = width / prevWidth;
        const sy = height / prevHeight;
        for (const p of particles) {
          p.x *= sx;
          p.y *= sy;
        }
      }

      prevWidth = width;
      prevHeight = height;

      const kept = particles.filter(
        (p) => p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height,
      );
      const keptNodes = kept.filter((p) => p.connectable);
      const keptStars = kept.filter((p) => !p.connectable);

      const isInitial = particles.length === 0;
      const freshNodes = Array.from(
        { length: Math.max(0, nodeCount - keptNodes.length) },
        () => makeParticle(width, height, true, isInitial),
      );
      const freshStars = Array.from(
        { length: Math.max(0, starCount - keptStars.length) },
        () => makeParticle(width, height, false, isInitial),
      );

      particles = [...keptNodes, ...freshNodes, ...keptStars, ...freshStars];
    };

    const draw = () => {
      const width = container.offsetWidth || window.innerWidth;
      const height = container.offsetHeight || window.innerHeight;
      const dpr = window.devicePixelRatio || 1;

      const needW = Math.floor(width * dpr);
      const needH = Math.floor(height * dpr);
      if (canvas.width < needW || canvas.height < needH) {
        canvas.width = needW;
        canvas.height = needH;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.scale(dpr, dpr);
      }

      tick += 1;

      const dotColor = palette.dot;
      const lineColor = palette.line;
      const dotHover = palette.dotHover;

      context.globalAlpha = 1;
      context.clearRect(0, 0, width, height);

      // Update positions
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
        p.x = Math.max(0, Math.min(width, p.x));
        p.y = Math.max(0, Math.min(height, p.y));

        p.nudgeCountdown -= 1;
        if (p.nudgeCountdown <= 0) {
          const cap = p.connectable ? nodeSpeed : starSpeed;
          p.vx += (Math.random() - 0.5) * cap * 1.2;
          p.vy += (Math.random() - 0.5) * cap * 1.2;
          const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
          if (speed > cap) {
            p.vx = (p.vx / speed) * cap;
            p.vy = (p.vy / speed) * cap;
          }
          p.nudgeCountdown = 60 + Math.floor(Math.random() * 200);
        }

        if (Math.random() < 0.001) {
          p.connectable = !p.connectable;
          if (p.connectable) {
            p.radius = 2 + Math.random() * 2;
            const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 0.01;
            const scale = nodeSpeed / Math.max(speed, 0.01);
            p.vx *= scale;
            p.vy *= scale;
          } else {
            p.radius = 0.8 + Math.random() * 1.5;
            p.vx *= 0.2;
            p.vy *= 0.2;
          }
        }
      }

      // Update connections
      const inRangePairs = new Set<string>();
      const connectionCounts = new Uint8Array(totalCount);

      for (const [key, conn] of connections) {
        if (conn.strength < 0.3) continue;
        const [a, b] = key.split(':').map(Number);
        connectionCounts[a] += 1;
        connectionCounts[b] += 1;
      }

      for (let i = 0; i < particles.length; i += 1) {
        if (connectionCounts[i] >= maxConnectionsPerNode) continue;

        for (let j = i + 1; j < particles.length; j += 1) {
          if (connectionCounts[j] >= maxConnectionsPerNode) continue;
          if (!particles[i].connectable && !particles[j].connectable) continue;

          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < connectionDistance) {
            const key = `${i}:${j}`;
            inRangePairs.add(key);

            if (!connections.has(key)) {
              const proximity = 1 - dist / connectionDistance;
              let chance = 0.008 + proximity * 0.015;
              if (!particles[i].connectable || !particles[j].connectable) chance *= 0.5;
              if (Math.random() < chance) {
                connections.set(key, { strength: 0.05 });
                connectionCounts[i] += 1;
                connectionCounts[j] += 1;
              }
            }
          }
        }
      }

      // Fade connections in/out
      const activeEdges: Array<{ conn: { strength: number }; a: number; b: number }> = [];

      for (const [key, conn] of connections) {
        if (inRangePairs.has(key)) {
          conn.strength = Math.min(1, conn.strength + fadeInRate);
        } else {
          conn.strength -= fadeOutRate;
        }

        if (conn.strength <= 0.02) {
          connections.delete(key);
          continue;
        }

        const [a, b] = key.split(':').map(Number);
        if (!particles[a] || !particles[b]) { connections.delete(key); continue; }

        activeEdges.push({ conn, a, b });
      }

      // Draw edges — only visible near the cursor
      if (pointer.active) {
        for (const { conn, a, b } of activeEdges) {
          const pi = particles[a];
          const pj = particles[b];
          const midX = (pi.x + pj.x) / 2;
          const midY = (pi.y + pj.y) / 2;

          // Check if the midpoint of the edge is near the cursor
          const dxMid = midX - pointer.x;
          const dyMid = midY - pointer.y;
          const distMid = Math.sqrt(dxMid * dxMid + dyMid * dyMid);
          if (distMid > LINE_REVEAL_RADIUS) continue;

          const proximityFade = 1 - distMid / LINE_REVEAL_RADIUS;
          const dx = pi.x - pj.x;
          const dy = pi.y - pj.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const distAlpha = dist < connectionDistance ? 1 - dist / connectionDistance : 0.3;

          context.globalAlpha = Math.min(1, conn.strength * distAlpha * proximityFade * 2.5);
          context.strokeStyle = lineColor;
          context.lineWidth = 1.5;
          context.beginPath();
          context.moveTo(pi.x, pi.y);
          context.lineTo(pj.x, pj.y);
          context.stroke();
        }
      }

      // Draw particles as glowing dots
      for (const p of particles) {
        p.age = Math.min(p.age + 1, FADE_IN_FRAMES);
        const fadeIn = p.age / FADE_IN_FRAMES;

        let alpha = p.opacity;

        if (!p.connectable) {
          // Softer twinkle: range 0.5–1.0 instead of 0.3–1.0
          const twinkle = Math.sin(tick * 0.016 + p.twinklePhase);
          alpha = p.opacity * (0.5 + 0.5 * ((twinkle + 1) / 2));
        }

        alpha *= fadeIn;

        // Brighten stars near the cursor
        let color = dotColor;
        if (pointer.active) {
          const dx = p.x - pointer.x;
          const dy = p.y - pointer.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < GLOW_RADIUS) {
            const proximity = 1 - dist / GLOW_RADIUS;
            color = dotHover;
            alpha = Math.min(1, alpha + proximity * 0.7);
          }
        }

        drawGlowDot(context, p.x, p.y, p.radius, color, alpha);
      }

      // Shooting star
      if (!shootingStar && Math.random() < shootingStarChance) {
        const edge = Math.floor(Math.random() * 4);
        let sx: number, sy: number;
        if (edge === 0)      { sx = Math.random() * width;  sy = 0; }
        else if (edge === 1) { sx = width;                   sy = Math.random() * height; }
        else if (edge === 2) { sx = Math.random() * width;  sy = height; }
        else                 { sx = 0;                       sy = Math.random() * height; }

        const targetX = width * (0.3 + Math.random() * 0.4);
        const targetY = height * (0.3 + Math.random() * 0.4);
        const angle = Math.atan2(targetY - sy, targetX - sx) + (Math.random() - 0.5) * 0.6;
        const speed = 6 + Math.random() * 4;

        shootingStar = {
          x: sx, y: sy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: shootingStarFrames,
          maxLife: shootingStarFrames,
          tailLength: 60 + Math.random() * 40,
        };
      }

      if (shootingStar) {
        const s = shootingStar;
        s.x += s.vx;
        s.y += s.vy;
        s.life -= 1;

        const progress = 1 - s.life / s.maxLife;
        let alpha: number;
        if (progress < 0.2) alpha = progress / 0.2;
        else if (progress > 0.8) alpha = (1 - progress) / 0.2;
        else alpha = 1;

        const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
        const tailX = s.x - (s.vx / speed) * s.tailLength;
        const tailY = s.y - (s.vy / speed) * s.tailLength;

        // Glowing tail
        const grad = context.createLinearGradient(tailX, tailY, s.x, s.y);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(1, dotColor);

        context.globalAlpha = alpha * 0.9;
        context.strokeStyle = grad;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(tailX, tailY);
        context.lineTo(s.x, s.y);
        context.stroke();

        // Glowing head (same style as floating stars)
        drawGlowDot(context, s.x, s.y, 3, dotColor, alpha);

        if (s.life <= 0 || s.x < -100 || s.x > width + 100 || s.y < -100 || s.y > height + 100) {
          shootingStar = null;
        }
      }

      context.globalAlpha = 1;

      frameId = window.setTimeout(() => {
        animationFrame = window.requestAnimationFrame(draw);
      }, 50);
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

export default Constellations;
