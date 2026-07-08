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
