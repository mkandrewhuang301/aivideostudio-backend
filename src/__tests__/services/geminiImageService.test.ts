jest.mock('../../config', () => ({
  config: {
    geminiApiKey: 'mock-gemini-key',
    nanoImageModel: 'gemini-3.1-flash-image-preview',
  },
}));

import sharp from 'sharp';
import {
  imageSizeFor,
  isBlankImage,
  nearestSupportedAspect,
  pixelDiffStats,
} from '../../services/geminiImageService';

async function solidImage(width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: rgb,
    },
  }).png().toBuffer();
}

describe('nearestSupportedAspect', () => {
  it('maps exact canvas ratios to themselves', () => {
    expect(nearestSupportedAspect(1080, 1920)).toBe('9:16');
    expect(nearestSupportedAspect(1920, 1080)).toBe('16:9');
    expect(nearestSupportedAspect(1024, 1024)).toBe('1:1');
  });

  it('maps near-miss dimensions to the closest supported ratio', () => {
    expect(nearestSupportedAspect(768, 1344)).toBe('9:16'); // 0.571 ≈ 0.5625
    expect(nearestSupportedAspect(1000, 1000)).toBe('1:1');
  });
});

describe('imageSizeFor', () => {
  it('picks the smallest tier at or above the long side', () => {
    expect(imageSizeFor(768, 1024)).toBe('1K');
    expect(imageSizeFor(1080, 1920)).toBe('2K');
    expect(imageSizeFor(2160, 3840)).toBe('4K');
  });
});

describe('pixelDiffStats', () => {
  it('reports ~0 for identical images (a no-op edit)', async () => {
    const a = await solidImage(64, 64, { r: 200, g: 100, b: 50 });
    const { changedFraction } = await pixelDiffStats(a, a);
    expect(changedFraction).toBe(0);
  });

  it('reports ~1 for completely different images', async () => {
    const a = await solidImage(64, 64, { r: 0, g: 0, b: 0 });
    const b = await solidImage(64, 64, { r: 255, g: 255, b: 255 });
    const { changedFraction } = await pixelDiffStats(a, b);
    expect(changedFraction).toBe(1);
  });

  it('detects a small-but-real edit (a quarter of the frame changed)', async () => {
    const base = await solidImage(64, 64, { r: 128, g: 128, b: 128 });
    const edited = await sharp(base)
      .composite([{
        input: await solidImage(32, 32, { r: 255, g: 0, b: 0 }),
        top: 0,
        left: 0,
      }])
      .png()
      .toBuffer();
    const { changedFraction } = await pixelDiffStats(base, edited);
    expect(changedFraction).toBeGreaterThan(0.15);
    expect(changedFraction).toBeLessThan(0.4);
  });
});

describe('isBlankImage', () => {
  it('flags a solid-color image as blank', async () => {
    expect(await isBlankImage(await solidImage(64, 64, { r: 10, g: 20, b: 30 }))).toBe(true);
  });

  it('passes an image with real content', async () => {
    const content = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([{ input: await solidImage(32, 64, { r: 255, g: 255, b: 255 }), top: 0, left: 0 }])
      .png()
      .toBuffer();
    expect(await isBlankImage(content)).toBe(false);
  });
});
