// Test scenery/prompt quality: generate real explainer scene stills with DETAILED, SPECIFIC,
// no-baked-text prompts (the specificity rule) at medium quality, to judge whether gpt-image-2
// makes good, accurate scene imagery before we build. Replicate (not Google-quota-limited).
//
// Run: cd ~/aivideostudio-backend && npx tsx src/scripts/spikeScenery.ts
// env: REPLICATE_API_TOKEN

import 'dotenv/config';
import Replicate from 'replicate';
import { writeFileSync } from 'node:fs';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const OUT = '/private/tmp/claude-501/-Users-andrewhuang/d82628cb-4797-48e3-8a74-1256a92b5754/scratchpad';
const STYLE = 'flat vector illustration, bold clean outlines, muted pastel palette, minimal flat shading, no text';

// Specific, factually-oriented, caption-zone-aware photosynthesis scenes (no baked-in text).
const SCENES = [
  { tag: 'sc1', p: 'a detailed cross-section of a green leaf: waxy top surface, rows of tall cells beneath packed with small round green chloroplasts, warm yellow sunbeams striking the top surface, clean empty lower third' },
  { tag: 'sc2', p: 'a leafy green plant growing in brown soil, its roots visible underground drawing up blue water droplets, a bright smiling sun in a clear blue sky above, clean empty lower third for captions' },
  { tag: 'sc3', p: 'a close-up of a single broad green leaf with small round oxygen bubbles floating up off its surface into the air, faint blue swirls of air flowing toward the leaf, soft sunlight from above, minimal composition' },
];

function toUrl(o: any): string {
  const v = Array.isArray(o) ? o[0] : o;
  if (typeof v === 'string') return v;
  if (v?.url && typeof v.url === 'function') return String(v.url());
  if (v?.url) return String(v.url);
  throw new Error('no url');
}

async function main() {
  if (!process.env.REPLICATE_API_TOKEN) { console.error('need REPLICATE_API_TOKEN'); process.exit(1); }
  for (const s of SCENES) {
    const t0 = Date.now();
    const out = await replicate.run('openai/gpt-image-2', { input: { prompt: `${STYLE}. ${s.p}.`, aspect_ratio: '16:9', quality: 'medium' } });
    const buf = Buffer.from(await (await fetch(toUrl(out))).arrayBuffer());
    writeFileSync(`${OUT}/scenery-${s.tag}.png`, buf);
    console.log(`✅ ${s.tag}: ${((Date.now() - t0) / 1000).toFixed(0)}s → scenery-${s.tag}.png`);
  }
  console.log('\nDone. View scenery-sc1/sc2/sc3.png — judge specificity, accuracy, caption-zone.');
}
main().catch((e) => { console.error('crashed:', e.message ?? e); process.exit(1); });
