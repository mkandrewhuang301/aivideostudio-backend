// src/__tests__/services/assCaptionBuilder.test.ts
// Phase 13 Plan 05 (SC5): word-level karaoke .ass caption generator — a pure function, no I/O.
// T-13-05: escapeAssText must strip/escape ASS override-block control characters ('{', '}', '\')
// so user-authored caption text can never inject an override tag (e.g. `{\pos(...)}`) into the
// generated .ass file that ffmpeg's `ass=` filter consumes. This is the FIRST user-authored-text-
// into-ffmpeg-command surface in this codebase (RESEARCH.md Security Domain) — no live ffmpeg
// binary or file I/O is exercised here, buildAssFile/escapeAssText/hexToAssColor are pure string
// builders.

import {
  assAlphaTag,
  buildAssFile,
  buildTextOverlayAss,
  escapeAssText,
  hexToAssColor,
  hexWithAlpha,
  resolveCaptionYOffsetNorm,
  CAPTION_POSITION_PRESETS,
  TEXT_BACKGROUND_TINT,
} from '../../services/assCaptionBuilder';

describe('escapeAssText', () => {
  it('strips braces and backslashes so no raw ASS control character survives', () => {
    expect(escapeAssText('a{b}\\c')).not.toMatch(/[{}\\]/);
  });

  it('blocks ASS override-tag injection via user-supplied text (T-13-05)', () => {
    const result = escapeAssText('x{\\pos(0,0)}y');
    expect(result).not.toContain('{\\pos');
  });

  it('collapses raw newlines to spaces', () => {
    expect(escapeAssText('line1\nline2')).not.toMatch(/[\r\n]/);
  });
});

describe('hexToAssColor', () => {
  it('converts a #RRGGBB hex color to an opaque ASS &H00BBGGRR color', () => {
    expect(hexToAssColor('#FFFFFF')).toBe('&H00FFFFFF');
  });

  it('converts a #AARRGGBB hex color to ASS &HAABBGGRR with inverted alpha', () => {
    // Input alpha FF (fully opaque, standard convention) must invert to ASS alpha 00 (opaque in
    // ASS's convention, where FF = fully transparent).
    expect(hexToAssColor('#FF8C59FF')).toBe('&H00FF598C');
  });
});

describe('buildAssFile', () => {
  const canvas = { width: 1080, height: 1920 };
  const style = {
    fontSize: 64,
    color: '#FFFFFF',
    highlightColor: '#8C59FF',
    position: 'bottom' as const,
  };

  it('sets PlayResX/PlayResY to match the export canvas (e.g. 1080x1920 for 9:16)', () => {
    const ass = buildAssFile([], style, canvas);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
  });

  it('produces a valid empty [Events] section for an empty caption cue list (no crash)', () => {
    const ass = buildAssFile([], style, canvas);
    expect(ass).toContain('[Events]');
    expect(ass.split('\n').some((l: string) => l.startsWith('Dialogue:'))).toBe(false);
  });

  it('produces exactly one Dialogue line with 3 {\\kNN} tags for a 3-word cue, NN = round(durationSeconds*100)', () => {
    const cues = [
      {
        startSeconds: 1.2,
        endSeconds: 3.4,
        words: [
          { text: 'Hello', startSeconds: 1.2, endSeconds: 2.0 },
          { text: 'there', startSeconds: 2.0, endSeconds: 2.45 },
          { text: 'world', startSeconds: 2.45, endSeconds: 3.4 },
        ],
      },
    ];

    const ass = buildAssFile(cues, style, canvas);
    const dialogueLines = ass.split('\n').filter((l: string) => l.startsWith('Dialogue:'));
    expect(dialogueLines).toHaveLength(1);

    const kTags = dialogueLines[0].match(/\{\\k\d+\}/g) ?? [];
    expect(kTags.length).toBeGreaterThanOrEqual(3);
    expect(kTags).toContain(`{\\k${Math.round((2.0 - 1.2) * 100)}}`);
    expect(kTags).toContain(`{\\k${Math.round((2.45 - 2.0) * 100)}}`);
    expect(kTags).toContain(`{\\k${Math.round((3.4 - 2.45) * 100)}}`);
  });

  it('renders an ordinary whole-cue caption when karaoke is disabled', () => {
    const cues = [{
      startSeconds: 0,
      endSeconds: 2,
      words: [
        { text: 'Yuji', startSeconds: 0, endSeconds: 1 },
        { text: 'returns.', startSeconds: 1, endSeconds: 2 },
      ],
    }];
    const ass = buildAssFile(cues, {
      ...style,
      karaoke: false,
      outlineWidth: 3,
      shadowDepth: 1.5,
      backgroundBox: false,
    }, canvas);
    const dialogue = ass.split('\n').find((line) => line.startsWith('Dialogue:')) ?? '';
    expect(dialogue).toContain('Yuji returns.');
    expect(dialogue).not.toMatch(/\{\\k\d+\}/);
    // Style tail: BorderStyle=1 (backgroundBox:false), Outline=3, Shadow=1.5, Alignment=5,
    // MarginL/R = round(0.14 * 1080) = 151 (the safe-margin column), MarginV=10, Encoding=1.
    expect(ass).toContain(',1,3,1.5,5,151,151,10,1');
  });

  it('produces 2 Dialogue lines for 2 cues with correct H:MM:SS.cc start/end timestamps', () => {
    const cues = [
      { startSeconds: 0, endSeconds: 1.5, words: [{ text: 'Hi', startSeconds: 0, endSeconds: 1.5 }] },
      { startSeconds: 65.25, endSeconds: 67, words: [{ text: 'Bye', startSeconds: 65.25, endSeconds: 67 }] },
    ];

    const ass = buildAssFile(cues, style, canvas);
    const dialogueLines = ass.split('\n').filter((l: string) => l.startsWith('Dialogue:'));
    expect(dialogueLines).toHaveLength(2);
    expect(dialogueLines[0]).toContain('0:00:00.00,0:00:01.50');
    expect(dialogueLines[1]).toContain('0:01:05.25,0:01:07.00');
  });

  it('passes every word through escapeAssText before interpolation (T-13-05)', () => {
    const cues = [
      {
        startSeconds: 0,
        endSeconds: 1,
        words: [{ text: 'a{b}\\c', startSeconds: 0, endSeconds: 1 }],
      },
    ];

    const ass = buildAssFile(cues, style, canvas);
    const dialogueLine = ass.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
    // Item 3: every Dialogue line now also carries a fixed (non-user-controlled) `{\an5\pos(...)}`
    // positioning tag ahead of the karaoke tags — strip that too before asserting no OTHER control
    // characters (i.e. none from user-authored word text) survive.
    const withoutKaraokeTags = dialogueLine
      .replace(/\{\\an5\\pos\(\d+,\d+\)\}/, '')
      .replace(/\{\\k\d+\}/g, '');
    expect(withoutKaraokeTags).not.toMatch(/[{}\\]/);
  });

  it('converts captionStyle.color and highlightColor into the Style line via hexToAssColor', () => {
    const ass = buildAssFile([], style, canvas);
    const styleLine = ass.split('\n').find((l: string) => l.startsWith('Style: Caption,')) as string;
    expect(styleLine).toContain(hexToAssColor(style.highlightColor));
    expect(styleLine).toContain(hexToAssColor(style.color));
  });

  // Item 3 (Andrew review, 2026-07-17): drag-to-reposition the caption block — a non-default
  // yOffsetNorm must change the emitted ASS positioning, and both renderers (this builder + iOS's
  // CaptionOverlayView) must resolve the SAME anchor for a given style.
  describe('yOffsetNorm (item 3 — caption block vertical drag)', () => {
    it('emits \\an5\\pos at the box CENTER (canvas width/2, yOffsetNorm*canvas height) when yOffsetNorm is set', () => {
      const ass = buildAssFile(
        [{ startSeconds: 0, endSeconds: 1, words: [{ text: 'Hi', startSeconds: 0, endSeconds: 1 }] }],
        { ...style, yOffsetNorm: 0.3 },
        canvas,
      );
      const dialogueLine = ass.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
      expect(dialogueLine).toContain(`\\an5\\pos(${Math.round(canvas.width / 2)},${Math.round(0.3 * canvas.height)})`);
    });

    it('a non-default yOffsetNorm changes the emitted ASS positioning vs. the position-preset default', () => {
      const cues = [{ startSeconds: 0, endSeconds: 1, words: [{ text: 'Hi', startSeconds: 0, endSeconds: 1 }] }];
      const defaultAss = buildAssFile(cues, style, canvas); // style.position === 'bottom', no yOffsetNorm
      const draggedAss = buildAssFile(cues, { ...style, yOffsetNorm: 0.2 }, canvas);
      const defaultLine = defaultAss.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
      const draggedLine = draggedAss.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
      expect(draggedLine).not.toBe(defaultLine);
      expect(draggedLine).toContain(`\\pos(${Math.round(canvas.width / 2)},${Math.round(0.2 * canvas.height)})`);
    });

    it('falls back to CAPTION_POSITION_PRESETS[position] when yOffsetNorm is absent', () => {
      expect(resolveCaptionYOffsetNorm({ ...style, position: 'top' })).toBe(CAPTION_POSITION_PRESETS.top);
      expect(resolveCaptionYOffsetNorm({ ...style, position: 'middle' })).toBe(CAPTION_POSITION_PRESETS.middle);
      expect(resolveCaptionYOffsetNorm({ ...style, position: 'bottom' })).toBe(CAPTION_POSITION_PRESETS.bottom);
    });

    it('prefers yOffsetNorm over position when both are present', () => {
      expect(resolveCaptionYOffsetNorm({ ...style, position: 'top', yOffsetNorm: 0.75 })).toBe(0.75);
    });

    it('clamps an out-of-range yOffsetNorm defensively (route validation is the primary guard)', () => {
      expect(resolveCaptionYOffsetNorm({ ...style, yOffsetNorm: 1.5 })).toBe(1);
      expect(resolveCaptionYOffsetNorm({ ...style, yOffsetNorm: -0.5 })).toBe(0);
    });
  });
});

// T-13-19 Task G4: text-overlay .ass builder — replaces the old ffmpeg `drawtext` per-overlay
// loop so rotation (\frz) and scale (\fs) actually reach the exported MP4.
describe('buildTextOverlayAss', () => {
  const canvas = { width: 1080, height: 1920 };

  it('sets PlayResX/PlayResY to match the export canvas', () => {
    const ass = buildTextOverlayAss([], canvas);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
  });

  it('produces a valid empty [Events] section for an empty overlay list (no crash)', () => {
    const ass = buildTextOverlayAss([], canvas);
    expect(ass).toContain('[Events]');
    expect(ass.split('\n').some((l: string) => l.startsWith('Dialogue:'))).toBe(false);
  });

  it('declares a Fontname:Inter TextOverlay style row (name-table family, not the file stem)', () => {
    const ass = buildTextOverlayAss([], canvas);
    const styleLine = ass.split('\n').find((l: string) => l.startsWith('Style: TextOverlay,')) as string;
    expect(styleLine).toBeDefined();
    expect(styleLine).toContain('TextOverlay,Inter,');
  });

  it('emits \\an5\\pos at the box CENTER (xNorm*PlayResX, yNorm*PlayResY), matching SwiftUI .position(...)', () => {
    const ass = buildTextOverlayAss(
      [{ text: 'Hi', xNorm: 0.5, yNorm: 0.25, startSeconds: 0, endSeconds: 1 }],
      canvas,
    );
    const dialogueLine = ass.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
    expect(dialogueLine).toContain('\\an5\\pos(540,480)');
  });

  it('scales \\fs proportionally to canvas height via widthNorm (1 => ~48px on a 1920-tall canvas)', () => {
    const base = buildTextOverlayAss(
      [{ text: 'Hi', xNorm: 0.5, yNorm: 0.5, widthNorm: 1, startSeconds: 0, endSeconds: 1 }],
      canvas,
    );
    const doubled = buildTextOverlayAss(
      [{ text: 'Hi', xNorm: 0.5, yNorm: 0.5, widthNorm: 2, startSeconds: 0, endSeconds: 1 }],
      canvas,
    );
    const baseLine = base.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
    const doubledLine = doubled.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;

    expect(baseLine).toContain('\\fs48');
    expect(doubledLine).toContain('\\fs96');
  });

  it('defaults widthNorm to 1 (scale=1) when omitted', () => {
    const ass = buildTextOverlayAss([{ text: 'Hi', xNorm: 0.5, yNorm: 0.5, startSeconds: 0, endSeconds: 1 }], canvas);
    const dialogueLine = ass.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
    expect(dialogueLine).toContain('\\fs48');
  });

  it('negates rotation for \\frz (ASS is counter-clockwise-positive, SwiftUI .rotationEffect is clockwise-positive)', () => {
    const ass = buildTextOverlayAss(
      [{ text: 'Hi', xNorm: 0.5, yNorm: 0.5, rotation: 30, startSeconds: 0, endSeconds: 1 }],
      canvas,
    );
    const dialogueLine = ass.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
    expect(dialogueLine).toContain('\\frz-30');
  });

  it('defaults rotation to 0 (\\frz0) when omitted', () => {
    const ass = buildTextOverlayAss([{ text: 'Hi', xNorm: 0.5, yNorm: 0.5, startSeconds: 0, endSeconds: 1 }], canvas);
    const dialogueLine = ass.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
    expect(dialogueLine).toContain('\\frz0');
  });

  it('produces one Dialogue line per overlay, in order, with H:MM:SS.cc start/end timestamps', () => {
    const ass = buildTextOverlayAss(
      [
        { text: 'First', xNorm: 0.5, yNorm: 0.5, startSeconds: 0, endSeconds: 1.5 },
        { text: 'Second', xNorm: 0.5, yNorm: 0.5, startSeconds: 65.25, endSeconds: 67 },
      ],
      canvas,
    );
    const dialogueLines = ass.split('\n').filter((l: string) => l.startsWith('Dialogue:'));
    expect(dialogueLines).toHaveLength(2);
    expect(dialogueLines[0]).toContain('0:00:00.00,0:00:01.50');
    expect(dialogueLines[1]).toContain('0:01:05.25,0:01:07.00');
  });

  it('passes every overlay string through escapeAssText before interpolation (T-13-05 injection guard reused)', () => {
    const ass = buildTextOverlayAss(
      [{ text: 'x{\\pos(0,0)}y', xNorm: 0.5, yNorm: 0.5, startSeconds: 0, endSeconds: 1 }],
      canvas,
    );
    const dialogueLine = ass.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;
    const withoutOverrideBlock = dialogueLine.replace(/\{[^}]*\}/, '');
    expect(withoutOverrideBlock).not.toMatch(/[{}\\]/);
    expect(dialogueLine).not.toContain('{\\pos');
  });
});

// ─── Sketch 016 (2026-07-29, caption-text-style-sheets-plan.md) ────────────────
// Style-sheet fields: timing modes, background modes + color, opacity over text AND
// background, font family mapping, bold/outline/shadow/allCaps. Legacy styles (none of
// the new fields present) keep the pre-feature byte-identical paths — the suites above
// all pass such styles and cover that contract.
describe('buildAssFile — sketch 016 style fields', () => {
  const canvas = { width: 1080, height: 1920 };
  const style = {
    fontSize: 64,
    color: '#FFFFFF',
    highlightColor: '#8C59FF',
    position: 'bottom' as const,
  };
  const cue = {
    startSeconds: 0,
    endSeconds: 2,
    words: [
      { text: 'one', startSeconds: 0, endSeconds: 1 },
      { text: 'two', startSeconds: 1, endSeconds: 2 },
    ],
  };
  const dialogues = (ass: string) => ass.split('\n').filter((l: string) => l.startsWith('Dialogue:'));
  const styleLine = (ass: string) => ass.split('\n').find((l: string) => l.startsWith('Style: Caption,')) as string;

  it("timing 'word' emits one Dialogue event PER WORD with the word's own time range and no \\k tags", () => {
    const ass = buildAssFile([cue], { ...style, timing: 'word' }, canvas);
    const lines = dialogues(ass);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('0:00:00.00,0:00:01.00');
    expect(lines[0]).toContain('one');
    expect(lines[1]).toContain('0:00:01.00,0:00:02.00');
    expect(lines[1]).toContain('two');
    expect(lines.join('\n')).not.toMatch(/\{\\k\d+\}/);
    // No active-word sweep in word mode — PrimaryColour resolves to the base color.
    expect(styleLine(ass)).toContain('Style: Caption,Inter,64,' + hexToAssColor(style.color) + ',');
  });

  it("timing 'block' joins the whole cue with no \\k tags (same as legacy karaoke:false)", () => {
    const ass = buildAssFile([cue], { ...style, timing: 'block' }, canvas);
    const lines = dialogues(ass);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('one two');
    expect(lines[0]).not.toMatch(/\{\\k\d+\}/);
  });

  it("absent timing + karaoke:false still takes the legacy block path (byte-compat)", () => {
    const legacy = buildAssFile([cue], { ...style, karaoke: false }, canvas);
    const explicit = buildAssFile([cue], { ...style, timing: 'block' }, canvas);
    expect(dialogues(legacy)).toEqual(dialogues(explicit));
  });

  it("background 'pill' burns BackColour at the pill tint × opacity via BorderStyle 3", () => {
    const ass = buildAssFile([], { ...style, background: 'pill', backgroundColor: '#000000' }, canvas);
    expect(styleLine(ass)).toContain(hexToAssColor(hexWithAlpha('#000000', TEXT_BACKGROUND_TINT.pill)));
  });

  it("background 'block' burns the block tint; opacity scales the box alpha", () => {
    const ass = buildAssFile([], { ...style, background: 'block', backgroundColor: '#0A84FF', opacity: 60 }, canvas);
    expect(styleLine(ass)).toContain(
      hexToAssColor(hexWithAlpha('#0A84FF', TEXT_BACKGROUND_TINT.block * 0.6)),
    );
  });

  it("background 'none' uses BorderStyle 1 (outlined glyph, no box)", () => {
    const ass = buildAssFile([], { ...style, background: 'none' }, canvas);
    expect(styleLine(ass)).toContain(',1,');
    expect(styleLine(ass)).not.toContain(',3,');
  });

  it('absent background keeps the legacy 50%-black pill constant (byte-compat)', () => {
    const legacy = buildAssFile([], style, canvas);
    expect(styleLine(legacy)).toContain('&H80000000');
    expect(styleLine(legacy)).toContain(',3,');
  });

  it('opacity scales the text AND highlight alphas when present', () => {
    const ass = buildAssFile([], { ...style, opacity: 50 }, canvas);
    const line = styleLine(ass);
    expect(line).toContain(hexToAssColor(hexWithAlpha(style.highlightColor, 0.5)));
    expect(line).toContain(hexToAssColor(hexWithAlpha(style.color, 0.5)));
  });

  it('font maps to the ASS Fontname; unknown families fall back to Inter', () => {
    expect(styleLine(buildAssFile([], { ...style, font: 'Bangers' }, canvas))).toContain('Caption,Bangers,');
    expect(styleLine(buildAssFile([], { ...style, font: 'Comic Sans' }, canvas))).toContain('Caption,Inter,');
  });

  it('bold toggles the ASS Bold field (-1), leaving the rest of the row intact', () => {
    expect(styleLine(buildAssFile([], { ...style, bold: true }, canvas))).toContain(',-1,0,0,0,100,100,');
    expect(styleLine(buildAssFile([], style, canvas))).toContain(',0,0,0,0,100,100,');
  });

  it('outline/shadow booleans supersede the numeric width/depth fields', () => {
    const line = styleLine(buildAssFile([], { ...style, background: 'none', outline: true, shadow: false }, canvas));
    expect(line).toContain(',1,2,0,5,');
  });

  it('allCaps uppercases every word before escaping', () => {
    const ass = buildAssFile([cue], { ...style, timing: 'block', allCaps: true }, canvas);
    expect(dialogues(ass)[0]).toContain('ONE TWO');
  });
});

describe('buildTextOverlayAss — sketch 016 per-overlay style', () => {
  const canvas = { width: 1080, height: 1920 };
  const base = { text: 'day 3', xNorm: 0.5, yNorm: 0.5, startSeconds: 0, endSeconds: 1 };
  const dialogue = (ass: string) => ass.split('\n').find((l: string) => l.startsWith('Dialogue:')) as string;

  it('unstyled overlays keep the exact legacy Dialogue line and no TextOverlayBox row', () => {
    const ass = buildTextOverlayAss([base], canvas);
    expect(dialogue(ass)).toBe(
      'Dialogue: 0,0:00:00.00,0:00:01.00,TextOverlay,,0,0,0,,{\\an5\\pos(540,960)\\fs48\\frz0}day 3',
    );
    expect(ass).not.toContain('TextOverlayBox');
  });

  it('styled overlays carry per-line \\fn \\1c \\1a \\b tags and honor fontSize/allCaps/bold/outline', () => {
    const ass = buildTextOverlayAss(
      [{
        ...base,
        widthNorm: 1,
        style: { font: 'Oswald', color: '#FF3B30', bold: true, outline: false, allCaps: true, opacity: 50, fontSize: 52 },
      }],
      canvas,
    );
    const line = dialogue(ass);
    expect(line).toContain('\\fnOswald');
    expect(line).toContain(`\\1c${hexToAssColor('#FF3B30')}`);
    expect(line).toContain('\\1a&H7F&'); // 50% opacity → ASS alpha 0x7F
    expect(line).toContain('\\b1');
    expect(line).toContain('\\bord0');
    expect(line).toContain('\\fs96'); // 52pt = 2× the 26pt default → 48 × 2
    expect(line).toContain('DAY 3');
    expect(ass).not.toContain('TextOverlayBox'); // no box → stays on the outline style row
  });

  it("boxed overlays use the TextOverlayBox row with per-line \\4c \\4a (pill tint × opacity)", () => {
    const ass = buildTextOverlayAss(
      [{ ...base, style: { background: 'pill', backgroundColor: '#000000' } }],
      canvas,
    );
    const line = dialogue(ass);
    expect(line).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,TextOverlayBox,');
    expect(line).toContain(`\\4c${hexToAssColor('#000000')}`);
    expect(line).toContain(`\\4a${assAlphaTag(TEXT_BACKGROUND_TINT.pill)}`);
    expect(ass).toContain('Style: TextOverlayBox,');
  });

  it('a solid block box burns at the block tint (scaled by opacity)', () => {
    const ass = buildTextOverlayAss(
      [{ ...base, style: { background: 'block', backgroundColor: '#FFFFFF', opacity: 60 } }],
      canvas,
    );
    expect(dialogue(ass)).toContain(`\\4a${assAlphaTag(TEXT_BACKGROUND_TINT.block * 0.6)}`);
  });

  it('escapes styled overlay text (T-13-05 guard applies to the new path too)', () => {
    const ass = buildTextOverlayAss(
      [{ ...base, text: 'x{\\pos(0,0)}y', style: { bold: true } }],
      canvas,
    );
    const line = dialogue(ass);
    expect(line).not.toContain('{\\pos');
    // escapeAssText REMOVES the control chars, keeping the harmless inner text.
    expect(line).toContain('xpos(0,0)y');
  });
});
