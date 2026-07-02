// src/services/openaiImageService.ts
// Handles image generation via the OpenAI Images API (gpt-image-2).
// Called inline from the POST /api/generations route — NOT via Replicate webhooks —
// because OpenAI's image generation is synchronous, not async.

import { config } from '../config';
import { archiveToR2 } from './archivalService';

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
