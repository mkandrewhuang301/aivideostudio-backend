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

/** ASS numpad alignment values libass expects in the Style line's Alignment field. */
function alignmentForPosition(position: 'top' | 'middle' | 'bottom'): number {
  switch (position) {
    case 'top':
      return 8; // top-center
    case 'middle':
      return 5; // middle-center
    case 'bottom':
    default:
      return 2; // bottom-center
  }
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
  const alignment = alignmentForPosition(style.position);
  // PrimaryColour = already-swept/active fill (highlight); SecondaryColour = pre-sweep base color
  // — this is exactly how `\k` sweeps Secondary -> Primary as playback crosses each word.
  const primaryColour = hexToAssColor(style.highlightColor);
  const secondaryColour = hexToAssColor(style.color);
  const outlineColour = '&H00000000';
  // Semi-transparent black background pill per 13-UI-SPEC.md's default Caption Style contract
  // (BorderStyle=3 renders BackColour as an opaque box behind the text, not just an outline).
  const backColour = '&H80000000';

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
    `Style: Caption,Inter-Bold,${style.fontSize},${primaryColour},${secondaryColour},${outlineColour},${backColour},0,0,0,0,100,100,0,0,3,0,0,${alignment},10,10,10,1`,
    '',
  ];

  const eventsHeaderLines = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const dialogueLines = cues.map((cue) => {
    const text = cue.words
      .map((word) => {
        const durationCentiseconds = Math.max(0, Math.round((word.endSeconds - word.startSeconds) * 100));
        return `{\\k${durationCentiseconds}}${escapeAssText(word.text)}`;
      })
      .join(' ');
    const start = formatAssTimestamp(cue.startSeconds);
    const end = formatAssTimestamp(cue.endSeconds);
    return `Dialogue: 0,${start},${end},Caption,,0,0,0,,${text}`;
  });

  return [...scriptInfoLines, ...styleLines, ...eventsHeaderLines, ...dialogueLines].join('\n') + '\n';
}
