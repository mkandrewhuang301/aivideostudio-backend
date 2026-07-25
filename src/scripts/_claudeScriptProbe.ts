// Throwaway probe (2026-07-24): one live expandExplainerScript call on the Claude Sonnet 5 path,
// same args as e2eIllustrated.ts, printing the FULL script so we can eyeball factual care in
// visual_prompts (the gpt-4o failure class: two pilots on the 1903 Flyer, generic modern engine).
//   npx tsx src/scripts/_claudeScriptProbe.ts
import 'dotenv/config';
import { FORMATS_BY_ID } from '../config/formats';
import { expandExplainerScript } from '../services/openaiScriptService';
import { EXPLAINER_NARRATION_TEMPO } from '../services/geminiTtsService';

async function main() {
  const def = FORMATS_BY_ID['explainer']!;
  const tier = def.duration_tiers.find((t) => t.seconds === 30)!;
  const t0 = Date.now();
  const script = await expandExplainerScript({
    topic: 'How the Wright brothers achieved the first powered airplane flight in 1903',
    sceneCount: tier.illustrated_scene_count,
    styleLabel: 'Flat Vector',
    scriptTemplate: def.script_template,
    visualMethod: 'illustrated',
    targetTotalSeconds: tier.seconds * EXPLAINER_NARRATION_TEMPO,
  });
  console.log(`\n=== Claude script (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
  console.log(`scenes: ${script.scenes.length}  music_mood: ${script.music_mood}`);
  console.log(`\nFULL SCRIPT:\n${script.full_script}\n`);
  script.scenes.forEach((s, i) => {
    console.log(`--- scene ${i} [motion=${s.motion?.type ?? 'none'} p${s.motion?.priority ?? '-'} edits=${s.motion?.edit_steps.length ?? 0}] transition=${s.transition_out ?? 'cut'}`);
    console.log(`narration: ${s.narration_line}`);
    console.log(`visual:    ${s.visual_prompt}`);
    if (s.motion?.edit_steps.length) console.log(`steps:     ${JSON.stringify(s.motion.edit_steps)}`);
  });
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
