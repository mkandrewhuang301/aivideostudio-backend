// src/services/videoGuideService.ts
// Next-shot guide behind POST /api/prompt/from-video (2026-07-25; next-shot flip 2026-07-27):
// Gemini WATCHES the user's reference clip and writes ONE prompt for the NEXT SHOT after it —
// a natural cut to fresh framing carrying the same subject/world/mood, NOT a seamless resume
// from the final frame (Seedance Mini glitches visibly at the seam — Andrew dogfood 7/26).
// This is the video-aware complement to the sight-unseen dispatch interceptor
// (enhanceForDispatch): the guide shapes what the user TYPES, the interceptor still enriches
// whatever finally submits (shape-neutral — it no longer imposes or reverses shot choice).
//
// Clips are 3-8s generations, so the whole clip IS the final moment — no trimming. Downscaled
// to 480p and sent INLINE (no Files API round-trip): ~1MB, ~1-2.5k video tokens, ~$0.001/read.
// Audio track is KEPT through the downscale — ambience is one of the continuity axes.
//
// FAIL LOUD (VideoGuideError) like the other /api/prompt suggest endpoints — this backs an
// explicit user tap, so silently doing nothing would just look broken. Route maps it to 502.

import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'util';
import { config } from '../config';

const execFileAsync = promisify(execFile);

const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const GEMINI_TIMEOUT_MS = 30_000;

export class VideoGuideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoGuideError';
  }
}

const BASE_INSTRUCTION =
  'You are helping a user create the NEXT SHOT after a short AI-generated video clip. Watch ' +
  'the clip, especially its FINAL moments. Write ONE prompt for an AI video generation model ' +
  'that creates the next shot after this clip: a natural CUT to fresh framing — never ask for ' +
  'a seamless resume from the final frame (the generation model glitches visibly at the seam). ' +
  'Carry the story forward: keep the same subject and world grounded in what you actually see ' +
  'and hear at the end of the clip — the subject\'s identity, the environment, the lighting ' +
  'style, the audio ambience — but pick framing and camera that suit the NEW action. If the ' +
  'clip has no clear subject, describe the scene and camera instead. One paragraph. Output ' +
  'only the prompt text, no preamble or explanation.';

const HINT_INSTRUCTION_SUFFIX =
  ' The user\'s intended direction for the next shot is given after the clip — realize THEIR ' +
  'idea as the new shot\'s action while keeping the subject and world grounded in the footage.';

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads the clip (bounded) and re-encodes to 480p h264/aac for the inline Gemini read. */
async function downscaleForGemini(videoUrl: string): Promise<Buffer> {
  const response = await fetchWithTimeout(videoUrl, DOWNLOAD_TIMEOUT_MS);
  if (!response.ok) throw new VideoGuideError(`clip download failed (${response.status})`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
    throw new VideoGuideError('clip exceeds size limit');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_VIDEO_BYTES) throw new VideoGuideError('clip exceeds size limit');

  // Same discipline as frameExtractor/ffmpegProcessor: execFile with fixed argv, never shell.
  const dir = await mkdtemp(path.join(tmpdir(), 'video-guide-'));
  try {
    const inputPath = path.join(dir, 'input.mp4');
    const outputPath = path.join(dir, 'guide.mp4');
    await writeFile(inputPath, bytes);
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      '-vf', 'scale=-2:480',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      '-c:a', 'aac', '-b:a', '96k',
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Watches a reference clip and writes one grounded continuation prompt. `videoUrl` must be a
 * server-generated presigned R2 URL — routes/prompt.ts resolves generation_id/upload_id itself
 * and never accepts client-supplied URLs (SSRF). Optional `hint` is the user's steer ("he turns
 * around") and MUST be moderated by the caller before it gets here.
 * Throws VideoGuideError on any failure.
 */
export async function continuationGuideFromVideo(args: {
  videoUrl: string;
  hint?: string;
}): Promise<string> {
  const downscaled = await downscaleForGemini(args.videoUrl);

  const model = config.videoGuideModel.replace(/^models\//, '');
  const url = `${GEMINI_API_ROOT}/models/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let geminiResponse: Response;
  try {
    geminiResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': config.geminiApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                data: downscaled.toString('base64'),
                mimeType: 'video/mp4',
              },
            },
            {
              text: (args.hint ? BASE_INSTRUCTION + HINT_INSTRUCTION_SUFFIX : BASE_INSTRUCTION)
                + (args.hint ? `\n\nUser direction: ${args.hint}` : ''),
            },
          ],
        }],
        generationConfig: { temperature: 0.4 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error('[videoGuide] Gemini unreachable:', err);
    throw new VideoGuideError('Gemini unreachable');
  } finally {
    clearTimeout(timer);
  }

  if (!geminiResponse.ok) {
    console.error(`[videoGuide] Gemini generateContent error: ${geminiResponse.status}`);
    throw new VideoGuideError(`Gemini returned ${geminiResponse.status}`);
  }

  const json = (await geminiResponse.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new VideoGuideError('Gemini returned no guide text');
  return text;
}
