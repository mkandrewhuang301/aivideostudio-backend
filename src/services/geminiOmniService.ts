// src/services/geminiOmniService.ts
//
// Google Gemini Omni Flash video client through Gemini Enterprise Agent Platform's Interactions
// API. Requests are attributed to the Fantasia Cloud project so eligible Google Cloud promotional
// credits can cover the usage.
// Parallel to omniService.ts (the fal path); the Explainer visual stages use THIS one. Keeps the
// archival-first rule: the expiring provider payload is uploaded to R2 immediately.
//
// Findings baked in from the current Agent Platform documentation:
//   - Endpoint POST /v1beta1/projects/{project}/locations/global/interactions.
//   - Duration is a typed "3s"–"10s" response-format field.
//   - First-frame and reference flows must declare image_to_video/reference_to_video tasks.
//   - Audio: prompt "sound effects only, no music" → clean SFX; music comes from Lyria downstream.
//   - Output: inline base64 in the `steps[].content[]` array (video/mp4).
//   - Aspect: 9:16 | 16:9 only.
//
// TODO(build): add 429-quota backoff/retry at the caller.

import { uploadBufferToR2 } from './archivalService';
import { config } from '../config';
import { GoogleAuth } from 'google-auth-library';

const OMNI_MODEL = 'gemini-omni-flash-preview';
const NO_MUSIC =
  'Ambient diegetic sound effects only — the natural sounds of the scene. Absolutely NO music, no soundtrack, no background score, no melody.';

type OmniInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mime_type: string };

export class SafeOmniError extends Error {}

function clampDuration(sec: number): number {
  return Math.min(10, Math.max(3, Math.ceil(sec)));
}

function durationPhrase(sec: number): string {
  return `Make it a ${clampDuration(sec)}-second clip.`;
}

function interactionsUrl(): string {
  return `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(config.agentPlatformProjectId)}/locations/global/interactions`;
}

let enterpriseAuth: GoogleAuth | null = null;

async function getEnterpriseAccessToken(): Promise<string> {
  if (!config.agentPlatformClientEmail || !config.agentPlatformPrivateKey) {
    throw new SafeOmniError('Agent Platform service account credentials not configured');
  }
  enterpriseAuth ??= new GoogleAuth({
    credentials: {
      client_email: config.agentPlatformClientEmail,
      private_key: config.agentPlatformPrivateKey,
    },
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const token = await enterpriseAuth.getAccessToken();
  if (!token) throw new SafeOmniError('Agent Platform OAuth token unavailable');
  return token;
}

function motionWithPolicy(motionPrompt: string, durationSec: number, sfxOnly: boolean): string {
  return [motionPrompt, sfxOnly ? NO_MUSIC : '', durationPhrase(durationSec)].filter(Boolean).join(' ');
}

async function fetchImageAsBase64(url: string): Promise<{ data: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new SafeOmniError(`Omni reference image fetch failed (${res.status})`);
  const mime = res.headers.get('content-type') ?? 'image/png';
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mime };
}

// Recursively locate the returned inline video in the Interactions `steps` response.
function findInlineVideo(node: unknown): string | null {
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    const mime = typeof n.mime_type === 'string' ? n.mime_type : '';
    if ((n.type === 'video' || mime.startsWith('video')) && typeof n.data === 'string') {
      return n.data;
    }
    for (const k of Object.keys(n)) {
      const found = findInlineVideo(n[k]);
      if (found) return found;
    }
  }
  return null;
}

async function callOmni(
  input: OmniInputPart[],
  aspectRatio: '9:16' | '16:9',
  durationSec: number,
  task: 'image_to_video' | 'reference_to_video',
): Promise<Buffer> {
  const accessToken = await getEnterpriseAccessToken();

  const res = await fetch(interactionsUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      model: OMNI_MODEL,
      input,
      response_format: [
        {
          type: 'video',
          delivery: 'uri',
          aspect_ratio: aspectRatio,
          duration: `${clampDuration(durationSec)}s`,
        },
      ],
      generation_config: { video_config: { task } },
    }),
  });
  if (!res.ok) {
    // 429 = quota (caller should back off); other codes = provider failure.
    throw new SafeOmniError(`Omni interactions failed (${res.status})`);
  }
  const b64 = findInlineVideo(await res.json());
  if (!b64) throw new SafeOmniError('Omni returned no inline video');
  return Buffer.from(b64, 'base64');
}

async function archiveClip(video: Buffer, generationId: string, sceneIndex: number): Promise<{ r2Key: string }> {
  const r2Key = `generations/${generationId}.scene${sceneIndex}.mp4`;
  await uploadBufferToR2(video, r2Key, 'video/mp4');
  return { r2Key };
}

/** gpt_animate path — animate a pre-composed still as the first frame. */
export async function animateFirstFrame(args: {
  stillUrl: string;
  motionPrompt: string;
  durationSec: number;
  aspectRatio: '9:16' | '16:9';
  sfxOnly: boolean;
  generationId: string;
  sceneIndex: number;
}): Promise<{ r2Key: string }> {
  const img = await fetchImageAsBase64(args.stillUrl);
  const text = `Animate this image (<FIRST_FRAME>): ${motionWithPolicy(args.motionPrompt, args.durationSec, args.sfxOnly)} Keep the exact art style and any on-screen text unchanged.`;
  const video = await callOmni(
    [{ type: 'text', text }, { type: 'image', data: img.data, mime_type: img.mime }],
    args.aspectRatio,
    args.durationSec,
    'image_to_video',
  );
  return archiveClip(video, args.generationId, args.sceneIndex);
}

/** omni_oneshot path — compose + animate a scene from style anchor + character refs in one shot. */
export async function referenceToVideo(args: {
  styleAnchorUrl: string;
  characterRefUrls: string[];
  visualPrompt: string;
  motionPrompt: string;
  durationSec: number;
  aspectRatio: '9:16' | '16:9';
  sfxOnly: boolean;
  generationId: string;
  sceneIndex: number;
}): Promise<{ r2Key: string }> {
  // <IMAGE_REF_0> = style anchor; <IMAGE_REF_1..N> = character sheets present in this scene.
  const refUrls = [args.styleAnchorUrl, ...args.characterRefUrls];
  const imgs = await Promise.all(refUrls.map(fetchImageAsBase64));
  const charTags = imgs.slice(1).map((_, i) => `<IMAGE_REF_${i + 1}>`).join(', ');
  const styleClause = `Using the art style of <IMAGE_REF_0>`;
  const charClause = charTags ? ` featuring the same character(s) ${charTags}` : '';
  const text = `${styleClause}${charClause}: ${args.visualPrompt}. ${motionWithPolicy(args.motionPrompt, args.durationSec, args.sfxOnly)}`;
  const input: OmniInputPart[] = [
    { type: 'text' as const, text },
    ...imgs.map((im) => ({ type: 'image' as const, data: im.data, mime_type: im.mime })),
  ];
  const video = await callOmni(input, args.aspectRatio, args.durationSec, 'reference_to_video');
  return archiveClip(video, args.generationId, args.sceneIndex);
}
