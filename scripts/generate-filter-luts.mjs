#!/usr/bin/env node
// Generates the Studio filter pack as .cube 3D LUTs.
//
// WHY LUTs: a filter has to look identical in three places — the iOS live preview (CoreImage),
// the iOS on-device export (CoreImage, via the custom compositor), and the cloud compose
// (ffmpeg). Hand-matching CoreImage filter chains against ffmpeg filter chains is a losing game;
// they disagree on gamma, on clipping, and on the exact meaning of "saturation". A 3D LUT is just
// a lookup table, so `CIColorCubeWithColorSpace` and ffmpeg's `lut3d` produce the same pixels by
// construction. Both sides read the SAME generated files.
//
// The grades below are parametric and generated here rather than sourced from a third-party LUT
// pack, so the look is ours to tune and there is no license question about redistributing them
// inside the app bundle.
//
// Run: node scripts/generate-filter-luts.mjs
// Output: assets/luts/<id>.cube  (also copy into the iOS bundle — see scripts/sync-luts-to-ios.sh)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'luts');

// 17 points per axis = 4913 entries (~100KB of text per file). The grades here are smooth
// analytic functions, so tetrahedral interpolation over 17 points is visually identical to the
// conventional 33 while keeping the iOS bundle ~1.5MB instead of ~11MB for the whole pack.
const SIZE = 17;

// ─── grade primitives ────────────────────────────────────────────────────────
// Everything operates on linear-ish [0,1] RGB triples. These are deliberately simple and
// closed-form: the LUT bakes the result, so there is no runtime cost to stacking them.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Rec.709 luma — the same coefficients CoreImage and ffmpeg use for video.
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const mix = (a, b, t) => a + (b - a) * t;

/** Per-channel multiply. Used for white balance and channel-level tinting. */
const gain = (rgb, [gr, gg, gb]) => [rgb[0] * gr, rgb[1] * gg, rgb[2] * gb];

/** Raises/lowers the black floor without touching white. `amount` > 0 fades the blacks. */
const lift = (rgb, amount) => rgb.map((v) => v + amount * (1 - v));

/** Standard power curve. `g` > 1 brightens midtones, < 1 darkens them. */
const gamma = (rgb, g) => rgb.map((v) => Math.pow(clamp01(v), 1 / g));

/** Contrast around a 0.5 pivot. `amount` is a multiplier: 1 = unchanged. */
const contrast = (rgb, amount, pivot = 0.5) =>
  rgb.map((v) => clamp01(pivot + (v - pivot) * amount));

/**
 * Smooth filmic S-curve. Unlike a linear contrast multiply this rolls off rather than clipping,
 * which is what keeps highlights from turning into flat white patches on bright AI footage.
 */
const sCurve = (rgb, strength) =>
  rgb.map((v) => {
    const x = clamp01(v);
    const s = x * x * (3 - 2 * x); // smoothstep
    return clamp01(mix(x, s, strength));
  });

/** `amount` 0 = greyscale, 1 = unchanged, > 1 = more saturated. */
const saturate = (rgb, amount) => {
  const l = luma(rgb);
  return rgb.map((v) => clamp01(l + (v - l) * amount));
};

/**
 * Tints shadows and highlights toward two different colors — the core move behind most
 * "cinematic" looks (cool shadows, warm skin).
 */
const splitTone = (rgb, shadowTint, highlightTint, amount) => {
  const l = luma(rgb);
  return rgb.map((v, i) => {
    const shadow = shadowTint[i] * (1 - l);
    const highlight = highlightTint[i] * l;
    return clamp01(v + amount * (shadow + highlight));
  });
};

/** Pushes everything toward a single hue — the sepia/monochrome-tint move. */
const toneMap = (rgb, tint, amount) => {
  const l = luma(rgb);
  return rgb.map((v, i) => clamp01(mix(v, l * tint[i], amount)));
};

// ─── the catalog ─────────────────────────────────────────────────────────────
// `category` drives the chip row in the iOS picker sheet. `name` is what the user sees, on the
// thumbnail and on the timeline pill.

const FILTERS = [
  // Featured — the safe, broadly-flattering looks that lead the grid.
  {
    id: 'clean',
    name: 'Clean',
    category: 'featured',
    grade: (c) => saturate(sCurve(c, 0.18), 1.08),
  },
  {
    id: 'vivid',
    name: 'Vivid',
    category: 'featured',
    grade: (c) => saturate(contrast(sCurve(c, 0.25), 1.12), 1.35),
  },
  {
    id: 'warm',
    name: 'Warm',
    category: 'featured',
    grade: (c) => saturate(gain(sCurve(c, 0.15), [1.08, 1.01, 0.92]), 1.06),
  },
  {
    id: 'cool',
    name: 'Cool',
    category: 'featured',
    grade: (c) => saturate(gain(sCurve(c, 0.15), [0.93, 1.0, 1.1]), 1.04),
  },

  // Mono — greyscale variants. Kept in their own chip because users look for them by name.
  {
    id: 'noir',
    name: 'Noir',
    category: 'mono',
    // A lift BEFORE the curve is what keeps this readable. Without it, dark source footage —
    // which most AI night/interior generations are — collapses to a flat black silhouette and
    // the filter reads as broken rather than moody.
    grade: (c) => contrast(saturate(sCurve(lift(c, 0.05), 0.22), 0), 1.12),
  },
  {
    id: 'mono',
    name: 'Mono',
    category: 'mono',
    grade: (c) => lift(saturate(c, 0), 0.06),
  },
  {
    id: 'sepia',
    name: 'Sepia',
    category: 'mono',
    grade: (c) => toneMap(sCurve(c, 0.2), [1.18, 0.98, 0.72], 1),
  },
  {
    id: 'silver',
    name: 'Silver',
    category: 'mono',
    grade: (c) => toneMap(contrast(c, 1.15), [0.94, 0.99, 1.1], 1),
  },

  // Film — emulsion-flavoured grades. Lifted blacks are the shared signature.
  {
    id: 'film35',
    name: 'Film 35',
    category: 'film',
    grade: (c) =>
      splitTone(
        saturate(lift(sCurve(c, 0.22), 0.05), 0.92),
        [0.0, 0.01, 0.05],
        [0.05, 0.02, -0.02],
        0.6,
      ),
  },
  {
    id: 'faded',
    name: 'Faded',
    category: 'film',
    grade: (c) => saturate(contrast(lift(c, 0.14), 0.86), 0.82),
  },
  {
    id: 'kodak',
    name: 'Kodak',
    category: 'film',
    grade: (c) =>
      splitTone(
        saturate(gain(sCurve(c, 0.2), [1.06, 1.0, 0.95]), 1.12),
        [-0.01, 0.0, 0.06],
        [0.07, 0.03, -0.03],
        0.7,
      ),
  },
  {
    id: 'portra',
    name: 'Portra',
    category: 'film',
    grade: (c) =>
      splitTone(saturate(lift(gamma(c, 1.06), 0.08), 0.88), [0.02, 0.0, 0.03], [0.06, 0.03, 0.0], 0.5),
  },

  // Cinematic — the heavier, more opinionated grades.
  {
    id: 'tealorange',
    name: 'Teal & Orange',
    category: 'cinematic',
    grade: (c) =>
      splitTone(saturate(sCurve(c, 0.3), 1.1), [-0.04, 0.01, 0.1], [0.1, 0.02, -0.06], 1),
  },
  {
    id: 'bleach',
    name: 'Bleach',
    category: 'cinematic',
    grade: (c) => contrast(saturate(sCurve(lift(c, 0.07), 0.28), 0.4), 1.12),
  },
  {
    id: 'midnight',
    name: 'Midnight',
    category: 'cinematic',
    grade: (c) =>
      splitTone(saturate(gamma(contrast(lift(c, 0.06), 1.05), 0.95), 0.9), [-0.02, 0.0, 0.1], [0.0, 0.01, 0.05], 1),
  },
  {
    id: 'noirblue',
    name: 'Noir Blue',
    category: 'cinematic',
    grade: (c) => splitTone(saturate(sCurve(c, 0.35), 0.45), [0.0, 0.02, 0.12], [0.02, 0.03, 0.08], 1),
  },

  // Vibe — the loud, social-first looks.
  {
    id: 'sunset',
    name: 'Sunset',
    category: 'vibe',
    grade: (c) =>
      splitTone(saturate(gain(sCurve(c, 0.2), [1.1, 0.99, 0.9]), 1.15), [0.05, 0.0, 0.04], [0.12, 0.04, -0.02], 1),
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    category: 'vibe',
    grade: (c) =>
      splitTone(saturate(contrast(sCurve(lift(c, 0.08), 0.18), 1.05), 1.3), [0.08, -0.02, 0.12], [-0.02, 0.03, 0.1], 1),
  },
  {
    id: 'mint',
    name: 'Mint',
    category: 'vibe',
    grade: (c) => splitTone(saturate(lift(c, 0.1), 0.95), [0.0, 0.05, 0.03], [0.0, 0.04, 0.0], 1),
  },
  {
    id: 'dusk',
    name: 'Dusk',
    category: 'vibe',
    grade: (c) =>
      splitTone(saturate(gamma(c, 0.94), 0.98), [0.06, -0.01, 0.09], [0.04, 0.0, 0.06], 1),
  },

  // ── Second pass (2026-08-02): broaden each category. Same primitives, no new machinery —
  // every look here is still a pure grade baked to a table, so parity with ffmpeg is unchanged.
  {
    id: 'bright',
    name: 'Bright',
    category: 'featured',
    grade: (c) => saturate(gamma(sCurve(c, 0.12), 1.12), 1.04),
  },
  {
    id: 'soft',
    name: 'Soft',
    category: 'featured',
    // Lifted blacks + gentle desaturation: the flattering low-contrast look for close-ups.
    grade: (c) => saturate(lift(sCurve(c, 0.1), 0.05), 0.94),
  },
  {
    id: 'punch',
    name: 'Punch',
    category: 'featured',
    grade: (c) => saturate(contrast(sCurve(c, 0.3), 1.18), 1.28),
  },
  {
    id: 'crisp',
    name: 'Crisp',
    category: 'featured',
    // Cool-neutral with deep blacks — reads "clean digital" rather than filmic.
    grade: (c) => contrast(gain(sCurve(c, 0.22), [0.98, 1.0, 1.04]), 1.1),
  },

  {
    id: 'inkwell',
    name: 'Inkwell',
    category: 'mono',
    // High-contrast black and white: crushed blacks, bright whites, no tint at all.
    grade: (c) => contrast(saturate(sCurve(c, 0.3), 0), 1.3),
  },
  {
    id: 'platinum',
    name: 'Platinum',
    category: 'mono',
    // Flat, gallery-print greyscale — lifted floor and softened highlights.
    grade: (c) => lift(contrast(saturate(c, 0), 0.86), 0.1),
  },
  {
    id: 'selenium',
    name: 'Selenium',
    category: 'mono',
    // Cool-toned darkroom print, the counterpart to Sepia's warmth.
    grade: (c) => toneMap(sCurve(c, 0.2), [0.82, 0.94, 1.16], 1),
  },

  {
    id: 'super8',
    name: 'Super 8',
    category: 'film',
    grade: (c) =>
      splitTone(saturate(lift(gamma(c, 1.05), 0.08), 0.9), [0.05, 0.02, -0.02], [0.07, 0.03, -0.03], 1),
  },
  {
    id: 'cinestill',
    name: 'Cinestill',
    category: 'film',
    // Warm highlight bloom over cool shadows — the tungsten-film night look.
    grade: (c) => splitTone(saturate(sCurve(c, 0.18), 1.06), [-0.02, 0.0, 0.07], [0.09, 0.03, -0.02], 1),
  },
  {
    id: 'vintage',
    name: 'Vintage',
    category: 'film',
    grade: (c) => saturate(lift(toneMap(sCurve(c, 0.14), [1.12, 1.02, 0.86], 0.35), 0.07), 0.88),
  },

  {
    id: 'blockbuster',
    name: 'Blockbuster',
    category: 'cinematic',
    // Teal/orange's louder cousin: stronger split plus a contrast push.
    grade: (c) =>
      contrast(splitTone(saturate(c, 1.12), [-0.04, 0.01, 0.1], [0.1, 0.03, -0.05], 1), 1.12),
  },
  {
    id: 'moonlight',
    name: 'Moonlight',
    category: 'cinematic',
    grade: (c) => splitTone(saturate(gamma(c, 0.88), 0.86), [-0.02, 0.01, 0.12], [0.0, 0.02, 0.08], 1),
  },
  {
    id: 'desert',
    name: 'Desert',
    category: 'cinematic',
    // Sun-baked warm highlights with dusty, desaturated shadows.
    grade: (c) => saturate(splitTone(sCurve(c, 0.2), [0.05, 0.03, -0.02], [0.12, 0.06, -0.04], 1), 0.96),
  },

  {
    id: 'candy',
    name: 'Candy',
    category: 'vibe',
    grade: (c) => saturate(splitTone(sCurve(c, 0.16), [0.06, -0.01, 0.06], [0.08, 0.02, 0.04], 1), 1.3),
  },
  {
    id: 'neon',
    name: 'Neon',
    category: 'vibe',
    grade: (c) =>
      saturate(contrast(splitTone(c, [0.08, -0.03, 0.12], [0.0, 0.04, 0.1], 1), 1.16), 1.42),
  },
  {
    id: 'forest',
    name: 'Forest',
    category: 'vibe',
    grade: (c) => saturate(gain(sCurve(c, 0.18), [0.94, 1.06, 0.96]), 1.08),
  },
];

// ─── emit ────────────────────────────────────────────────────────────────────

function buildCube(filter) {
  const lines = [
    `# ${filter.name} — Studio filter "${filter.id}"`,
    '# Generated by scripts/generate-filter-luts.mjs — do not edit by hand.',
    `LUT_3D_SIZE ${SIZE}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ];

  // .cube ordering: red varies fastest, then green, then blue.
  for (let b = 0; b < SIZE; b += 1) {
    for (let g = 0; g < SIZE; g += 1) {
      for (let r = 0; r < SIZE; r += 1) {
        const input = [r / (SIZE - 1), g / (SIZE - 1), b / (SIZE - 1)];
        const out = filter.grade(input).map(clamp01);
        lines.push(out.map((v) => v.toFixed(6)).join(' '));
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

mkdirSync(OUT_DIR, { recursive: true });

for (const filter of FILTERS) {
  const path = join(OUT_DIR, `${filter.id}.cube`);
  writeFileSync(path, buildCube(filter), 'utf8');
  console.log(`wrote ${path}`);
}

// The catalog itself ships as JSON so the backend can validate incoming filter ids and the iOS
// picker can build its chip rows from the same source rather than a hand-kept duplicate.
const manifest = FILTERS.map(({ id, name, category }) => ({ id, name, category }));
const manifestPath = join(OUT_DIR, 'catalog.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${manifestPath} (${manifest.length} filters)`);
