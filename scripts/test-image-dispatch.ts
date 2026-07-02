// scripts/test-image-dispatch.ts
// Run with: npx tsx scripts/test-image-dispatch.ts
// Tests image model dispatch WITHOUT a webhook (synchronous run) to surface input errors.
import 'dotenv/config';
import Replicate from 'replicate';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const models: Array<{ id: string; input: Record<string, unknown> }> = [
  { id: 'bytedance/seedream-5-lite', input: { prompt: 'a red apple', aspect_ratio: '1:1', size: '2K' } },
  { id: 'bytedance/seedream-4.5',    input: { prompt: 'a red apple', aspect_ratio: '1:1', size: '2K' } },
  { id: 'openai/gpt-image-2',        input: { prompt: 'a red apple', aspect_ratio: '1:1' } },
];

async function testModel(id: string, input: Record<string, unknown>) {
  console.log(`\n--- ${id} ---`);
  console.log('Input:', JSON.stringify(input));
  try {
    // Create prediction without webhook — use wait:1s so Replicate at least validates the input
    const prediction = await replicate.predictions.create({
      model: id as `${string}/${string}`,
      input,
      wait: 1,
    });
    console.log(`✓ Prediction created: ${prediction.id} (status: ${prediction.status})`);
  } catch (err: unknown) {
    const e = err as Error;
    // Log full message so we see the Replicate API error body
    console.error(`✗ ${e.message}`);
  }
}

(async () => {
  for (const m of models) await testModel(m.id, m.input);
})();
