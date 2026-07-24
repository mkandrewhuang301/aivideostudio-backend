// End-to-end check of the WIRED illustrated path: mirrors explainerGenerationWorker's new loop
// (resolveVisualStage(method).generateSceneClip) + real script/TTS/WhisperX/Lyria + the real
// runFfmpegOp('explainer_compose'). Skips only the DB/Redis bookkeeping (covered by unit tests).
// Self-generates a flat-vector anchor since the production anchor art is not yet in R2.
//   npx tsx src/scripts/e2eIllustrated.ts
import 'dotenv/config';
import Replicate from 'replicate';
import { writeFile } from 'node:fs/promises';
import { FORMATS_BY_ID } from '../config/formats';
import { archiveToR2, getGenerationPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import { generateNarrationForScene, type NarrationStem } from '../services/geminiTtsService';
import { expandExplainerScript } from '../services/openaiScriptService';
import { resolveVisualStage } from '../services/explainerVisualStage';
import { generateMusicBed } from '../services/lyriaService';
import { concatWavBuffers } from '../services/wavUtil';
import { buildSceneCues, getWordTimings } from '../services/whisperxService';
import type { CaptionWordDraft } from '../services/captionTranscriptionService';
import { runFfmpegOp } from '../queue/ffmpegProcessor';

const OUT = '/private/tmp/claude-501/-Users-andrewhuang/dcdd9acc-0469-415c-a803-2fbeca2ca958/scratchpad/e2e-illustrated.mp4';
const TOPIC = 'How the Wright brothers achieved the first powered airplane flight in 1903';
const STYLE_ID = 'flat-vector';   // illustrated-capable
const VOICE = 'Kore';
const ASPECT = '9:16' as const;

function localize(sn: string[], w: CaptionWordDraft[], off: number[]): CaptionWordDraft[] {
  let c = 0;
  return sn.flatMap((n, i) => {
    const wc = n.trim() ? n.trim().split(/\s+/).length : 0;
    const o = off[i] ?? 0;
    const s = w.slice(c, c + wc).map((x) => ({ text: x.text, startSeconds: Math.max(0, x.startSeconds - o), endSeconds: Math.max(0, x.endSeconds - o) }));
    c += wc; return s;
  });
}
async function dlBuf(key: string): Promise<Buffer> {
  const r = await fetch(await getGenerationPresignedUrl(key));
  if (!r.ok) throw new Error(`dl ${key} ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const genId = `e2e-illustrated-${Date.now()}`;
  const def = FORMATS_BY_ID['explainer']!;
  const style = def.style_grid.find((s) => s.id === STYLE_ID)!;
  const tier = def.duration_tiers.find((t) => t.seconds === 30)!;
  const sceneCount = tier.illustrated_scene_count; // 12
  console.log(`\n=== E2E illustrated (WIRED path) — ${genId} ===`);
  console.log(`topic: ${TOPIC}\nstyle: ${style.label}  scenes: ${sceneCount}  price: ${tier.illustrated_credits}cr  edit_budget: ${tier.edit_budget}\n`);

  // Anchor (self-generated, temp key) since production anchor art is 404.
  console.log('[0] flat-vector anchor…');
  const rep = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  // Style SWATCH, not a scene: a non-representational style board (palette chips + sample shapes /
  // line/shading motifs) so it conveys the art language with NO composition or subject for the
  // per-scene stills to copy. A full-scene anchor is what caused the "same lighthouse everywhere"
  // bleed. (The real frozen per-style anchors should follow the same swatch rule.)
  const aPrompt = 'A STYLE REFERENCE SWATCH BOARD (not a scene): a grid of flat-color palette chips in '
    + 'navy, orange, cream, and teal, alongside small isolated sample motifs — a few simple geometric '
    + 'shapes, a leaf, a cloud, a rounded mountain — each drawn in clean modern editorial flat-vector '
    + 'style (Kurzgesagt-like: bold flat color shapes, crisp edges, minimal shading). No landscape, no '
    + 'unified scene, no text, no characters. Just style samples on a plain background. Vertical 9:16.';
  const aOut = await rep.run('openai/gpt-image-2', { input: { prompt: aPrompt, aspect_ratio: '9:16', quality: 'high' } }) as any;
  const aFirst = Array.isArray(aOut) ? aOut[0] : aOut;
  const aUrl = typeof aFirst === 'string' ? aFirst : String(aFirst.url());
  const anchorKey = await archiveToR2(aUrl, `${genId}.anchor`, 'image/png');
  const anchorUrl = await getGenerationPresignedUrl(anchorKey);

  console.log('[1] script…');
  const script = await expandExplainerScript({ topic: TOPIC, sceneCount, styleLabel: style.label, scriptTemplate: def.script_template });
  console.log(`   ${script.scenes.length} scenes`);

  const stems: NarrationStem[] = [];
  const clipKeys: string[] = [];
  const stage = resolveVisualStage('illustrated'); // <-- the wired worker call
  for (let i = 0; i < script.scenes.length; i++) {
    const sc = script.scenes[i]!;
    const stem = await generateNarrationForScene(sc.narration_line, VOICE, def.tts_model, genId, i);
    stems.push(stem);
    const { clipR2Key } = await stage.generateSceneClip({
      generationId: genId, sceneIndex: i,
      visualPrompt: sc.visual_prompt, motionPrompt: sc.motion_prompt,
      styleAnchorUrl: anchorUrl, imageModel: def.image_model, omniModel: def.omni_model,
      narrationDurationSeconds: stem.durationSeconds, aspectRatio: ASPECT,
    });
    clipKeys.push(clipR2Key);
    console.log(`   scene ${i}: ${stem.durationSeconds.toFixed(1)}s -> ${clipR2Key.split('/').pop()}`);
  }

  console.log('[2] narration concat…');
  const narrationBuffer = concatWavBuffers(await Promise.all(stems.map((s) => dlBuf(s.r2Key))));
  const narrationKey = `generations/${genId}.narration.wav`;
  await uploadBufferToR2(narrationBuffer, narrationKey, 'audio/wav');
  const off: number[] = []; let cum = 0;
  for (const s of stems) { off.push(cum); cum += s.durationSeconds; }

  console.log('[3] WhisperX captions…');
  const scriptWords = script.scenes.flatMap((s) => s.narration_line.split(/\s+/).filter(Boolean));
  const words = await getWordTimings(await getGenerationPresignedUrl(narrationKey), scriptWords, cum);
  const sn = script.scenes.map((s) => s.narration_line);
  const cues = buildSceneCues(sn, localize(sn, words, off), off);

  console.log('[4] Lyria music…');
  let musicKey: string | null = null;
  try { musicKey = (await generateMusicBed(script.music_mood || 'ambient', def.music_model, genId))?.r2Key ?? null; } catch (e) { console.warn('   music skipped:', (e as Error).message); }

  console.log('[5] ffmpeg explainer_compose…');
  const { r2Key } = await runFfmpegOp({
    generationId: genId, userId: 'e2e', costCredits: tier.illustrated_credits, op: 'explainer_compose',
    inputR2Keys: clipKeys, mediaType: 'video',
    explainerCompose: {
      width: 1080, height: 1920, fps: 25,
      clips: script.scenes.map((_s, i) => ({ r2Key: clipKeys[i]!, durationSeconds: stems[i]!.durationSeconds })),
      narrationR2Key: narrationKey, musicR2Key: musicKey, musicVolume: 0.1,
      captionCues: cues,
      captionStyle: { fontSize: def.caption_style.fontSize, color: def.caption_style.textColor, highlightColor: def.caption_style.highlightColor, position: def.caption_style.position },
    },
  } as any);

  await writeFile(OUT, await dlBuf(r2Key));
  console.log(`\n✅ DONE -> ${OUT}`);
}
main().catch((e) => { console.error('\n❌ FAILED:', e); process.exit(1); });
