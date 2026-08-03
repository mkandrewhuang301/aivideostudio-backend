// src/config/adjustmentLut.ts
//
// Turns a set of adjustment PARAMETERS into a 3D LUT.
//
// Studio Filters avoided the parity problem by never having parameters: a look IS a .cube file, so
// iOS preview, iOS export and this server's ffmpeg all read identical bytes and cannot disagree.
// Adjustments are parameters by definition, which walks straight back into that trap — a CoreImage
// chain and an ffmpeg `eq`/`colorbalance` chain do NOT converge (they differ on gamma, on clipping,
// and on what "saturation" means), so hand-matching them produces exports that silently stop
// matching previews.
//
// The resolution: do not apply adjustments as image operations on either side. Compile them into a
// table here, and feed that table through the machinery filters already use. Parity then reduces to
// "do two implementations agree on arithmetic over 4913 grid points", which is exactly testable,
// instead of "do two image pipelines agree on pixels", which is not.
//
// ⚠️ THE SWIFT PORT IN `AdjustmentLUT.swift` MUST STAY BYTE-IDENTICAL TO THIS FILE.
// Every operation below is plain float arithmetic in a fixed order for that reason. If you change
// a formula, a constant, or the ORDER, change both sides in the same commit and re-run the parity
// test — the failure mode is not a crash, it is a preview that quietly disagrees with the export.

export interface Adjustments {
  /** -1…1, 0 = unchanged. Linear lift/drop of the whole range. */
  brightness?: number;
  /** -1…1, 0 = unchanged. Multiplier around a 0.5 pivot. */
  contrast?: number;
  /** -1…1, 0 = unchanged. -1 is fully greyscale. */
  saturation?: number;
  /** -1…1, 0 = unchanged. Positive warms (R up, B down). */
  temperature?: number;
  /** -1…1, 0 = unchanged. Positive pushes magenta, negative green. */
  tint?: number;
  /** -1…1, 0 = unchanged. Rotates hue; ±1 is a half turn. */
  hue?: number;
  /** -1…1, 0 = unchanged. Acts on the top of the range only. */
  highlights?: number;
  /** -1…1, 0 = unchanged. Acts on the bottom of the range only. */
  shadows?: number;
  /** -1…1, 0 = unchanged. Moves the white point. */
  whites?: number;
  /** -1…1, 0 = unchanged. Moves the black point. */
  blacks?: number;
  /** 0…1, 0 = unchanged. Lifts the black floor — the matte/film wash. */
  fade?: number;
}

/** The cube edge length. MUST match the filter pack (`LUT_3D_SIZE 17`) and the Swift port. */
export const ADJUSTMENT_CUBE_SIZE = 17;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// Rec.709 luma — the same coefficients CoreImage, ffmpeg and generate-filter-luts.mjs all use.
const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Is this adjustment set a no-op? Used to skip the whole pass rather than pay for an identity
 * table, mirroring how zero-intensity filters are skipped on both sides.
 */
export function isIdentityAdjustment(a: Adjustments): boolean {
  const keys: (keyof Adjustments)[] = [
    'brightness', 'contrast', 'saturation', 'temperature', 'tint',
    'hue', 'highlights', 'shadows', 'whites', 'blacks', 'fade',
  ];
  return keys.every((k) => (a[k] ?? 0) === 0);
}

/**
 * Applies the full adjustment stack to ONE rgb triple.
 *
 * ORDER IS PART OF THE CONTRACT — these operations do not commute. White balance happens on the
 * original colour, tonal moves happen before saturation (so saturating does not amplify a
 * brightness clip), and fade is last because it defines the final black floor.
 *
 *   temperature/tint -> hue -> blacks/whites -> shadows/highlights
 *     -> brightness -> contrast -> saturation -> fade
 */
export function applyAdjustments(
  r0: number,
  g0: number,
  b0: number,
  a: Adjustments,
): [number, number, number] {
  let r = r0;
  let g = g0;
  let b = b0;

  // ── white balance ─────────────────────────────────────────────────────────
  const temperature = a.temperature ?? 0;
  if (temperature !== 0) {
    r = clamp01(r + temperature * 0.10);
    b = clamp01(b - temperature * 0.10);
  }
  const tint = a.tint ?? 0;
  if (tint !== 0) {
    r = clamp01(r + tint * 0.05);
    g = clamp01(g - tint * 0.05);
    b = clamp01(b + tint * 0.05);
  }

  // ── hue rotation ──────────────────────────────────────────────────────────
  // Rotation about the luma axis in RGB, the standard YIQ-style matrix. Written out rather than
  // converting to HSL and back: fewer branches, and branchless code is far easier to port exactly.
  const hue = a.hue ?? 0;
  if (hue !== 0) {
    const angle = hue * Math.PI;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const m00 = 0.213 + cosA * 0.787 - sinA * 0.213;
    const m01 = 0.715 - cosA * 0.715 - sinA * 0.715;
    const m02 = 0.072 - cosA * 0.072 + sinA * 0.928;
    const m10 = 0.213 - cosA * 0.213 + sinA * 0.143;
    const m11 = 0.715 + cosA * 0.285 + sinA * 0.140;
    const m12 = 0.072 - cosA * 0.072 - sinA * 0.283;
    const m20 = 0.213 - cosA * 0.213 - sinA * 0.787;
    const m21 = 0.715 - cosA * 0.715 + sinA * 0.715;
    const m22 = 0.072 + cosA * 0.928 + sinA * 0.072;
    const nr = r * m00 + g * m01 + b * m02;
    const ng = r * m10 + g * m11 + b * m12;
    const nb = r * m20 + g * m21 + b * m22;
    r = clamp01(nr);
    g = clamp01(ng);
    b = clamp01(nb);
  }

  // ── black / white point ───────────────────────────────────────────────────
  const blacks = a.blacks ?? 0;
  const whites = a.whites ?? 0;
  if (blacks !== 0 || whites !== 0) {
    const lo = blacks * 0.25;
    const hi = 1 + whites * 0.25;
    const span = hi - lo;
    if (span > 1e-6) {
      r = clamp01((r - lo) / span);
      g = clamp01((g - lo) / span);
      b = clamp01((b - lo) / span);
    }
  }

  // ── shadows / highlights ──────────────────────────────────────────────────
  // Weighted by where the pixel sits, so each control touches its own end of the range. The
  // weights are plain polynomials for portability.
  const shadows = a.shadows ?? 0;
  if (shadows !== 0) {
    const w = (v: number) => (1 - v) * (1 - v);
    r = clamp01(r + shadows * 0.30 * w(r));
    g = clamp01(g + shadows * 0.30 * w(g));
    b = clamp01(b + shadows * 0.30 * w(b));
  }
  const highlights = a.highlights ?? 0;
  if (highlights !== 0) {
    const w = (v: number) => v * v;
    r = clamp01(r + highlights * 0.30 * w(r));
    g = clamp01(g + highlights * 0.30 * w(g));
    b = clamp01(b + highlights * 0.30 * w(b));
  }

  // ── brightness ────────────────────────────────────────────────────────────
  const brightness = a.brightness ?? 0;
  if (brightness !== 0) {
    r = clamp01(r + brightness * 0.25);
    g = clamp01(g + brightness * 0.25);
    b = clamp01(b + brightness * 0.25);
  }

  // ── contrast ──────────────────────────────────────────────────────────────
  const contrast = a.contrast ?? 0;
  if (contrast !== 0) {
    const amount = 1 + contrast;
    r = clamp01(0.5 + (r - 0.5) * amount);
    g = clamp01(0.5 + (g - 0.5) * amount);
    b = clamp01(0.5 + (b - 0.5) * amount);
  }

  // ── saturation ────────────────────────────────────────────────────────────
  const saturation = a.saturation ?? 0;
  if (saturation !== 0) {
    const amount = 1 + saturation;
    const l = luma(r, g, b);
    r = clamp01(l + (r - l) * amount);
    g = clamp01(l + (g - l) * amount);
    b = clamp01(l + (b - l) * amount);
  }

  // ── fade ──────────────────────────────────────────────────────────────────
  const fade = a.fade ?? 0;
  if (fade !== 0) {
    r = clamp01(r + fade * 0.20 * (1 - r));
    g = clamp01(g + fade * 0.20 * (1 - g));
    b = clamp01(b + fade * 0.20 * (1 - b));
  }

  return [r, g, b];
}

/**
 * Emits a `.cube` file body for `adjustments`. Row order is red-fastest, then green, then blue —
 * the .cube spec's own ordering, and what both `lut3d` and `CIColorCubeWithColorSpace` expect.
 */
export function buildAdjustmentCube(adjustments: Adjustments): string {
  const n = ADJUSTMENT_CUBE_SIZE;
  const lines: string[] = [
    '# Generated from adjustment parameters — do not edit by hand.',
    `LUT_3D_SIZE ${n}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ];
  for (let bi = 0; bi < n; bi++) {
    for (let gi = 0; gi < n; gi++) {
      for (let ri = 0; ri < n; ri++) {
        const [r, g, b] = applyAdjustments(
          ri / (n - 1),
          gi / (n - 1),
          bi / (n - 1),
          adjustments,
        );
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}
