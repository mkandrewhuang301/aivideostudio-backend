// src/services/openaiImageService.ts
// Handles image generation via the OpenAI Images API (gpt-image-2).
// Called inline from the POST /api/generations route — NOT via Replicate webhooks —
// because OpenAI's image generation is synchronous, not async.

import { config } from '../config';
import sharp from 'sharp';
import { archiveToR2, archiveBase64ToR2, uploadBufferToR2 } from './archivalService';

function sizeFromAspectRatio(ar: string): string {
  const landscape = ['4:3', '16:9', '3:2', '21:9'].includes(ar);
  const portrait  = ['3:4', '9:16', '2:3'].includes(ar);
  return landscape ? '1536x1024' : portrait ? '1024x1536' : '1024x1024';
}

export async function generateImageWithOpenAI(
  prompt: string,
  aspectRatio: string,
  generationId: string,
): Promise<string> {
  const size = sizeFromAspectRatio(aspectRatio);

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, size, quality: 'high', n: 1 }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI image generation failed (${response.status}): ${body}`);
  }

  const json = await response.json() as { data: Array<{ url?: string }> };
  const imageUrl = json.data[0]?.url;
  if (!imageUrl) throw new Error('OpenAI returned no image URL');

  return archiveToR2(imageUrl, generationId, 'image/png');
}

// Magic Editor (SC4): OpenAI-DIRECT inline mask edit. Replicate's openai/gpt-image-2 has NO mask
// param, so this bypasses Replicate entirely and calls OpenAI's multipart /v1/images/edits
// endpoint directly — mask = alpha PNG, transparent region = edit target, opaque = preserve.
// Dispatched from openaiGenerationWorker.ts (async, 09.2-13/D-C) — NOT in the synchronous
// POST /api/generations request path (this function's stale prior doc comment said otherwise).
export async function generateImageEditWithMask(
  imageUrl: string,
  maskUrl: string,
  prompt: string,
  generationId: string,
): Promise<string> {
  const [imgRes, maskRes] = await Promise.all([fetch(imageUrl), fetch(maskUrl)]);
  if (!imgRes.ok || !maskRes.ok) {
    throw new Error('Failed to fetch source/mask for mask edit');
  }

  const sourceBuffer = Buffer.from(await imgRes.arrayBuffer());
  const maskBuffer = Buffer.from(await maskRes.arrayBuffer());
  const sourceMetadata = await sharp(sourceBuffer).metadata();
  const maskMetadata = await sharp(maskBuffer).metadata();
  const width = sourceMetadata.width;
  const height = sourceMetadata.height;
  if (!width || !height) throw new Error('Magic Editor source image has no dimensions');
  if (maskMetadata.width !== width || maskMetadata.height !== height) {
    throw new Error(
      `Magic Editor mask dimensions ${maskMetadata.width}x${maskMetadata.height} ` +
      `do not match source dimensions ${width}x${height}`,
    );
  }

  // The source image's content-type must match its actual bytes — the iOS client uploads it as
  // JPEG (2026-07-12: switched from PNG to cut Magic Editor's submit-to-navigate time, since a
  // 2048px photo PNG can run several MB vs. a few hundred KB as JPEG). Read it from R2's response
  // instead of assuming a fixed type, so this stays correct regardless of what the client sends.
  // The mask must stay PNG (needs an alpha channel — JPEG has none), unaffected by this.
  const imageContentType = imgRes.headers.get('content-type') || 'image/png';
  const imageExt = imageContentType.includes('jpeg') || imageContentType.includes('jpg') ? 'jpg' : 'png';

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('image', new Blob([sourceBuffer], { type: imageContentType }), `source.${imageExt}`);
  form.append('mask', new Blob([maskBuffer], { type: 'image/png' }), 'mask.png');
  // Keep the model output in the source coordinate space. Without an explicit size, an edit can
  // come back at a different aspect ratio; stretching that result would move the generated
  // content away from the user's painted mask before the locality composite below.
  form.append('size', `${width}x${height}`);
  form.append(
    'prompt',
    prompt && prompt.trim().length > 0
      ? `Apply this change only inside the transparent mask region: ${prompt.trim()} ` +
        'Keep the rest of the image unchanged and return the complete image.'
      : 'Remove the masked region and fill it in naturally; the rest of the image must not change.',
  );

  // NOTE: gpt-image-2 rejects the "fidelity" param some other OpenAI image endpoints accept —
  // deliberately not sent here (RESEARCH — verified).
  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      // No Content-Type — fetch's FormData sets the multipart boundary itself.
    },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI mask edit failed (${response.status}): ${body}`);
  }

  const json = await response.json() as { data: Array<{ url?: string; b64_json?: string }> };
  const item = json.data?.[0];
  let generatedBuffer: Buffer;
  if (item?.url) {
    const generatedResponse = await fetch(item.url);
    if (!generatedResponse.ok) throw new Error('Failed to fetch OpenAI mask-edit output');
    generatedBuffer = Buffer.from(await generatedResponse.arrayBuffer());
  } else if (item?.b64_json) {
    generatedBuffer = Buffer.from(item.b64_json, 'base64');
  } else {
    throw new Error('OpenAI returned no image');
  }

  // GPT Image treats a mask as guidance and can still alter distant, unrelated pixels. Enforce
  // locality ourselves: reveal the generated edit in the painted region plus a small feathered
  // halo for natural edge blending, while restoring the original everywhere farther away.
  const composited = await compositeMaskedEdit(sourceBuffer, generatedBuffer, maskBuffer);
  const key = `generations/${generationId}.png`;
  await uploadBufferToR2(composited, key, 'image/png');
  return key;
}

/**
 * Applies an OpenAI mask-edit result with a controlled, softly feathered boundary.
 *
 * OpenAI mask convention: transparent = edit, opaque = preserve. Sharp's `over` composite uses
 * the opposite alpha meaning for an overlay, so the mask alpha is inverted, expanded by about 1%
 * of the shorter image edge (capped at 24px), and feathered. This gives GPT a little room to blend
 * object borders without allowing unrelated changes elsewhere. The original source is the base.
 */
export async function compositeMaskedEdit(
  sourceBuffer: Buffer,
  generatedBuffer: Buffer,
  maskBuffer: Buffer,
): Promise<Buffer> {
  const sourceMetadata = await sharp(sourceBuffer).metadata();
  const maskMetadata = await sharp(maskBuffer).metadata();
  const width = sourceMetadata.width;
  const height = sourceMetadata.height;
  if (!width || !height) throw new Error('Magic Editor source image has no dimensions');
  if (maskMetadata.width !== width || maskMetadata.height !== height) {
    throw new Error(
      `Magic Editor mask dimensions ${maskMetadata.width}x${maskMetadata.height} ` +
      `do not match source dimensions ${width}x${height}`,
    );
  }

  const editHaloPixels = Math.max(2, Math.min(24, Math.round(Math.min(width, height) * 0.01)));
  const editAlpha = await sharp(maskBuffer)
    .ensureAlpha()
    .extractChannel('alpha')
    .negate()
    .blur(Math.max(0.5, editHaloPixels / 2))
    // Boost the blurred alpha back toward opaque. This preserves the painted area's full edit
    // strength while turning the blur's outer tail into the small, soft expansion we want.
    .linear(2, 0)
    .raw()
    .toBuffer();
  // Materialize the resized image as three-channel RGB before joining the edit alpha. Keeping
  // removeAlpha() and joinChannel() in one lazy Sharp pipeline can retain the generated image's
  // original all-opaque alpha instead of using the joined mask channel.
  const generatedRgb = await sharp(generatedBuffer)
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const editLayer = await sharp(generatedRgb, {
    raw: { width, height, channels: 3 },
  })
    .joinChannel(editAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  return sharp(sourceBuffer)
    .resize(width, height, { fit: 'fill' })
    .composite([{ input: editLayer, blend: 'over' }])
    .png()
    .toBuffer();
}

// Faceswap (09.2-12): the SECOND consumer of the inline (synchronous, no-webhook) OpenAI path,
// re-pointing faceswap away from the now-REMOVED (404) Replicate model easel/advanced-face-swap.
// Validated live against gpt-image-2 on 2026-07-09 (cross-gender + cross-race case) — the prompt
// below is used VERBATIM, do not rewrite it. Image order is load-bearing: image[] #1 = target
// scene, image[] #2 = the user's face (identity).
export const FACESWAP_PROMPT =
  "You are given two images. The FIRST image is the target scene. The SECOND image shows a " +
  "person's face. Replace ONLY the face of the person in the first image with the face and " +
  "facial identity of the person in the second image, so the output clearly and unmistakably " +
  "depicts the same individual as the second image. Keep everything else from the first image " +
  "exactly as it is — the same body, pose, hairstyle, clothing, background, lighting, colors, " +
  "and camera framing. Blend the new face naturally into the first image's lighting and skin " +
  "tone at the edges, with no visible seams or artifacts. Output one photorealistic image.";

export async function generateFaceswap(
  targetImageUrl: string,
  faceImageUrl: string,
  generationId: string,
): Promise<string> {
  const [targetRes, faceRes] = await Promise.all([fetch(targetImageUrl), fetch(faceImageUrl)]);
  if (!targetRes.ok || !faceRes.ok) {
    throw new Error('Failed to fetch target/face image for faceswap');
  }

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('image[]', new Blob([await targetRes.arrayBuffer()], { type: 'image/png' }), 'target.png');
  form.append('image[]', new Blob([await faceRes.arrayBuffer()], { type: 'image/png' }), 'face.png');
  form.append('prompt', FACESWAP_PROMPT);
  form.append('quality', 'medium');

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      // No Content-Type — fetch's FormData sets the multipart boundary itself.
    },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI faceswap failed (${response.status}): ${body}`);
  }

  const json = await response.json() as { data: Array<{ url?: string; b64_json?: string }> };
  const item = json.data?.[0];
  if (item?.url) return archiveToR2(item.url, generationId, 'image/png');
  if (item?.b64_json) return archiveBase64ToR2(item.b64_json, generationId, 'image/png');
  throw new Error('OpenAI returned no image');
}
