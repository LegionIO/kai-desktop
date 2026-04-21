import { useRef, useEffect, type FC } from 'react';

const Smokescreen: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <canvas ref={useSmokescreenCanvas()} className="absolute inset-0 h-full w-full" />
  </div>
);

export default Smokescreen;

/* ── WebGL: volumetric smoke with cursor backlight ───────────────────────── */

const VERTEX_SOURCE = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

/*
 * The mental model: a dark room filled with drifting smoke.  The cursor is a
 * warm yellow light source sitting just *behind* the smoke plane.  Where
 * smoke is thin the light scatters through — bright, translucent, glowing
 * edges.  Where smoke is thick the light is absorbed — dark silhouettes.
 * Where there's no smoke AND no light it's just the dark background.
 *
 * Smoke is modelled as accumulated density from multiple ray-march-style
 * samples through layered noise at different depths (front to back).  Each
 * layer has independent drift so they slide past each other, giving parallax.
 *
 * The light uses Beer-Lambert absorption: transmittance = exp(-density).
 * Thin regions transmit most light (bright), thick regions absorb it (dark).
 */
const FRAGMENT_SOURCE = `
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform vec3  u_glow_color;
uniform float u_is_dark;

// ── simplex noise ──────────────────────────────────────────────────────

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                            + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x * x0.x   + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// ── fbm with rotation between octaves (prevents grid alignment) ────────

mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);   // ~37° rotation

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) {
    v += a * snoise(p);
    p = rot * p * 2.0 + vec2(100.0);
    a *= 0.5;
  }
  return v;
}

// ── single smoke density sample at a "depth" layer ─────────────────────

float smokeDensity(vec2 p, float t, float depth) {
  // Large unique offset per layer — breaks bilateral symmetry
  p += vec2(depth * 7.3 + 2.1, depth * 5.7 - 3.4);

  // Each layer orbits at its own speed / phase
  float layerPhase = depth * 4.1 + 0.7;
  float orbitSpeed = 0.11 + depth * 0.03;
  p += vec2(
    sin(t * orbitSpeed + layerPhase) * 0.35 + cos(t * orbitSpeed * 0.6 + layerPhase * 2.1) * 0.2,
    cos(t * orbitSpeed * 0.9 + layerPhase * 1.7) * 0.3 + sin(t * orbitSpeed * 1.3 + layerPhase * 0.4) * 0.2
  );

  p += vec2(t * 0.02, t * 0.012);

  // Two independent warp angles for x and y — prevents mirrored shapes
  float warpA = fbm(p * 0.6 + vec2(depth * 3.0, 0.0)) * 3.14159 + t * 0.09;
  float warpB = fbm(p * 0.6 + vec2(0.0, depth * 4.2 + 8.0)) * 3.14159 + t * 0.07;
  float warpStrength = 0.45 + depth * 0.1;
  p += vec2(cos(warpA), sin(warpB)) * warpStrength;

  float n = fbm(p * (1.0 + depth * 0.3));
  n = n * 0.5 + 0.5;

  return smoothstep(0.35, 0.65, n);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 asp = vec2(aspect, 1.0);

  float t = u_time;

  // ── Radial vignette (fade to transparent at edges) ────────────
  float radialDist = length((uv - 0.5) * asp);
  float radialAlpha = 1.0 - smoothstep(0.35, 0.75, radialDist);

  // ── Volumetric smoke: march through 5 depth layers ────────────
  //
  // Accumulate density front-to-back.  Each layer is a thin slice of
  // the smoke volume with its own drift, scale, and density.
  //
  vec2 coord = uv * asp;
  float totalDensity = 0.0;

  for (int i = 0; i < 5; i++) {
    float depth = float(i) * 0.2;
    float d = smokeDensity(coord * (1.2 + depth * 0.15), t, depth);

    // Front layers are thinner (wispy foreground), back layers thicker
    float layerWeight = 0.15 + depth * 0.08;
    totalDensity += d * layerWeight;
  }
  totalDensity = clamp(totalDensity, 0.0, 1.0);

  // ── Cursor glow (illuminates nearby smoke) ─────────────────────
  //
  // No spotlight cone — the cursor just makes nearby smoke glow
  // more brightly with the gold color.  The effect is proximity-
  // based: smooth falloff, no visible circle.
  //
  vec2 mouseUV = u_mouse / u_resolution;
  float mouseDist = length((uv - mouseUV) * asp);

  // Smooth proximity — no hard spotlight edge
  float proximity = 1.0 / (1.0 + mouseDist * mouseDist * 35.0);

  // Thicker smoke glows more
  float glowAmount = proximity * totalDensity * 1.8;

  // ── Compose final pixel ───────────────────────────────────────

  float baseSmokeVis = totalDensity * mix(0.70, 1.0, u_is_dark);

  // Light mode: bright golden smoke, cursor casts a dark shadow onto it
  // Dark mode: grey smoke, cursor adds gold glow
  vec3 smokeColor = mix(
    vec3(0.55, 0.42, 0.18),     // light mode: warm golden-brown
    vec3(0.38),                  // dark mode: neutral grey
    u_is_dark
  );
  vec3 smokeBase = smokeColor * baseSmokeVis;

  // Cursor interaction
  // Light: darken toward near-black where cursor touches thick smoke
  float shadow = proximity * smoothstep(0.02, 0.25, totalDensity) * mix(1.0, 0.0, u_is_dark);
  vec3 shadowColor = mix(vec3(0.0), smokeBase, 1.0 - shadow);

  // Dark: additive gold glow
  vec3 litSmoke = u_glow_color * glowAmount * mix(0.0, 1.2, u_is_dark);

  vec3 color = mix(shadowColor, smokeBase, u_is_dark) + litSmoke;

  // Alpha: smoke density + radial vignette.
  // In light mode, boost alpha where shadow is active so black reads as
  // true black instead of grey (the canvas is transparent over a light bg).
  float shadowAlphaBoost = shadow * mix(0.6, 0.0, u_is_dark);
  float alpha = clamp(baseSmokeVis + shadowAlphaBoost, 0.0, 1.0) * radialAlpha;

  // Premultiply
  color *= radialAlpha;

  gl_FragColor = vec4(color, alpha);
}
`;

/* ── OKLCh → linear sRGB ────────────────────────────────────────────────── */

function oklchToLinearRGB(l: number, c: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a_ = c * Math.cos(hRad);
  const b_ = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a_ + 0.2158037573 * b_;
  const m_ = l - 0.1055613458 * a_ - 0.0638541728 * b_;
  const s_ = l - 0.0894841775 * a_ - 1.2914855480 * b_;

  const lc = l_ * l_ * l_;
  const mc = m_ * m_ * m_;
  const sc = s_ * s_ * s_;

  const r = +4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const b = -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc;

  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

/* ── Hook ────────────────────────────────────────────────────────────────── */

function useSmokescreenCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const container = canvas.parentElement;
    if (!container) return;

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    function compileShader(type: number, source: string): WebGLShader | null {
      const shader = gl!.createShader(type);
      if (!shader) return null;
      gl!.shaderSource(shader, source);
      gl!.compileShader(shader);
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        console.warn('[Smokescreen] Shader compile error:', gl!.getShaderInfoLog(shader));
        gl!.deleteShader(shader);
        return null;
      }
      return shader;
    }

    const vertShader = compileShader(gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragShader = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    if (!vertShader || !fragShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[Smokescreen] Program link error:', gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const posAttr = gl.getAttribLocation(program, 'a_position');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posAttr);
    gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, 'u_time');
    const uResolution = gl.getUniformLocation(program, 'u_resolution');
    const uMouse = gl.getUniformLocation(program, 'u_mouse');
    const uGlowColor = gl.getUniformLocation(program, 'u_glow_color');
    const uIsDark = gl.getUniformLocation(program, 'u_is_dark');

    function isDarkMode(): boolean {
      return document.documentElement.classList.contains('dark');
    }

    function updateColors() {
      const dark = isDarkMode();

      // Light mode: dark amber/brown glow.  Dark mode: bright warm yellow.
      const [gr, gg, gb] = oklchToLinearRGB(
        dark ? 0.88 : 0.45,
        dark ? 0.19 : 0.12,
        dark ? 95 : 75,   // shift toward amber/brown in light mode
      );
      gl!.uniform3f(uGlowColor, gr, gg, gb);
      gl!.uniform1f(uIsDark, dark ? 1.0 : 0.0);
    }

    // ── Smooth mouse tracking ────────────────────────────────────
    let targetX = 0, targetY = 0;
    let smoothX = 0, smoothY = 0;
    let hasMouseInput = false;

    const handlePointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      targetX = (e.clientX - rect.left) * dpr;
      targetY = (rect.bottom - e.clientY) * dpr;
      hasMouseInput = true;
    };
    // Listen on window — the canvas container has pointer-events: none
    window.addEventListener('pointermove', handlePointerMove, { passive: true });

    let width = 0, height = 0;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = container!.getBoundingClientRect();
      width = Math.floor(rect.width * dpr);
      height = Math.floor(rect.height * dpr);
      canvas!.width = width;
      canvas!.height = height;
      gl!.viewport(0, 0, width, height);
      gl!.uniform2f(uResolution, width, height);

      if (!hasMouseInput) {
        // Park offscreen so no glow appears until the user hovers
        targetX = -9999.0;
        targetY = -9999.0;
        smoothX = targetX;
        smoothY = targetY;
      }
    }

    resize();
    updateColors();

    const ro = new ResizeObserver(() => { resize(); updateColors(); });
    ro.observe(container);

    const themeObserver = new MutationObserver(() => updateColors());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

    let frameId = 0;
    const startTime = performance.now();

    function render() {
      smoothX += (targetX - smoothX) * 0.04;
      smoothY += (targetY - smoothY) * 0.04;

      gl!.clearColor(0, 0, 0, 0);
      gl!.clear(gl!.COLOR_BUFFER_BIT);
      gl!.uniform1f(uTime, (performance.now() - startTime) / 1000);
      gl!.uniform2f(uMouse, smoothX, smoothY);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
      frameId = requestAnimationFrame(render);
    }

    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
      ro.disconnect();
      themeObserver.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      gl.deleteProgram(program);
      gl.deleteShader(vertShader);
      gl.deleteShader(fragShader);
      gl.deleteBuffer(buf);
    };
  }, []);

  return canvasRef;
}
