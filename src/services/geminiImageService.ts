// src/services/geminiImageService.ts
// Nano Banana (Gemini 3.1 Flash Image) mask-guided image edit for the Magic Editor.
//
// Nano has no alpha-mask parameter like OpenAI's /v1/images/edits — it is prompt-based. To honor
// the user's painted region we build a "guide": the source image with the edit region highlighted
// in a distinct color derived from the mask alpha, and instruct Nano to edit only there. The
// caller still runs compositeMaskedEdit() afterward, so the painted mask remains the hard boundary
// (this guide only steers WHERE Nano places the edit; it never widens what survives). Chosen over
// gpt-image-2 for ~4x lower cost and more surgical edits (2026-07-23 bakeoff — see project notes).

import sharp from 'sharp';
import { config } from '../config';

const GEMINI_IMAGE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Highlight opacity over the edit region — enough for Nano to localize, light enough that it can
// still read the underlying content it is editing.
const GUIDE_ALPHA_SCALE = 0.4;

/**
 * Builds the guided source: the original image with the edit region (mask alpha == 0, OpenAI's
 * "transparent = edit" convention) tinted bright green so Nano can see exactly where to edit.
 */
async function buildGuideImage(
  sourceBuffer: Buffer,
  maskBuffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  // Mask alpha: 0 = edit, 255 = keep. Negate so the edit region is opaque, then scale to the
  // highlight opacity → a 1-channel alpha that is ~102 over the edit region and 0 elsewhere.
  const highlightAlpha = await sharp(maskBuffer)
    .ensureAlpha()
    .extractChannel('alpha')
    .negate()
    .linear(GUIDE_ALPHA_SCALE, 0)
    .raw()
    .toBuffer();

  const greenRgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    greenRgb[i * 3] = 0;
    greenRgb[i * 3 + 1] = 255;
    greenRgb[i * 3 + 2] = 0;
  }
  const highlightLayer = await sharp(greenRgb, { raw: { width, height, channels: 3 } })
    .joinChannel(highlightAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  return sharp(sourceBuffer)
    .resize(width, height, { fit: 'fill' })
    .composite([{ input: highlightLayer, blend: 'over' }])
    .png()
    .toBuffer();
}

/**
 * Runs a mask-guided edit through Nano Banana and returns the raw generated image buffer. The
 * caller is responsible for compositing this into the exact painted mask region.
 */
export async function nanoImageEditWithMaskGuidance(
  sourceBuffer: Buffer,
  maskBuffer: Buffer,
  editInstruction: string,
  width: number,
  height: number,
): Promise<Buffer> {
  if (!config.geminiApiKey) {
    throw new Error('Magic Editor (nano) requires GEMINI_API_KEY');
  }
  const guide = await buildGuideImage(sourceBuffer, maskBuffer, width, height);
  const prompt =
    'The image has an area highlighted in bright green. Edit ONLY inside that green-highlighted ' +
    `area: ${editInstruction}. Do not add any green tint or highlight to your output — render ` +
    'natural colors and textures that blend with the surroundings. Keep everything outside the ' +
    'highlighted area exactly the same. Return the complete edited image.';

  const response = await fetch(
    `${GEMINI_IMAGE_URL}/${config.nanoImageModel}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': config.geminiApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'image/png', data: guide.toString('base64') } },
            { text: prompt },
          ],
        }],
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Nano image edit failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{
      inline_data?: { data?: string };
      inlineData?: { data?: string };
    }> } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inline_data?.data ?? p.inlineData?.data);
  const data = imagePart?.inline_data?.data ?? imagePart?.inlineData?.data;
  if (!data) {
    throw new Error('Nano image edit returned no image');
  }
  return Buffer.from(data, 'base64');
}
