/**
 * Generates the DMG installer background image.
 *
 * Usage:  node --import tsx scripts/generate-dmg-background.ts
 *         (automatically called by `pnpm build:mac`)
 *
 * Renders an SVG to a PNG using sharp at the DMG window's native size
 * (660×400). electron-builder uses the PNG's pixel dimensions to size the
 * installer window, so this must match `dmg.window.{width,height}` in
 * electron-builder.template.yml.
 *
 * Design: a rounded-corner amber arrow on a light background, with a warm
 * radial halo behind it and a soft drop shadow. The light backdrop keeps
 * the dark Kai icon legible when composited on top.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outputPath = resolve(root, 'build', 'dmg-background.png');

// Render at the DMG window's native size — must match dmg.window in
// electron-builder.template.yml.
const PX_W = 660;
const PX_H = 400;

// Icon positions (must match electron-builder contents[].x/y in the
// template; window is 660×400).
const APP_X = 180;
const APP_Y = 200;
const LINK_X = 480;

// ── Arrow geometry (rounded-corner block arrow) ──
const CX = (APP_X + LINK_X) / 2;
const CY = APP_Y - 10;

const SHAFT_W = 58;
const SHAFT_H = 22;
const HEAD_W = 32;
const HEAD_H = 42;
const R = 11;

const TOTAL_W = SHAFT_W + HEAD_W;

// Arrow corners (before rounding):
//   A = left edge, top of shaft       B = right edge of shaft, top of shaft
//   C = right edge of shaft, top of arrowhead    D = tip of arrow
//   E = right edge of shaft, bottom of arrowhead F = right edge of shaft, bottom of shaft
//   G = left edge, bottom of shaft
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
// For each corner, pull back by R along the incoming edge and push forward by R
// along the outgoing edge, with the actual corner point as the control point.
function roundedArrowPath(): string {
  function towards(from: { x: number; y: number }, to: { x: number; y: number }, d: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const ratio = d / len;
    return { x: from.x + dx * ratio, y: from.y + dy * ratio };
  }

  const r = R;
  const tipR = r * 0.6;

  const a1 = towards(A, G, r);
  const a2 = towards(A, B, r);
  const b1 = towards(B, A, r);
  const b2 = towards(B, C, r);
  const c1 = towards(C, B, r);
  const c2 = towards(C, D, r);
  const d1 = towards(D, C, tipR);
  const d2 = towards(D, E, tipR);
  const e1 = towards(E, D, r);
  const e2 = towards(E, F, r);
  const f1 = towards(F, E, r);
  const f2 = towards(F, G, r);
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

// ── Palette tuned to the Kai icon's gold spokes ──
const GOLD_MID = '#d7aa2d';
const GOLD_BRIGHT = '#f0cd55';
const GOLD_HIGH = '#ffeb91';
const HALO = '#ffd764';

// Bright source for the radial wash inside the arrow — slightly behind the tip.
const WASH_CX = CX + 6;
const WASH_CY = CY;
const WASH_R = TOTAL_W * 0.85;

// Drop-shadow offset
const SHADOW_DX = 3;
const SHADOW_DY = 5;

// Tight halo geometry — a single solid disc gets blurred for a smooth,
// band-free glow (multi-stop radial gradients render as visible rings at
// this resolution).
const HALO_R = 70;

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${PX_W}" height="${PX_H}" viewBox="0 0 ${PX_W} ${PX_H}">
  <defs>
    <!-- Radial wash inside the arrow body -->
    <radialGradient id="arrowWash" cx="${WASH_CX}" cy="${WASH_CY}" r="${WASH_R}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="${GOLD_HIGH}"/>
      <stop offset="30%"  stop-color="${GOLD_BRIGHT}"/>
      <stop offset="100%" stop-color="${GOLD_MID}"/>
    </radialGradient>

    <!-- Heavy blur for the halo — turns a solid disc into a smooth glow -->
    <filter id="haloBlur" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>

    <!-- Soft drop shadow -->
    <filter id="dropShadow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="5"/>
    </filter>
  </defs>

  <!-- Light background -->
  <rect width="${PX_W}" height="${PX_H}" fill="#eeeeee"/>

  <!-- Smooth warm halo: a solid amber disc, heavily blurred -->
  <g filter="url(#haloBlur)">
    <circle cx="${CX + 4}" cy="${CY}" r="${HALO_R}" fill="${HALO}" fill-opacity="0.45"/>
  </g>

  <!-- Drop shadow -->
  <g filter="url(#dropShadow)" transform="translate(${SHADOW_DX} ${SHADOW_DY})">
    <path d="${arrowPath}" fill="#2a1a00" fill-opacity="0.55"/>
  </g>

  <!-- Arrow body -->
  <path d="${arrowPath}" fill="url(#arrowWash)"/>
</svg>
`;

async function main() {
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  console.info(`[generate-dmg-background] Generated ${outputPath} (${PX_W}×${PX_H})`);
}

main();
