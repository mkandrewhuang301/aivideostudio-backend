// src/__tests__/services/assCaptionBuilder.test.ts
// Phase 13 Plan 05 (SC5): word-level karaoke .ass caption generator — a pure function, no I/O.
// T-13-05: escapeAssText must strip/escape ASS override-block control characters ('{', '}', '\')
// so user-authored caption text can never inject an override tag (e.g. `{\pos(...)}`) into the
// generated .ass file that ffmpeg's `ass=` filter consumes. This is the FIRST user-authored-text-
// into-ffmpeg-command surface in this codebase (RESEARCH.md Security Domain) — no live ffmpeg
// binary or file I/O is exercised here, buildAssFile/escapeAssText/hexToAssColor are pure string
// builders.

import { buildAssFile, buildTextOverlayAss, escapeAssText, hexToAssColor } from '../../services/assCaptionBuilder';

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
    const withoutKaraokeTags = dialogueLine.replace(/\{\\k\d+\}/g, '');
    expect(withoutKaraokeTags).not.toMatch(/[{}\\]/);
  });

  it('converts captionStyle.color and highlightColor into the Style line via hexToAssColor', () => {
    const ass = buildAssFile([], style, canvas);
    const styleLine = ass.split('\n').find((l: string) => l.startsWith('Style: Caption,')) as string;
    expect(styleLine).toContain(hexToAssColor(style.highlightColor));
    expect(styleLine).toContain(hexToAssColor(style.color));
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
