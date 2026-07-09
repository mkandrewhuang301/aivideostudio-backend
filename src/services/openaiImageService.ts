// src/services/openaiImageService.ts
// Handles image generation via the OpenAI Images API (gpt-image-2).
// Called inline from the POST /api/generations route — NOT via Replicate webhooks —
// because OpenAI's image generation is synchronous, not async.

import { config } from '../config';
import { archiveToR2, archiveBase64ToR2 } from './archivalService';

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
// Called synchronously (in-request) from POST /api/generations — never dispatched via
// ReplicateProvider, never goes through the webhook.
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

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('image', new Blob([await imgRes.arrayBuffer()], { type: 'image/png' }), 'source.png');
  form.append('mask', new Blob([await maskRes.arrayBuffer()], { type: 'image/png' }), 'mask.png');
  form.append(
    'prompt',
    prompt && prompt.trim().length > 0
      ? prompt
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
  if (item?.url) return archiveToR2(item.url, generationId, 'image/png');
  if (item?.b64_json) return archiveBase64ToR2(item.b64_json, generationId, 'image/png');
  throw new Error('OpenAI returned no image');
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
