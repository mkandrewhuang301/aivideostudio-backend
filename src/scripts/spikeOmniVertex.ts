// Wave-0 spike (2026-07-20) — VERTEX-DIRECT half. Answers Q3 and, on your GCP credits, finishes
// the stills matrix (Option A first-frame vs Option B refs-only) that fal's exhausted balance blocked.
//
// Q3 decision points this script settles:
//   (1) Does ADC auth reach gemini-omni-flash-preview WITHOUT an allowlist wall? (401 vs 403 vs 200)
//   (2) Does the call bill the GCP credit project? (check billing after a success)
//   (3) Does the raw Interactions API let us request a specific DURATION? (fal's wrapper does; the
//       documented raw body only exposes response_format.aspect_ratio — CONFIRM whether duration is
//       settable, because the whole "narration duration drives clip length" design depends on it.)
//
// Omni uses the NEW Interactions API (NOT Veo's :predictLongRunning). Verified body shape from
// ai.google.dev/gemini-api/docs/omni:
//   { model, input: [ {type:"image", data:<base64>, mime_type}, {type:"text", text:"...<IMAGE_REF_0>..."} ],
//     response_format: { type:"video", aspect_ratio:"16:9" } }
//   Output arrives in a `steps` array; for >4MB add "delivery":"uri" and poll the Files API.
//
// ⚠️ ENDPOINT URL IS UNVERIFIED for the Vertex/credit-eligible host. The Gemini API (AI Studio)
//    host is confirmed: https://generativelanguage.googleapis.com/v1beta/interactions?key=API_KEY
//    — but an AI Studio API key may NOT bill your GCP credit account. The credit-eligible path is
//    aiplatform.googleapis.com with an ADC bearer token; its exact interactions path is a best
//    guess below. When you run this, grab the exact REST URL from the "Ingredients to videos with
//    image references" doc's REST tab and set OMNI_VERTEX_URL to it.
//
// Run:
//   gcloud auth application-default login          # one time
//   export GCP_PROJECT=your-project-id
//   export GCP_LOCATION=us-central1                # or global
//   cd ~/aivideostudio-backend
//   npx tsx src/scripts/spikeOmniVertex.ts <mode>
//     modes: refs (Option B, default) | firstframe (Option A) | aistudio (mechanism check via API key)

import 'dotenv/config';
import { GoogleAuth } from 'google-auth-library';

const MODEL = 'gemini-omni-flash-preview';
const PROJECT = process.env.GCP_PROJECT ?? '';
const LOCATION = 'global';
const ANCHOR_URL = process.env.SPIKE_ANCHOR_URL ?? 'https://picsum.photos/seed/explainer-anchor/1024/1024';

// Documented Gemini Enterprise Agent Platform Interactions endpoint.
const VERTEX_URL =
  process.env.OMNI_VERTEX_URL ??
  `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/interactions`;
const AISTUDIO_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const SCENE = 'a single green leaf on a plant, warm morning sunlight streaming onto it, gentle slow camera push-in';

async function fetchBase64(url: string): Promise<{ data: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`anchor fetch failed ${res.status}`);
  const mime = res.headers.get('content-type') ?? 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString('base64'), mime };
}

// Option B: refs only. Option A: same anchor tagged as the FIRST_FRAME so Omni animates from it.
function buildBody(mode: 'refs' | 'firstframe', img: { data: string; mime: string }) {
  const text =
    mode === 'firstframe'
      ? `Animate from <FIRST_FRAME>: ${SCENE}.`
      : `In the exact art style of <IMAGE_REF_0>, show ${SCENE}.`;
  return {
    model: MODEL,
    input: [
      { type: 'text', text },
      { type: 'image', data: img.data, mime_type: img.mime },
    ],
    response_format: [{ type: 'video', delivery: 'uri', aspect_ratio: '16:9', duration: '3s' }],
    generation_config: {
      video_config: { task: mode === 'firstframe' ? 'image_to_video' : 'reference_to_video' },
    },
  };
}

function diagnose(status: number): string {
  if (status === 200) return '✅ 200 — reachable, no allowlist wall. Now check billing hit the credit project.';
  if (status === 401) return '🔑 401 — auth failed. Re-run `gcloud auth application-default login`.';
  if (status === 403) return '⛔ 403 — permission/ALLOWLIST wall OR API not enabled. This is the Q3 blocker to confirm.';
  if (status === 404) return '❓ 404 — wrong endpoint path or model id. Set OMNI_VERTEX_URL from the docs REST tab.';
  return `⚠️ ${status} — see body below.`;
}

async function runVertex(mode: 'refs' | 'firstframe') {
  if (!PROJECT) {
    console.error('GCP_PROJECT not set. export GCP_PROJECT=your-project-id');
    process.exit(1);
  }
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const token = await auth.getAccessToken();
  const img = await fetchBase64(ANCHOR_URL);

  console.log(`POST ${VERTEX_URL}\nmode=${mode} model=${MODEL}\n`);
  const t0 = Date.now();
  const res = await fetch(VERTEX_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(mode, img)),
  });
  const ms = Date.now() - t0;
  const bodyText = await res.text();
  console.log(diagnose(res.status), `(${(ms / 1000).toFixed(1)}s)`);
  console.log('--- response (first 800 chars) ---');
  console.log(bodyText.slice(0, 800));
}

async function runAiStudio(mode: 'refs' | 'firstframe') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('GEMINI_API_KEY not set — aistudio mode needs an AI Studio key (does NOT use GCP credits).');
    process.exit(1);
  }
  const img = await fetchBase64(ANCHOR_URL);
  console.log(`POST ${AISTUDIO_URL} (mechanism check only — not credit-billed)\nmode=${mode}\n`);
  const res = await fetch(`${AISTUDIO_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(mode, img)),
  });
  console.log(diagnose(res.status));
  console.log((await res.text()).slice(0, 800));
}

async function main() {
  const mode = process.argv[2] ?? 'refs';
  if (mode === 'aistudio') return runAiStudio('refs');
  if (mode === 'firstframe') return runVertex('firstframe');
  if (mode === 'refs') return runVertex('refs');
  console.error(`unknown mode: ${mode} (use: refs | firstframe | aistudio)`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Vertex spike crashed:', err);
  process.exit(1);
});
