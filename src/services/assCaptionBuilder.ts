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
 * Strips ASS override-block control characters ('{', '}', '\') and converts raw newlines into
 * ASS's own hard line break ('\N'). This is a REMOVE (not a backslash-escape) strategy — escaping
 * ASS's own control characters would still leave a literal '{' or '\' in the stream for some
 * libass edge cases, so the safest mitigation is to never let a raw override-block character reach
 * the .ass file at all.
 *
 * ORDER IS LOAD-BEARING for T-13-05: every user backslash is stripped FIRST, and only then is our
 * own '\N' inserted — so the escape can never be assembled out of user input, and the '{'/'}'
 * strip still means an override block (the actual injection vector) can't be opened at all. A bare
 * '\N' outside braces is a line break, not an override.
 *
 * Newlines became meaningful in 2026-07-31: the editor's inline caption/text field turns RETURN
 * into a line break instead of a commit, so a user-authored break now reaches here. Collapsing it
 * to a space (the old behavior) rendered the break in the app's preview and dropped it in the
 * burn — exactly the preview/export disagreement the rest of this file exists to prevent.
 */
export function escapeAssText(raw: string): string {
  return raw.replace(/[{}\\]/g, '').replace(/[\r\n]+/g, '\\N');
}

/**
 * Joins already-escaped word fragments with a space, EXCEPT after a fragment that ends in a hard
 * line break — a space there would indent the next line (visible on centered captions).
 */
export function joinAssWords(parts: string[]): string {
  return parts.reduce(
    (out, part) => (out === '' || out.endsWith('\\N') ? out + part : `${out} ${part}`),
    '',
  );
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

// ─── Sketch 016 style helpers (2026-07-29) ─────────────────────────────────────

/**
 * Tint the background box burns at, BEFORE the user's opacity slider multiplies it.
 *
 * ⚠️ Mirrored EXACTLY by the iOS client's `TextBackgroundTint` (Fantasia/Models/EditProject.swift).
 * The editor's miniplayer preview and this burned-in export both derive their alpha from these
 * two numbers, so they can never be changed in one repo alone or the export stops matching what
 * the user styled. Softened from 0.45 / 1.0 on 2026-07-31 (Andrew: the box read too heavy).
 */
export const TEXT_BACKGROUND_TINT = { pill: 0.35, block: 0.85 } as const;

/** Tint for a resolved background treatment ('pill' → pill tint, anything else → block tint). */
export function textBackgroundTint(background: string): number {
  return background === 'pill' ? TEXT_BACKGROUND_TINT.pill : TEXT_BACKGROUND_TINT.block;
}

/** Bundled font families (OFL-licensed) — the allowlist for CaptionStyle.font and
 * TextOverlayStyleSpec.font. Values MUST be name-table FAMILY names (the same rule the
 * buildAssFile Inter comment documents); each family needs a TTF under assets/fonts/ for
 * libass's `fontsdir=` scan to resolve it. */
export const ASS_FONT_FAMILIES = [
  'Inter',
  'Montserrat',
  'Oswald',
  'Playfair Display',
  'Bangers',
  'Courier Prime',
] as const;

/** Resolves a client-sent font name against ASS_FONT_FAMILIES — unknown/missing → Inter. */
export function resolveFontFamily(font: string | undefined): string {
  return (ASS_FONT_FAMILIES as readonly string[]).includes(font ?? '') ? (font as string) : 'Inter';
}

/** '#RRGGBB' + alpha (0..1) → '#AARRGGBB', the 8-char input hexToAssColor already understands. */
export function hexWithAlpha(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, '');
  const body = clean.length === 8 ? clean.slice(2) : clean;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16).toUpperCase().padStart(2, '0');
  return `#${a}${body}`;
}

/** Editor opacity (20–100) → 0..1 multiplier. Undefined/NaN → 1 (fully opaque). */
export function clampOpacity01(opacity: number | undefined): number {
  if (typeof opacity !== 'number' || Number.isNaN(opacity)) return 1;
  return Math.min(1, Math.max(0.2, opacity / 100));
}

/** One ASS alpha override byte ('&HAA&' form for \1a…\4a tags) from a 0..1 opacity. */
export function assAlphaTag(alpha: number): string {
  const a = (255 - Math.round(Math.min(1, Math.max(0, alpha)) * 255))
    .toString(16).toUpperCase().padStart(2, '0');
  return `&H${a}&`;
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
  /** False renders each complete cue in `color`, without word-by-word karaoke highlighting. */
  karaoke?: boolean;
  /** Optional glyph outline and drop-shadow controls for burned captions. */
  outlineWidth?: number;
  shadowDepth?: number;
  /** False uses an outlined glyph instead of the default solid background pill. */
  backgroundBox?: boolean;
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

  // ─── Sketch 016 style sheets (2026-07-29, caption-text-style-sheets-plan.md) ─────────────
  // ALL optional. When every field below is absent the builder emits BYTE-IDENTICAL output to
  // the pre-feature legacy path — defaults were chosen to coincide with it.
  /** Bundled font FAMILY name (name-table family — same rule as the Inter comment in
   * buildAssFile). Allowlisted via ASS_FONT_FAMILIES; unknown values fall back to Inter. */
  font?: string;
  /** Caption timing mode. Absent → derived from the legacy `karaoke` flag (false → 'block'). */
  timing?: 'word' | 'block' | 'karaoke';
  /** Background treatment. Absent → legacy behavior (`backgroundBox` === false → outlined glyph,
   * otherwise the legacy 50%-black pill constant). 'pill' = TEXT_BACKGROUND_TINT.pill × opacity,
   * 'block' = TEXT_BACKGROUND_TINT.block × opacity. NOTE (accepted limitation, plan Part 3):
   * ASS BorderStyle=3 boxes are rectangular — the pill's rounded corners are a preview-only
   * nicety. */
  background?: 'none' | 'pill' | 'block';
  /** Background color, hex. Default '#000000'. */
  backgroundColor?: string;
  /** ASS Bold toggle (-1/0). Default false — the current Style row emits 0. */
  bold?: boolean;
  /** Glyph outline on/off — supersedes `outlineWidth` when present (true → 2, false → 0). */
  outline?: boolean;
  /** Drop shadow on/off — supersedes `shadowDepth` when present (true → 1, false → 0). */
  shadow?: boolean;
  /** Uppercase every word at build time (before escapeAssText). Default false. */
  allCaps?: boolean;
  /** Whole-caption opacity, 20–100 — applied to the text/highlight alphas AND the background
   * alpha (pill stays proportionally lighter). Absent → legacy color math (no alpha emitted). */
  opacity?: number;
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
  // Sketch 016: timing mode — absent → legacy `karaoke` flag mapping (false → 'block'), so
  // pre-feature styles take the exact paths they always did.
  const timing = style.timing ?? (style.karaoke === false ? 'block' : 'karaoke');
  // Opacity: applied to text/highlight AND background alphas — but ONLY when the field is
  // present; absent → legacy color math with no alpha channel (byte-identical legacy output).
  const opacity01 = clampOpacity01(style.opacity);
  const withOpacity = (hex: string) =>
    style.opacity === undefined ? hexToAssColor(hex) : hexToAssColor(hexWithAlpha(hex, opacity01));
  const primaryColour = withOpacity(timing === 'karaoke' ? style.highlightColor : style.color);
  const secondaryColour = withOpacity(style.color);
  const outlineColour = '&H00000000';
  const fontFamily = resolveFontFamily(style.font);
  const boldField = style.bold === true ? -1 : 0;
  const outlineWidth = style.outline !== undefined
    ? (style.outline ? 2 : 0)
    : Math.max(0, style.outlineWidth ?? 0);
  const shadowDepth = style.shadow !== undefined
    ? (style.shadow ? 1 : 0)
    : Math.max(0, style.shadowDepth ?? 0);
  // Background. `background` ABSENT → legacy constants: backgroundBox===false → BorderStyle 1
  // (outlined glyph, no box), else the semi-transparent black pill (BorderStyle=3 renders
  // BackColour as an opaque box behind the text per 13-UI-SPEC.md). PRESENT → the pill/block
  // tint (TEXT_BACKGROUND_TINT) × opacity, none = BorderStyle 1. BackColour stays the legacy
  // constant under BorderStyle 1 (inert as a box; still the shadow color, same as before).
  let borderStyle: number;
  let backColour: string;
  if (style.background === undefined) {
    borderStyle = style.backgroundBox === false ? 1 : 3;
    backColour = '&H80000000';
  } else if (style.background === 'none') {
    borderStyle = 1;
    backColour = '&H80000000';
  } else {
    borderStyle = 3;
    backColour = hexToAssColor(hexWithAlpha(
      style.backgroundColor ?? '#000000',
      textBackgroundTint(style.background) * opacity01,
    ));
  }
  // Horizontal safe margins keep captions in a CENTERED column clear of platform UI overlays
  // (e.g. TikTok's right-side action bar + bottom caption). ASS still uses MarginL/R to compute
  // wrap width even under the per-line \pos override, so a larger symmetric value narrows the
  // wrap and centers it. Default ~14% of width each side.
  const sideMargin = Math.round(
    ((style as { safeMarginFrac?: number }).safeMarginFrac ?? 0.14) * canvas.width,
  );

  // Item 3: every Dialogue line below carries an explicit `\an5\pos(x,y)` override (box-CENTER
  // anchor, same convention buildTextOverlayAss already uses), so the Style row's Alignment field
  // is inert dead weight left at 5 (middle-center) for documentation only — MarginL/R/V likewise
  // no longer determine vertical placement. MarginL/R carry the symmetric `sideMargin` (~14% of
  // width) computed above, since ASS still uses them to compute the centered wrap column even under
  // the `\pos` override; MarginV stays at 10 (inert under `\pos`).
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
    `Style: Caption,${fontFamily},${style.fontSize},${primaryColour},${secondaryColour},${outlineColour},${backColour},${boldField},0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadowDepth},5,${sideMargin},${sideMargin},10,1`,
    '',
  ];

  const eventsHeaderLines = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  // Sketch 016: allCaps uppercases every word BEFORE escapeAssText (order irrelevant to the
  // injection guard — escape strips control chars either way). Absent/false → identity.
  const caps = style.allCaps === true;
  const xform = (s: string) => escapeAssText(caps ? s.toUpperCase() : s);

  const dialogueLines: string[] = [];
  for (const cue of cues) {
    if (timing === 'word') {
      // One word at a time (sketch 016): each word is its OWN Dialogue event spanning its own
      // start/end — never joined, never \k-swept. Active-word color is meaningless here, so
      // PrimaryColour already resolved to the base color above.
      for (const word of cue.words) {
        const wStart = formatAssTimestamp(word.startSeconds);
        const wEnd = formatAssTimestamp(word.endSeconds);
        // A line-ending word is shown ALONE here, so its trailing break belongs to the join it is
        // no longer part of — keeping it would render an empty second line and push the word off
        // its anchor (the iOS One-word preview trims it for the same reason).
        const text = xform(word.text).replace(/\\N$/, '');
        dialogueLines.push(
          `Dialogue: 0,${wStart},${wEnd},Caption,,0,0,0,,{\\an5\\pos(${centerX},${centerY})}${text}`,
        );
      }
      continue;
    }
    // joinAssWords, not join(' '): a cue stores a user line break as a trailing newline on the
    // word that ends the line (the word list is flat — there is nowhere else to put it), so the
    // separator has to be suppressed after that word. Same rule the iOS preview joins by.
    const words = timing === 'block'
      ? joinAssWords(cue.words.map((word) => xform(word.text)))
      : joinAssWords(
        cue.words.map((word) => {
          const durationCentiseconds = Math.max(0, Math.round((word.endSeconds - word.startSeconds) * 100));
          return `{\\k${durationCentiseconds}}${xform(word.text)}`;
        }),
      );
    const text = `{\\an5\\pos(${centerX},${centerY})}${words}`;
    const start = formatAssTimestamp(cue.startSeconds);
    const end = formatAssTimestamp(cue.endSeconds);
    dialogueLines.push(`Dialogue: 0,${start},${end},Caption,,0,0,0,,${text}`);
  }

  return [...scriptInfoLines, ...styleLines, ...eventsHeaderLines, ...dialogueLines].join('\n') + '\n';
}

// ─── Text overlay .ass (T-13-19 Task G4) ───────────────────────────────────────
// Replaces the old ffmpeg `drawtext` per-overlay loop (ffmpegProcessor.ts) — drawtext can't
// rotate and ignores width_norm scale. This reuses the SAME escapeAssText/formatAssTimestamp/
// Fontname:Inter machinery already proven for captions above, so every user-authored overlay
// string passes through the identical T-13-05 injection guard.

/** Per-overlay style (sketch 016, 2026-07-29) — stored as the text overlay's `style` jsonb.
 * ALL optional; an overlay whose style is undefined emits EXACTLY the pre-feature Dialogue
 * line and no extra Style row (legacy output unchanged). */
export interface TextOverlayStyleSpec {
  /** Bundled font family (ASS_FONT_FAMILIES allowlist; unknown → Inter). */
  font?: string;
  /** Text color, hex. Default '#FFFFFF' (the legacy fixed white). */
  color?: string;
  /** Background treatment: 'pill'/'block' = TEXT_BACKGROUND_TINT × opacity, 'none' =
   * outlined glyph. BorderStyle is style-level (not per-line overridable), so boxed overlays
   * use the TextOverlayBox Style row below. */
  background?: 'none' | 'pill' | 'block';
  /** Background color, hex. Default '#000000'. */
  backgroundColor?: string;
  bold?: boolean;
  /** Glyph outline on/off. Absent → the Style row's default width (2). */
  outline?: boolean;
  /** Drop shadow on/off. Absent → the Style row's default depth (1). */
  shadow?: boolean;
  allCaps?: boolean;
  /** Whole-overlay opacity 20–100 — text AND background. Absent → 100. */
  opacity?: number;
  /** Editor pt size (16–40, default 26) — multiplies the widthNorm-based size by fontSize/26. */
  fontSize?: number;
}

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
  /** Per-overlay style (sketch 016). Undefined → legacy fixed-white-Inter output. */
  style?: TextOverlayStyleSpec;
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

  // Sketch 016: a second Style row for boxed overlays — ASS BorderStyle (1 = outline, 3 = opaque
  // box) is a STYLE-LEVEL attribute with no per-line override tag, so pill/block overlays must
  // reference their own row. Emitted ONLY when some overlay actually uses a box, keeping
  // legacy (all-unstyled) files byte-identical.
  const anyBox = overlays.some(
    (o) => o.style !== undefined && (o.style.background === 'pill' || o.style.background === 'block'),
  );

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
    ...(anyBox
      ? ['Style: TextOverlayBox,Inter,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1']
      : []),
    '',
  ];

  const eventsHeaderLines = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const dialogueLines = overlays.map((overlay) => {
    const x = Math.round(overlay.xNorm * canvas.width);
    const y = Math.round(overlay.yNorm * canvas.height);
    const st = overlay.style;
    // Sketch 016: the editor's pt size scales the widthNorm-based size (26pt = 1×, the default).
    const sizeScale = (st?.fontSize ?? 26) / 26;
    const fontSize = Math.max(1, Math.round(TEXT_OVERLAY_BASE_FRAC * canvas.height * (overlay.widthNorm ?? 1) * sizeScale));
    // ASS \frz is COUNTER-clockwise-positive; SwiftUI .rotationEffect is CLOCKWISE-positive —
    // negate, else the export would mirror the editor's rotation direction. \frz rotates about
    // the \an5\pos origin (box center), same pivot .rotationEffect uses.
    const angle = -(overlay.rotation ?? 0);
    const start = formatAssTimestamp(overlay.startSeconds);
    const end = formatAssTimestamp(overlay.endSeconds);
    const text = escapeAssText(st?.allCaps === true ? overlay.text.toUpperCase() : overlay.text);
    if (st === undefined) {
      // Legacy path — EXACTLY the pre-feature line (no extra tags, TextOverlay style row).
      return `Dialogue: 0,${start},${end},TextOverlay,,0,0,0,,{\\an5\\pos(${x},${y})\\fs${fontSize}\\frz${angle}}${text}`;
    }
    const opacity01 = clampOpacity01(st.opacity);
    const boxed = st.background === 'pill' || st.background === 'block';
    const tags =
      `\\an5\\pos(${x},${y})\\fs${fontSize}\\frz${angle}` +
      `\\fn${resolveFontFamily(st.font)}` +
      `\\1c${hexToAssColor(st.color ?? '#FFFFFF')}\\1a${assAlphaTag(opacity01)}` +
      (st.bold === true ? '\\b1' : '\\b0') +
      (st.outline === false ? '\\bord0' : '') +
      (st.shadow === false ? '\\shad0' : '') +
      (boxed
        ? `\\4c${hexToAssColor(st.backgroundColor ?? '#000000')}` +
          `\\4a${assAlphaTag(textBackgroundTint(st.background ?? 'block') * opacity01)}`
        : '');
    return `Dialogue: 0,${start},${end},${boxed ? 'TextOverlayBox' : 'TextOverlay'},,0,0,0,,{${tags}}${text}`;
  });

  return [...scriptInfoLines, ...styleLines, ...eventsHeaderLines, ...dialogueLines].join('\n') + '\n';
}
