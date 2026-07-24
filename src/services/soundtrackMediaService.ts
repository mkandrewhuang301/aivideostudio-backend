import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { config } from '../config';
import { r2, R2_BUCKET } from '../storage/r2';
import type { SoundtrackProjectSnapshot } from './soundtrackService';
import type { MusicReferenceImage } from './providers/MusicGenerationProvider';

const execFileAsync = promisify(execFile);

async function readR2(key: string): Promise<Buffer> {
  const object = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  if (!object.Body) throw new Error('Soundtrack source is unavailable');
  return Buffer.from(await object.Body.transformToByteArray());
}

function sampledClips(snapshot: SoundtrackProjectSnapshot) {
  const max = Math.max(1, Math.min(10, config.aiMusicAnalysisFrameCount));
  if (snapshot.clips.length <= max) return snapshot.clips;
  if (max === 1) return [snapshot.clips[Math.floor(snapshot.clips.length / 2)]];
  return Array.from({ length: max }, (_, index) => {
    const position = Math.round(index * (snapshot.clips.length - 1) / (max - 1));
    return snapshot.clips[position];
  });
}

export async function soundtrackReferenceImages(
  snapshot: SoundtrackProjectSnapshot,
): Promise<MusicReferenceImage[]> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'soundtrack-frames-'));
  try {
    const frames: MusicReferenceImage[] = [];
    for (const [index, clip] of sampledClips(snapshot).entries()) {
      const source = await readR2(clip.r2_key);
      if (clip.type === 'image') {
        const data = await sharp(source).rotate().resize({ width: 768, height: 768, fit: 'inside' }).jpeg({ quality: 72 }).toBuffer();
        frames.push({ mimeType: 'image/jpeg', data });
        continue;
      }
      const inputPath = path.join(workspace, `clip-${index}.mp4`);
      const outputPath = path.join(workspace, `frame-${index}.jpg`);
      await writeFile(inputPath, source);
      const midpoint = clip.trim_start + (clip.trim_end - clip.trim_start) / 2;
      await execFileAsync('ffmpeg', [
        '-y', '-ss', String(midpoint), '-i', inputPath, '-frames:v', '1',
        '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-q:v', '5', outputPath,
      ]);
      frames.push({ mimeType: 'image/jpeg', data: await readFile(outputPath) });
    }
    return frames;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function processSoundtrackAudio(
  soundtrackId: string,
  rawAudio: Buffer,
  durationSeconds: number,
): Promise<Buffer> {
  const workspace = await mkdtemp(path.join(tmpdir(), `soundtrack-${soundtrackId}-`));
  try {
    const inputPath = path.join(workspace, 'raw.mp3');
    const outputPath = path.join(workspace, 'final.m4a');
    await writeFile(inputPath, rawAudio);
    const fadeStart = Math.max(0, durationSeconds - 0.35);
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath, '-t', String(durationSeconds),
      '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${fadeStart}:d=0.35`,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function readSoundtrackRaw(key: string): Promise<Buffer> {
  return readR2(key);
}
