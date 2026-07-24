// scripts/spike-storybook-likeness.ts
// Run with: npx tsx scripts/spike-storybook-likeness.ts
// Storybook spike: (1) generate a photoreal kid portrait, (2) convert it to a
// cartoon storybook character via img2img, (3) save both for likeness comparison.
import 'dotenv/config';
import Replicate from 'replicate';
import { writeFile, mkdir } from 'fs/promises';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const OUT_DIR = '/tmp/storybook_spike';

async function saveOutput(output: unknown, path: string) {
  const urls = (Array.isArray(output) ? output : [output]).map((o) =>
    typeof o === 'string' ? o : String(o)
  );
  const res = await fetch(urls[0]);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  console.log(`saved → ${path}`);
}

(async () => {
  await mkdir(OUT_DIR, { recursive: true });

  // Step 1: photoreal kid portrait
  console.log('step 1: generating photoreal portrait...');
  const portrait = await replicate.run('openai/gpt-image-2' as `${string}/${string}`, {
    input: {
      prompt:
        'Photorealistic portrait photo of a cheerful 7-year-old girl with curly brown hair in two puffs, wearing a yellow raincoat, soft daylight, park background slightly blurred, head-and-shoulders, looking at camera, gentle smile',
      aspect_ratio: '2:3',
    },
  });
  const portraitUrls = (Array.isArray(portrait) ? portrait : [portrait]).map(String);
  await saveOutput(portrait, `${OUT_DIR}/1_portrait.png`);

  // Step 2: cartoon conversion, likeness preserved
  console.log('step 2: converting to storybook cartoon character...');
  const cartoon = await replicate.run('openai/gpt-image-2' as `${string}/${string}`, {
    input: {
      prompt:
        "Turn this child into a cute 3D animated-film storybook character, Pixar-style. Keep the SAME identity: same face shape, same hairstyle and hair color, same yellow raincoat, same eye color, same smile. Big expressive eyes, soft rounded features, clean simple background, warm lighting, children's book illustration quality, head-and-shoulders portrait.",
      input_images: [portraitUrls[0]],
      aspect_ratio: '2:3',
    },
  });
  await saveOutput(cartoon, `${OUT_DIR}/2_cartoon.png`);

  console.log('done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
