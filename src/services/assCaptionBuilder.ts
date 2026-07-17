// src/services/assCaptionBuilder.ts
// Phase 13 Plan 05 (SC5): word-level karaoke .ass subtitle generator.
//
// Pure functions, no I/O — the caller (ffmpegProcessor.ts's new 'compose' branch, Plan 06/07)
// writes the returned string to a temp file via the SAME `writeFile(path.join(tempDir, ...),
// contents, 'utf-8')` convention already used for `list.txt` in the existing concat branch, then
// burns it via `-vf ass=filename=...:fontsdir=...`.
//
// T-13-05 (Tampering — see 13-05-PLAN.md threat_model): this is the FIRST user-authored-text-into-
// ffmpeg-consumed-artifact surface in this codebase. Every word's text MUST pass through
// escapeAssText before interpolation into the generated Dialogue line, so a caption/overlay word
// containing ASS override-block characters ('{', '}', '\') can never open an override tag (e.g.
// `{\pos(0,0)}`) inside the burned subtitle stream.

/**
 * Strips ASS override-block control characters ('{', '}', '\') and collapses raw newlines to a
 * single space. This is a REMOVE (not a backslash-escape) strategy — escaping ASS's own control
 * characters would still leave a literal '{' or '\' in the stream for some libass edge cases, so
 * the safest mitigation is to never let a raw override-block character reach the .ass file at all.
 */
export function escapeAssText(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/[{}\\]/g, '');
}

/**
 * Converts a '#RRGGBB' or '#AARRGGBB' hex color into ASS's '&HAABBGGRR' color format.
 * ASS colors are BGR-ordered (not RGB), and ASS alpha is INVERTED relative to the standard
 * convention: 00 = fully opaque, FF = fully transparent (the opposite of a typical 0xAARRGGBB
 * value, where FF = fully opaque). A bare '#RRGGBB' input has no alpha channel, so it is treated
 * as fully opaque (input alpha = FF) before inversion.
 */
export function hexToAssColor(hex: string): string {
  const clean = hex.replace(/^#/, '');
  let inputAlpha: number;
  let r: number;
  let g: number;
  let b: number;

  if (clean.length === 8) {
    inputAlpha = parseInt(clean.slice(0, 2), 16);
    r = parseInt(clean.slice(2, 4), 16);
    g = parseInt(clean.slice(4, 6), 16);
    b = parseInt(clean.slice(6, 8), 16);
  } else {
    inputAlpha = 255;
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }

  // Defense against malformed hex input (NaN components) — fall back to opaque white rather than
  // emit a broken '&HNaNNaNNaNNaN' color string into the generated .ass file.
  if ([inputAlpha, r, g, b].some((n) => Number.isNaN(n))) {
    return '&H00FFFFFF';
  }

  const assAlpha = 255 - inputAlpha;
  const toHex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H${toHex(assAlpha)}${toHex(b)}${toHex(g)}${toHex(r)}`;
}

/** Converts a fractional-seconds timestamp into ASS's 'H:MM:SS.cc' (centisecond) format. */
function formatAssTimestamp(seconds: number): string {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mins = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad2 = (n: number) => n.toString().padStart(2, '0');
  return `${hours}:${pad2(mins)}:${pad2(secs)}.${pad2(centiseconds)}`;
}

export interface CaptionWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface CaptionCue {
  startSeconds: number;
  endSeconds: number;
  words: CaptionWord[];
}

export interface CaptionStyle {
  fontSize: number;
  /** Base (pre-sweep) text color, hex. Rendered as the ASS Style's SecondaryColour. */
  color: string;
  /** Active/swept-word highlight color, hex. Rendered as the ASS Style's PrimaryColour — this is
   * what `\k` sweeps Secondary -> Primary into as each word's karaoke duration elapses. */
  highlightColor: string;
  position: 'top' | 'middle' | 'bottom';
  /** Item 3 (Andrew review, 2026-07-17): optional continuous vertical anchor, 0..1, of the caption
   * block's CENTER — same "box CENTER, matching SwiftUI .position(...) semantics" convention
   * TextOverlaySpec.yNorm below already documents. When present this is the source of truth for
   * vertical placement (drag-to-reposition on the preview); when absent, `position` resolves to
   * one of CAPTION_POSITION_PRESETS via resolveCaptionYOffsetNorm. Validated to [0,1] server-side
   * in routes/projects.ts's PATCH handler. iOS's CaptionOverlayView MUST resolve the identical
   * value via the identical preset numbers — see that file's matching doc comment — so the live
   * drag preview and the burned export never disagree. */
  yOffsetNorm?: number;
}

/** Fallback vertical-center anchors for the legacy top/middle/bottom picker, used only when
 * `CaptionStyle.yOffsetNorm` is absent (e.g. a project whose caption style predates this field).
 * MUST match CaptionOverlayView.swift's `presetYOffsetNorm` numbers exactly. */
export const CAPTION_POSITION_PRESETS: Record<'top' | 'middle' | 'bottom', number> = {
  top: 0.12,
  middle: 0.5,
  bottom: 0.88,
};

/** Resolves the effective vertical-center anchor (0..1) for a caption style: `yOffsetNorm` if set
 * (clamped defensively even though the route already validates it), else the position preset. */
export function resolveCaptionYOffsetNorm(style: CaptionStyle): number {
  if (typeof style.yOffsetNorm === 'number' && Number.isFinite(style.yOffsetNorm)) {
    return Math.min(1, Math.max(0, style.yOffsetNorm));
  }
  return CAPTION_POSITION_PRESETS[style.position] ?? CAPTION_POSITION_PRESETS.bottom;
}

export interface CaptionCanvas {
  width: number;
  height: number;
}

/**
 * Builds a complete .ass subtitle file from word-level caption cues and ONE global caption style
 * (per ROADMAP.md SC5 — no per-cue style overrides in this phase).
 *
 * Each cue becomes one `Dialogue:` line; each word within a cue becomes a `{\kNN}` karaoke tag
 * (NN = the word's duration in centiseconds) immediately followed by that word's escaped text.
 * An empty `cues` array still produces a structurally valid file with a header-only [Events]
 * section (no Dialogue lines) — this must never throw.
 */
export function buildAssFile(cues: CaptionCue[], style: CaptionStyle, canvas: CaptionCanvas): string {
  // PrimaryColour = already-swept/active fill (highlight); SecondaryColour = pre-sweep base color
  // — this is exactly how `\k` sweeps Secondary -> Primary as playback crosses each word.
  const primaryColour = hexToAssColor(style.highlightColor);
  const secondaryColour = hexToAssColor(style.color);
  const outlineColour = '&H00000000';
  // Semi-transparent black background pill per 13-UI-SPEC.md's default Caption Style contract
  // (BorderStyle=3 renders BackColour as an opaque box behind the text, not just an outline).
  const backColour = '&H80000000';

  // Item 3: every Dialogue line below carries an explicit `\an5\pos(x,y)` override (box-CENTER
  // anchor, same convention buildTextOverlayAss already uses), so the Style row's Alignment field
  // is inert dead weight left at 5 (middle-center) for documentation only — MarginL/R/V likewise
  // no longer determine vertical placement, but MarginL/R are KEPT at their prior 10/10 values
  // because ASS still uses them to compute wrap width even under `\pos` override, and changing
  // that would regress existing multi-word wrap behavior, which is out of this item's scope.
  const centerX = Math.round(canvas.width / 2);
  const centerY = Math.round(resolveCaptionYOffsetNorm(style) * canvas.height);

  const scriptInfoLines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    '',
  ];

  const styleLines = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Fontname MUST be the font's actual name-table Family name ("Inter", nameID 1) — NOT the
    // PostScript/file-stem name "Inter-Bold" (nameID 6). Verified live against the deployed
    // Railway container (13-02 checkpoint smoke test): libass's `fontsdir=` resolves a Style's
    // Fontname by matching the family/full name records inside the scanned TTFs, not the
    // filename. "Inter-Bold" matches neither "Inter" (family) nor "Inter Bold" (full name) and
    // silently falls back to an unrelated system substitute font; "Inter" resolves correctly to
    // our bundled assets/fonts/Inter-Bold.ttf (confirmed: `fontselect: (Inter, 400, 0) ->
    // Inter-Bold, 0, Inter-Bold`). Bold weight (400 base + Bold=0 below is the ASS bold-toggle,
    // unrelated to font selection) comes from this being the only style in the bundled font file.
    `Style: Caption,Inter,${style.fontSize},${primaryColour},${secondaryColour},${outlineColour},${backColour},0,0,0,0,100,100,0,0,3,0,0,5,10,10,10,1`,
    '',
  ];

  const eventsHeaderLines = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const dialogueLines = cues.map((cue) => {
    const words = cue.words
      .map((word) => {
        const durationCentiseconds = Math.max(0, Math.round((word.endSeconds - word.startSeconds) * 100));
        return `{\\k${durationCentiseconds}}${escapeAssText(word.text)}`;
      })
      .join(' ');
    const text = `{\\an5\\pos(${centerX},${centerY})}${words}`;
    const start = formatAssTimestamp(cue.startSeconds);
    const end = formatAssTimestamp(cue.endSeconds);
    return `Dialogue: 0,${start},${end},Caption,,0,0,0,,${text}`;
  });

  return [...scriptInfoLines, ...styleLines, ...eventsHeaderLines, ...dialogueLines].join('\n') + '\n';
}

// ─── Text overlay .ass (T-13-19 Task G4) ───────────────────────────────────────
// Replaces the old ffmpeg `drawtext` per-overlay loop (ffmpegProcessor.ts) — drawtext can't
// rotate and ignores width_norm scale. This reuses the SAME escapeAssText/formatAssTimestamp/
// Fontname:Inter machinery already proven for captions above, so every user-authored overlay
// string passes through the identical T-13-05 injection guard.

export interface TextOverlaySpec {
  text: string;
  /** 0..1 normalized position — box CENTER, matching SwiftUI's .position(...) semantics. */
  xNorm: number;
  yNorm: number;
  /** Scale factor; 1 = default size. */
  widthNorm?: number;
  /** Degrees, CLOCKWISE-positive (SwiftUI .rotationEffect convention) — negated below for \frz. */
  rotation?: number;
  startSeconds: number;
  endSeconds: number;
}

// Proportional to the output canvas height so scale=1 reads consistently across every aspect
// ratio — unlike the old drawtext path's fixed `fontsize=48`, which only "looked right" on
// 1080-tall canvases (4:5/1:1/16:9) and was visibly undersized on 1920-tall 9:16 exports (this
// app's default/primary format). Calibrated so widthNorm=1 on a 9:16 (1920-tall) canvas renders
// ~48px — matching the pre-libass default look on the format most users actually export.
const TEXT_OVERLAY_BASE_FRAC = 48 / 1920;

/**
 * Builds a complete .ass subtitle file from Text overlays (SC3) — a SEPARATE libass pass from
 * buildAssFile's word-level captions above (its own Style row, `TextOverlay`, chained through its
 * own `ass=` filter in the ffmpeg graph). An empty `overlays` array still produces a structurally
 * valid header-only file, same contract as buildAssFile — this must never throw.
 */
export function buildTextOverlayAss(overlays: TextOverlaySpec[], canvas: CaptionCanvas): string {
  const scriptInfoLines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    '',
  ];

  const styleLines = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Fontname MUST be the name-table family "Inter" (not the file stem "Inter-Bold") — same
    // gotcha documented above for the Caption style; the bold weight comes from the bundled TTF
    // itself, not an ASS Bold-toggle. Per-line \pos fully overrides placement, so MarginL/R/V and
    // the default Alignment here are effectively inert (kept at sane defaults regardless).
    // BorderStyle=1 (outline, no box) + a semi-transparent BackColour used as the shadow color —
    // mirrors the editor's on-video text-shadow look instead of the caption track's opaque pill.
    'Style: TextOverlay,Inter,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,5,0,0,0,1',
    '',
  ];

  const eventsHeaderLines = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const dialogueLines = overlays.map((overlay) => {
    const x = Math.round(overlay.xNorm * canvas.width);
    const y = Math.round(overlay.yNorm * canvas.height);
    const fontSize = Math.max(1, Math.round(TEXT_OVERLAY_BASE_FRAC * canvas.height * (overlay.widthNorm ?? 1)));
    // ASS \frz is COUNTER-clockwise-positive; SwiftUI .rotationEffect is CLOCKWISE-positive —
    // negate, else the export would mirror the editor's rotation direction. \frz rotates about
    // the \an5\pos origin (box center), same pivot .rotationEffect uses.
    const angle = -(overlay.rotation ?? 0);
    const start = formatAssTimestamp(overlay.startSeconds);
    const end = formatAssTimestamp(overlay.endSeconds);
    const text = escapeAssText(overlay.text);
    return `Dialogue: 0,${start},${end},TextOverlay,,0,0,0,,{\\an5\\pos(${x},${y})\\fs${fontSize}\\frz${angle}}${text}`;
  });

  return [...scriptInfoLines, ...styleLines, ...eventsHeaderLines, ...dialogueLines].join('\n') + '\n';
}
