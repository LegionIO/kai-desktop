import { useRef, useEffect, type FC } from 'react';
import { attachCanvasResizeFade } from '@/lib/canvasResizeFade';

const Constellation: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useConstellationCanvas()} className="absolute inset-0 h-full w-full" />
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
  spikes: number;
  rotation: number;
  twinklePhase: number;
  nudgeCountdown: number;
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, spikes: number, size: number, rotation: number) {
  const bodyRadius = size * 0.7;
  const spikeLength = size * 1.8;
  const spikeHalfWidth = Math.PI * 0.06;

  ctx.beginPath();
  ctx.arc(cx, cy, bodyRadius, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < spikes; i += 1) {
    const angle = rotation + (i * Math.PI * 2) / spikes;
    const tipX = cx + Math.cos(angle) * spikeLength;
    const tipY = cy + Math.sin(angle) * spikeLength;
    const baseX1 = cx + Math.cos(angle - spikeHalfWidth) * bodyRadius;
    const baseY1 = cy + Math.sin(angle - spikeHalfWidth) * bodyRadius;
    const baseX2 = cx + Math.cos(angle + spikeHalfWidth) * bodyRadius;
    const baseY2 = cy + Math.sin(angle + spikeHalfWidth) * bodyRadius;

    ctx.beginPath();
    ctx.moveTo(baseX1, baseY1);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(baseX2, baseY2);
    ctx.closePath();
    ctx.fill();
  }
}

function useConstellationCanvas() {
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

    const nodeCount = 35;
    const starCount = 1200;
    const totalCount = nodeCount + starCount;
    const connectionDistance = 160;
    const maxConnectionsPerNode = 3;
    const nodeSpeed = 0.35;
    const starSpeed = 0.06;

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
    const shootingStarFrames = 38;

    // Theme-aware palette
    const palette = { dot: '', line: '' };
    const refreshPalette = () => {
      const s = getComputedStyle(document.documentElement);
      palette.dot = s.getPropertyValue('--app-constellation-dot').trim() || 'rgba(160, 160, 160, 0.5)';
      palette.line = s.getPropertyValue('--app-constellation-line').trim() || 'rgba(160, 160, 160, 0.18)';
    };
    refreshPalette();

    const themeObserver = new MutationObserver(refreshPalette);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const makeParticle = (width: number, height: number, connectable: boolean): Particle => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * (connectable ? nodeSpeed : starSpeed) * 2,
      vy: (Math.random() - 0.5) * (connectable ? nodeSpeed : starSpeed) * 2,
      radius: connectable ? 2.5 + Math.random() * 2.5 : 1.2 + Math.random() * 2,
      opacity: connectable ? 0.6 + Math.random() * 0.35 : 0.3 + Math.random() * 0.6,
      connectable,
      spikes: 3 + Math.floor(Math.random() * 4),
      rotation: Math.random() * Math.PI * 2,
      twinklePhase: Math.random() * Math.PI * 2,
      nudgeCountdown: 60 + Math.floor(Math.random() * 200),
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

      const freshNodes = Array.from(
        { length: Math.max(0, nodeCount - keptNodes.length) },
        () => makeParticle(width, height, true),
      );
      const freshStars = Array.from(
        { length: Math.max(0, starCount - keptStars.length) },
        () => makeParticle(width, height, false),
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

      context.globalAlpha = 1;
      context.clearRect(0, 0, width, height);

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

        p.rotation += p.connectable ? 0.003 : 0.006;

        if (Math.random() < 0.001) {
          p.connectable = !p.connectable;
          if (p.connectable) {
            p.radius = 2.5 + Math.random() * 2.5;
            const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 0.01;
            const scale = nodeSpeed / Math.max(speed, 0.01);
            p.vx *= scale;
            p.vy *= scale;
          } else {
            p.radius = 1.2 + Math.random() * 2;
            p.vx *= 0.2;
            p.vy *= 0.2;
          }
        }
      }

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

      const neighbors = new Map<number, Set<number>>();
      const activeEdges: Array<{ key: string; conn: { strength: number }; a: number; b: number }> = [];

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

        activeEdges.push({ key, conn, a, b });

        if (conn.strength > 0.3) {
          if (!neighbors.has(a)) neighbors.set(a, new Set());
          if (!neighbors.has(b)) neighbors.set(b, new Set());
          neighbors.get(a)!.add(b);
          neighbors.get(b)!.add(a);
        }
      }

      const loopEdges = new Set<string>();
      for (const { key, a, b } of activeEdges) {
        const aN = neighbors.get(a);
        const bN = neighbors.get(b);
        if (!aN || !bN) continue;
        for (const n of aN) {
          if (n !== b && bN.has(n)) {
            loopEdges.add(key);
            const minAn = Math.min(a, n);
            const maxAn = Math.max(a, n);
            const minBn = Math.min(b, n);
            const maxBn = Math.max(b, n);
            loopEdges.add(`${minAn}:${maxAn}`);
            loopEdges.add(`${minBn}:${maxBn}`);
            break;
          }
        }
      }

      const pulse = 0.7 + 0.3 * Math.sin(tick * 0.08);
      for (const { key, conn, a, b } of activeEdges) {
        const pi = particles[a];
        const pj = particles[b];
        const dx = pi.x - pj.x;
        const dy = pi.y - pj.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const distAlpha = dist < connectionDistance ? 1 - dist / connectionDistance : 0.3;
        const isLoop = loopEdges.has(key);

        context.globalAlpha = Math.min(1, conn.strength * distAlpha * (isLoop ? pulse : 1));
        context.strokeStyle = lineColor;
        context.lineWidth = isLoop ? 2 : 1.2;
        context.beginPath();
        context.moveTo(pi.x, pi.y);
        context.lineTo(pj.x, pj.y);
        context.stroke();
      }

      context.fillStyle = dotColor;
      for (const p of particles) {
        let alpha = p.opacity;

        if (!p.connectable) {
          const twinkle = Math.sin(tick * 0.04 + p.twinklePhase);
          alpha = p.opacity * (0.3 + 0.7 * ((twinkle + 1) / 2));
        }

        context.globalAlpha = alpha;
        drawStar(context, p.x, p.y, p.spikes, p.radius, p.rotation);
        context.fill();
      }

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
        const speed = 12 + Math.random() * 8;

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

        const tailX = s.x - (s.vx / Math.sqrt(s.vx * s.vx + s.vy * s.vy)) * s.tailLength;
        const tailY = s.y - (s.vy / Math.sqrt(s.vx * s.vx + s.vy * s.vy)) * s.tailLength;

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

        context.globalAlpha = alpha;
        context.fillStyle = dotColor;
        context.beginPath();
        context.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
        context.fill();

        if (s.life <= 0 || s.x < -100 || s.x > width + 100 || s.y < -100 || s.y > height + 100) {
          shootingStar = null;
        }
      }

      context.globalAlpha = 1;

      frameId = window.setTimeout(() => {
        animationFrame = window.requestAnimationFrame(draw);
      }, 130);
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
      themeObserver.disconnect();
    };
  }, []);

  return canvasRef;
}

export default Constellation;
