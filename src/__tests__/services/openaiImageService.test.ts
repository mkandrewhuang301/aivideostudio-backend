import sharp from 'sharp';

const mockUploadBufferToR2 = jest.fn().mockResolvedValue(undefined);

jest.mock('../../config', () => ({
  config: { openaiApiKey: 'test-openai-key' },
}));

jest.mock('../../services/archivalService', () => ({
  archiveToR2: jest.fn(),
  archiveBase64ToR2: jest.fn(),
  uploadBufferToR2: mockUploadBufferToR2,
}));

import {
  compositeMaskedEdit,
  generateImageEditWithMask,
} from '../../services/openaiImageService';

async function solidImage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; alpha?: number },
  format: 'png' | 'jpeg' = 'png',
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 4, background: { ...color, alpha: color.alpha ?? 1 } },
  });
  return format === 'jpeg' ? pipeline.jpeg().toBuffer() : pipeline.png().toBuffer();
}

async function paintedSquareMask(
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      pixels[(y * width + x) * 4 + 3] = 0;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

describe('Magic Editor mask enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('allows a small feathered edit halo but restores unrelated pixels farther from the mask', async () => {
    const width = 21;
    const height = 21;
    const center = 10;
    const source = await solidImage(width, height, { r: 0, g: 0, b: 255 });
    const generated = await solidImage(width, height, { r: 255, g: 0, b: 0 });
    // A small filled patch represents an actual PencilKit brush stroke more faithfully than one
    // isolated pixel; Magic Editor masks are painted areas with nonzero brush width.
    const mask = await paintedSquareMask(width, height, center, center, 2);

    const result = await compositeMaskedEdit(source, generated, mask);
    const { data } = await sharp(result).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * width + x) * 3;
      return [...data.subarray(offset, offset + 3)];
    };

    expect(pixel(center, center)).toEqual([255, 0, 0]);
    expect(pixel(center + 3, center)[0]).toBeGreaterThan(40); // just outside can blend
    expect(pixel(center + 3, center)[0]).toBeLessThan(200); // but the halo is already fading
    expect(pixel(0, 0)).toEqual([0, 0, 255]); // unrelated distant content is original
  });

  it('uploads the mask, requests source-sized output, then archives the locality-composited result', async () => {
    const width = 16;
    const height = 16;
    const source = await solidImage(width, height, { r: 0, g: 0, b: 255 }, 'jpeg');
    const generated = await solidImage(width, height, { r: 255, g: 0, b: 0 });
    const mask = await paintedSquareMask(width, height, 8, 8, 2);

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(source, { headers: { 'content-type': 'image/jpeg' } }))
      .mockResolvedValueOnce(new Response(mask, { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: generated.toString('base64') }],
      }), { headers: { 'content-type': 'application/json' } }));

    const key = await generateImageEditWithMask(
      'https://r2.example/source.jpg',
      'https://r2.example/mask.png',
      'replace the flower with a candle',
      'gen-mask',
    );

    const apiRequest = (global.fetch as jest.Mock).mock.calls[2];
    expect(apiRequest[0]).toBe('https://api.openai.com/v1/images/edits');
    const form = apiRequest[1].body as FormData;
    expect(form.get('mask')).toBeInstanceOf(Blob);
    expect(form.get('size')).toBe('16x16');
    expect(form.get('prompt')).toContain('only inside the transparent mask region');

    expect(key).toBe('generations/gen-mask.png');
    expect(mockUploadBufferToR2).toHaveBeenCalledWith(
      expect.any(Buffer),
      'generations/gen-mask.png',
      'image/png',
    );

    const uploaded = mockUploadBufferToR2.mock.calls[0][0] as Buffer;
    const { data } = await sharp(uploaded).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // JPEG compression can perturb the blue source slightly. A distant pixel must still be
    // blue/source-derived, while the transparent-mask center is the generated red.
    expect(data[2]).toBeGreaterThan(200);
    expect(data[0]).toBeLessThan(30);
    const centerOffset = (8 * width + 8) * 3;
    expect([...data.subarray(centerOffset, centerOffset + 3)]).toEqual([255, 0, 0]);
  });

  it('rejects a mask whose dimensions do not match the source', async () => {
    const source = await solidImage(2, 1, { r: 0, g: 0, b: 255 });
    const generated = await solidImage(2, 1, { r: 255, g: 0, b: 0 });
    const wrongSizeMask = await solidImage(1, 1, { r: 255, g: 255, b: 255 });

    await expect(compositeMaskedEdit(source, generated, wrongSizeMask)).rejects.toThrow(
      'do not match source dimensions',
    );
  });
});
