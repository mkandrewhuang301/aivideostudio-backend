// scripts/test-grok-dispatch.ts
// Run with: npx tsx scripts/test-grok-dispatch.ts
// Live smoke test of the actual ReplicateProvider Grok Imagine branch — dispatches a real
// generation (costs ~$0.16 for a 2s clip) and polls getStatus() until it completes, since
// there's no public webhook to receive the callback in this standalone script.
import 'dotenv/config';
import { ReplicateProvider } from '../src/services/providers/ReplicateProvider';
import type { GenerationInput } from '../src/services/providers/ModelProvider';

async function main() {
  const provider = new ReplicateProvider();

  // Exact shape prepareCost()/POST handler would build for a Grok Imagine request.
  const input: GenerationInput = {
    prompt: 'Cinematic motion - the woman looks up out into the sunlight filtering into the room.',
    model: 'xai/grok-imagine-video-1.5',
    mediaType: 'video',
    durationSeconds: 2, // short + cheap for a smoke test — real app enforces 4-15s
    resolution: '720p',
    aspectRatio: '16:9',
    audioEnabled: true,
    referenceImages: [
      'https://replicate.delivery/pbxt/PCRhFZ9wvsy2oylrpkZqa9VyAhDfe7VQi0jOKERQF6tX2ddF/download-4.png',
    ],
  };

  console.log('Dispatching Grok Imagine Video 1.5...');
  const { providerPredictionId } = await provider.dispatch(input, 'https://example.com/webhooks/replicate');
  console.log(`Prediction created: ${providerPredictionId}`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await provider.getStatus(providerPredictionId);
    console.log(`[${i * 3}s] status=${status.status}`);
    if (status.status === 'succeeded') {
      console.log(`✓ SUCCEEDED — output: ${status.outputUrl}`);
      return;
    }
    if (status.status === 'failed' || status.status === 'canceled') {
      console.error(`✗ ${status.status.toUpperCase()}: ${status.error}`);
      process.exitCode = 1;
      return;
    }
  }
  console.error('✗ Timed out waiting for completion');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('✗ Dispatch threw:', err);
  process.exitCode = 1;
});
