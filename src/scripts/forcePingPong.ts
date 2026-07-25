// Force ONE reaction-nano scene through the REAL illustrated stage to eye-verify the ping-pong
// A->B->A playback (playbackOrderFor + xfade chain) — the one path neither e2e run exercised
// because the allocator never granted nano to a reaction/ambient scene. Bypasses the allocator
// (resolvedNano: true) but everything else is the production path: gpt-image-2 base still, VLM
// judge on still + edit frame, nanoEditStill, buildMotionSequenceArgs, R2 archive.
//   npx tsx src/scripts/forcePingPong.ts
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { FORMATS_BY_ID, type SceneMotion } from '../config/formats';
import { getGenerationPresignedUrl } from '../services/archivalService';
import { illustratedStage, resolveMotionPlan } from '../services/explainerVisualStage';

const OUT = '/tmp/force-pingpong-reaction.mp4';
// Reuse the e2e v3 flat-vector style swatch (saves a generation + keeps style identical).
const ANCHOR_KEY = 'generations/e2e-illustrated-1784992534875.anchor.png';

async function main() {
  const def = FORMATS_BY_ID['explainer']!;
  const motion: SceneMotion = {
    type: 'reaction',
    priority: 5,
    // 2026-07-25 ruling: reaction = oscillating MOVEMENT only. The propeller swings A->B->A and
    // reads as spin; the pilot's face must stay identical across frames.
    edit_steps: [
      "the biplane's propeller blades rotate to a different spun position, keep everything else "
      + 'identical — the pilot\'s face and expression stay exactly the same',
    ],
  };
  const plan = resolveMotionPlan(motion, true); // forced nano grant — the whole point
  console.log('forced plan:', JSON.stringify(plan));

  const genId = `force-pingpong-${Date.now()}`;
  const { clipR2Key } = await illustratedStage.generateSceneClip({
    generationId: genId,
    sceneIndex: 0,
    visualPrompt:
      'Clean modern editorial flat-vector illustration (bold flat color shapes, crisp edges, '
      + 'minimal shading) of a 1903 pioneer pilot lying prone at the controls of a wooden biplane '
      + 'on sandy dunes, calm focused expression, cream sky, navy and orange palette. '
      + 'Reserve the lower third empty for captions. No text.',
    motionPrompt: '',
    styleAnchorUrl: await getGenerationPresignedUrl(ANCHOR_KEY),
    imageModel: def.image_model,
    omniModel: def.omni_model,
    narrationDurationSeconds: 5,
    aspectRatio: '9:16',
    motion,
    resolvedNano: true,
    textZone: 'lower_third',
    regenBudget: { remaining: 1 },
    styleLabel: 'Flat Vector',
  });

  const res = await fetch(await getGenerationPresignedUrl(clipR2Key));
  if (!res.ok) throw new Error(`clip download ${res.status}`);
  await writeFile(OUT, Buffer.from(await res.arrayBuffer()));
  console.log(`DONE -> ${OUT} (${clipR2Key})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
