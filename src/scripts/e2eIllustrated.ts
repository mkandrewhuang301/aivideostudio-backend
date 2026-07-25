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
import {
  EXPLAINER_NARRATION_TEMPO,
  EXPLAINER_VOICE_STYLE_PROMPT,
  generateNarrationForScene,
  resolveExplainerVoice,
  type NarrationStem,
} from '../services/geminiTtsService';
import { expandExplainerScript } from '../services/openaiScriptService';
import { resolveVisualStage, resolveMotionPlan } from '../services/explainerVisualStage';
import { allocateMotionBudget } from '../services/explainerMotionAllocator';
import { generateMusicBed } from '../services/lyriaService';
import { concatWavBuffers } from '../services/wavUtil';
import { buildSceneCues, getWordTimings } from '../services/whisperxService';
import type { CaptionWordDraft } from '../services/captionTranscriptionService';
import { runFfmpegOp } from '../queue/ffmpegProcessor';

const OUT = '/tmp/e2e-illustrated-2026-07-24.mp4';
const TOPIC = 'How the Wright brothers achieved the first powered airplane flight in 1903';
const STYLE_ID = 'flat-vector';   // illustrated-capable
const STYLE_LABEL = 'Flat Vector'; // display label for the image judge's style check
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

/**
 * Bounded-concurrency pool: runs `worker(i)` for i in [0, count) with at most `limit` in flight at
 * once (a simple bank of self-refilling workers, not a batched chunk-of-N — a fast scene starts
 * its neighbor immediately rather than waiting for a whole batch to finish). This is the real fix
 * for the sequential e2e's ~30min runtime (each scene was a fully serial TTS + still + nano/gpt-
 * stills + ffmpeg chain). Stays under Replicate/Gemini rate limits at ~5 in flight. Per-scene
 * results must be written BY INDEX inside `worker`, not push-order, since completion order is
 * nondeterministic under concurrency.
 */
async function runPool(count: number, limit: number, worker: (i: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function lane(): Promise<void> {
    while (cursor < count) {
      const i = cursor;
      cursor += 1;
      await worker(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, () => lane()));
}

async function main() {
  const wallClockStart = Date.now();
  const genId = `e2e-illustrated-${Date.now()}`;
  const def = FORMATS_BY_ID['explainer']!;
  const style = def.style_grid.find((s) => s.id === STYLE_ID)!;
  const tier = def.duration_tiers.find((t) => t.seconds === 30)!;
  const sceneCount = tier.illustrated_scene_count; // 7 (script-first estimate; actual count is emergent)
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
  const script = await expandExplainerScript({
    topic: TOPIC, sceneCount, styleLabel: style.label, scriptTemplate: def.script_template,
    visualMethod: 'illustrated',
    // Pre-atempo spoken-duration budget: writes enough narration that, AFTER EXPLAINER_NARRATION_TEMPO
    // compresses it, the final video lands near tier.seconds instead of v3's 77s-for-30s overshoot.
    targetTotalSeconds: tier.seconds * EXPLAINER_NARRATION_TEMPO,
  });
  console.log(`   ${script.scenes.length} scenes`);

  // Kicked off immediately (only needs script.music_mood) and awaited at compose time, so Lyria
  // overlaps the scene pool below instead of sitting on the critical path after it (2026-07-23
  // speed pass). .catch attaches synchronously so a rejection before the later await never surfaces
  // as an unhandled promise rejection.
  console.log('[1b] Lyria music (started concurrently)…');
  const musicPromise = generateMusicBed(script.music_mood || 'ambient', def.music_model, genId)
    .then((result) => result?.r2Key ?? null)
    .catch((e: unknown) => { console.warn('   music skipped:', (e as Error).message); return null; });

  const motionAllocation = allocateMotionBudget(script.scenes, tier.edit_budget);
  const grantedCount = motionAllocation.filter((a) => a.resolvedNano).length;
  const nanoEditsGranted = motionAllocation
    .filter((a) => a.resolvedNano)
    .reduce((sum, a) => sum + (script.scenes[a.sceneIndex]!.motion?.edit_steps.length ?? 0), 0);
  console.log(`   motion allocation: ${grantedCount}/${script.scenes.length} scenes granted nano, ${nanoEditsGranted}/${tier.edit_budget} edits used`);

  const SCENE_CONCURRENCY = 5; // v3 saw zero 429s at 5 (2026-07-23 speed pass); account re-funded 7/24
  // Shared image-judge regen budget, same formula as the worker (ceil(n*0.25), min 2). The scene
  // pool runs concurrently; integer decrements on this object are the only cross-scene state.
  const regenBudget = { remaining: Math.max(2, Math.ceil(script.scenes.length * 0.25)) };
  console.log(`   image-judge regen budget: ${regenBudget.remaining}`);
  // Preallocated + written BY INDEX inside the pool (never push) so ordering survives concurrent
  // completion — narration concat, WhisperX offsets, and compose clips all depend on stems[i]/
  // clipKeys[i] lining up with script.scenes[i].
  const stems: NarrationStem[] = new Array(script.scenes.length);
  const clipKeys: string[] = new Array(script.scenes.length);
  const stage = resolveVisualStage('illustrated'); // <-- the wired worker call
  // Same voice for every stem; resolved once (async — the clone branch presigns). Undefined for a
  // preset Gemini voice like Kore → native Gemini TTS path (2026-07-24 routing flip).
  const narrationVoice = await resolveExplainerVoice(VOICE);
  await runPool(script.scenes.length, SCENE_CONCURRENCY, async (i) => {
    const sc = script.scenes[i]!;
    const stem = await generateNarrationForScene(
      sc.narration_line, VOICE, def.tts_model, genId, i,
      EXPLAINER_VOICE_STYLE_PROMPT, EXPLAINER_NARRATION_TEMPO, narrationVoice,
    );
    stems[i] = stem;
    const allocation = motionAllocation[i];
    const { clipR2Key } = await stage.generateSceneClip({
      generationId: genId, sceneIndex: i,
      visualPrompt: sc.visual_prompt, motionPrompt: sc.motion_prompt,
      styleAnchorUrl: anchorUrl, imageModel: def.image_model, omniModel: def.omni_model,
      narrationDurationSeconds: stem.durationSeconds, aspectRatio: ASPECT,
      motion: sc.motion, resolvedNano: allocation?.resolvedNano ?? false,
      onImageText: sc.on_image_text, textZone: sc.text_zone,
      regenBudget, styleLabel: STYLE_LABEL,
    });
    clipKeys[i] = clipR2Key;
    const plan = resolveMotionPlan(sc.motion, allocation?.resolvedNano ?? false);
    const motionLabel = sc.motion
      ? `${sc.motion.type} p${sc.motion.priority} -> plan=${plan.kind}${plan.kind === 'nano' || plan.kind === 'gpt_stills' ? ` (${plan.editSteps.length} steps)` : ''}`
      : 'no motion plan -> ken_burns';
    // Logged as each scene completes — under concurrency these interleave, but every line is
    // self-contained (scene index + all its own data), so interleaving doesn't lose information.
    console.log(`   scene ${i}: ${stem.durationSeconds.toFixed(1)}s [${motionLabel}] transition_out=${sc.transition_out ?? 'cut'} -> ${clipR2Key.split('/').pop()}`);
  });

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

  console.log('[4] Lyria music (awaiting)…');
  const musicKey = await musicPromise;

  console.log('[5] ffmpeg explainer_compose…');
  const { r2Key } = await runFfmpegOp({
    generationId: genId, userId: 'e2e', costCredits: tier.illustrated_credits, op: 'explainer_compose',
    inputR2Keys: clipKeys, mediaType: 'video',
    explainerCompose: {
      width: 1080, height: 1920, fps: 25,
      clips: script.scenes.map((s, i) => ({ r2Key: clipKeys[i]!, durationSeconds: stems[i]!.durationSeconds, transition: s.transition_out ?? 'cut' })),
      narrationR2Key: narrationKey, musicR2Key: musicKey, musicVolume: 0.1,
      captionCues: cues,
      captionStyle: { fontSize: def.caption_style.fontSize, color: def.caption_style.textColor, highlightColor: def.caption_style.highlightColor, position: def.caption_style.position, outlineWidth: def.caption_style.outlineWidth, shadowDepth: def.caption_style.shadowDepth, backgroundBox: def.caption_style.backgroundBox },
    },
  } as any);

  await writeFile(OUT, await dlBuf(r2Key));
  const wallClockSeconds = (Date.now() - wallClockStart) / 1000;
  console.log(`\n✅ DONE -> ${OUT}`);
  console.log(`   total wall-clock: ${wallClockSeconds.toFixed(1)}s (${(wallClockSeconds / 60).toFixed(1)} min), scene concurrency=${SCENE_CONCURRENCY}`);
  console.log(`   FINAL VIDEO DURATION: ${cum.toFixed(1)}s across ${script.scenes.length} scenes (tier target: ${tier.seconds}s)`);
}
main().catch((e) => { console.error('\n❌ FAILED:', e); process.exit(1); });
