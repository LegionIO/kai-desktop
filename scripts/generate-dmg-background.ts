/**
 * Generates the DMG installer background image.
 *
 * Usage:  node --import tsx scripts/generate-dmg-background.ts
 *         (automatically called by `pnpm build:mac`)
 *
 * Renders an SVG to a Retina-resolution PNG using sharp.
 * The logical size is 660×400; the output is 1320×800 at 144 DPI.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outputPath = resolve(root, 'build', 'dmg-background.png');

// Logical dimensions (what macOS displays)
const WIDTH = 660;
const HEIGHT = 400;

// Retina multiplier
const SCALE = 2;
const PX_W = WIDTH * SCALE;
const PX_H = HEIGHT * SCALE;

// Icon positions (must match electron-builder contents[].x/y × SCALE)
const APP_X = 180 * SCALE;
const APP_Y = 200 * SCALE;
const LINK_X = 480 * SCALE;

// ── Arrow geometry ──
const CX = (APP_X + LINK_X) / 2;
const CY = APP_Y - 10 * SCALE;

// Arrow dimensions
const SHAFT_W = 28 * SCALE; // width of the shaft
const SHAFT_H = 11 * SCALE; // half-height of the shaft
const HEAD_W = 16 * SCALE; // how far the head extends beyond the shaft
const HEAD_H = 20 * SCALE; // half-height of the arrowhead
const R = 6 * SCALE; // corner radius for rounding

const TOTAL_W = SHAFT_W + HEAD_W;

// Build a rounded arrow as an SVG path.
// The arrow points right, centered at (CX, CY).
//
// Key points (before rounding):
//   A = left edge, top of shaft
//   B = right edge of shaft, top of shaft
//   C = right edge of shaft, top of arrowhead
//   D = tip of arrow
//   E = right edge of shaft, bottom of arrowhead
//   F = right edge of shaft, bottom of shaft
//   G = left edge, bottom of shaft
//
const LEFT = CX - TOTAL_W / 2;
const RIGHT_SHAFT = LEFT + SHAFT_W;
const RIGHT_TIP = CX + TOTAL_W / 2;

const A = { x: LEFT, y: CY - SHAFT_H };
const B = { x: RIGHT_SHAFT, y: CY - SHAFT_H };
const C = { x: RIGHT_SHAFT, y: CY - HEAD_H };
const D = { x: RIGHT_TIP, y: CY };
const E = { x: RIGHT_SHAFT, y: CY + HEAD_H };
const F = { x: RIGHT_SHAFT, y: CY + SHAFT_H };
const G = { x: LEFT, y: CY + SHAFT_H };

// Build the path with rounded corners using quadratic bezier curves at corners.
// For each corner, we pull back by R along the incoming edge and push forward by R
// along the outgoing edge, with the actual corner point as the control point.
function roundedArrowPath(): string {
  // Helper: move along a direction from a point by distance d
  function towards(from: { x: number; y: number }, to: { x: number; y: number }, d: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const ratio = d / len;
    return { x: from.x + dx * ratio, y: from.y + dy * ratio };
  }

  const r = R;

  // Corner A (top-left of shaft): rounded
  const a1 = towards(A, G, r); // coming from G toward A
  const a2 = towards(A, B, r); // going from A toward B

  // Corner B (top-right of shaft, where shaft meets head going up): rounded
  const b1 = towards(B, A, r);
  const b2 = towards(B, C, r);

  // Corner C (top of arrowhead): rounded
  const c1 = towards(C, B, r);
  const c2 = towards(C, D, r);

  // Corner D (tip): rounded with a tighter radius
  const tipR = r * 0.6;
  const d1 = towards(D, C, tipR);
  const d2 = towards(D, E, tipR);

  // Corner E (bottom of arrowhead): rounded
  const e1 = towards(E, D, r);
  const e2 = towards(E, F, r);

  // Corner F (bottom-right of shaft): rounded
  const f1 = towards(F, E, r);
  const f2 = towards(F, G, r);

  // Corner G (bottom-left of shaft): rounded
  const g1 = towards(G, F, r);
  const g2 = towards(G, A, r);

  return [
    `M ${a2.x},${a2.y}`,
    `L ${b1.x},${b1.y}`,
    `Q ${B.x},${B.y} ${b2.x},${b2.y}`,
    `L ${c1.x},${c1.y}`,
    `Q ${C.x},${C.y} ${c2.x},${c2.y}`,
    `L ${d1.x},${d1.y}`,
    `Q ${D.x},${D.y} ${d2.x},${d2.y}`,
    `L ${e1.x},${e1.y}`,
    `Q ${E.x},${E.y} ${e2.x},${e2.y}`,
    `L ${f1.x},${f1.y}`,
    `Q ${F.x},${F.y} ${f2.x},${f2.y}`,
    `L ${g1.x},${g1.y}`,
    `Q ${G.x},${G.y} ${g2.x},${g2.y}`,
    `L ${a1.x},${a1.y}`,
    `Q ${A.x},${A.y} ${a2.x},${a2.y}`,
    `Z`,
  ].join(' ');
}

const arrowPath = roundedArrowPath();

// Brand colors from Kai icon — warm amber/gold
const ACCENT = '#d4a912';
const ACCENT_DIM = '#8a6e0a';

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${PX_W}" height="${PX_H}" viewBox="0 0 ${PX_W} ${PX_H}">
  <defs>
    <!-- Dark background gradient -->
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1c1c1c"/>
      <stop offset="100%" stop-color="#111111"/>
    </linearGradient>

    <!-- Subtle radial glow behind center -->
    <radialGradient id="glow" cx="50%" cy="48%" r="35%">
      <stop offset="0%" stop-color="${ACCENT_DIM}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${ACCENT_DIM}" stop-opacity="0"/>
    </radialGradient>

    <!-- Left-to-right fade gradient for the arrow -->
    <linearGradient id="arrowFade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.05"/>
      <stop offset="50%" stop-color="${ACCENT}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0.35"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${PX_W}" height="${PX_H}" fill="url(#bg)"/>

  <!-- Subtle warm glow in center -->
  <rect width="${PX_W}" height="${PX_H}" fill="url(#glow)"/>

  <!-- Filled arrow with rounded corners and gradient fade -->
  <path d="${arrowPath}" fill="url(#arrowFade)"/>
</svg>
`;

async function main() {
  await sharp(Buffer.from(svg))
    .png()
    .toFile(outputPath);

  console.info(`[generate-dmg-background] Generated ${outputPath} (${PX_W}×${PX_H})`);
}

main();
