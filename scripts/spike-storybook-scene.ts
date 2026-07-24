// scripts/spike-storybook-scene.ts
// Step 3: place the cartoon character into a NEW scene; check identity survives.
import 'dotenv/config';
import Replicate from 'replicate';
import { writeFile, readFile } from 'fs/promises';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

(async () => {
  const cartoon = await readFile('/tmp/storybook_spike/2_cartoon.png');
  const dataUri = `data:image/png;base64,${cartoon.toString('base64')}`;

  console.log('step 3: same character, new scene...');
  const scene = await replicate.run('openai/gpt-image-2' as `${string}/${string}`, {
    input: {
      prompt:
        "Take this 3D animated-film storybook character and show her in a NEW scene: riding a red bicycle along a forest path, full body visible, autumn leaves falling, warm golden light, same Pixar-style 3D animation look. CRITICAL: keep the exact same character — same face, same big brown eyes, same curly brown hair in two puffs, same yellow raincoat. Children's book illustration, wide composition.",
      input_images: [dataUri],
      aspect_ratio: '3:2',
    },
  });
  const urls = (Array.isArray(scene) ? scene : [scene]).map(String);
  const res = await fetch(urls[0]);
  await writeFile('/tmp/storybook_spike/3_scene.png', Buffer.from(await res.arrayBuffer()));
  console.log('saved → /tmp/storybook_spike/3_scene.png');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
