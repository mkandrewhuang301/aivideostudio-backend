import { and, eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { projectMusicSuggestionCache } from '../db/schema';
import { buildSoundtrackSnapshot, SoundtrackNotFoundError } from './soundtrackService';
import { soundtrackReferenceImages } from './soundtrackMediaService';

const TIMEOUT_MS = 30_000;

function responseText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }).candidates;
  const text = candidates?.[0]?.content?.parts?.find((part) => typeof part.text === 'string')?.text;
  return typeof text === 'string' ? text : undefined;
}

function validateSuggestions(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { suggestions?: unknown }).suggestions)) {
    throw new Error('Suggestion response was invalid');
  }
  const values = (raw as { suggestions: unknown[] }).suggestions;
  if (values.length !== 3) throw new Error('Suggestion response did not contain three choices');
  return values.map((value) => {
    if (typeof value !== 'string') throw new Error('Suggestion was not text');
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 180 || trimmed.includes('\n')) throw new Error('Suggestion length was invalid');
    return trimmed;
  });
}

export async function suggestionsForProject(projectId: string, userId: string): Promise<{
  suggestions: string[];
  cached: boolean;
}> {
  const built = await buildSoundtrackSnapshot(projectId, userId);
  if (!built) throw new SoundtrackNotFoundError();
  const [cached] = await db.select().from(projectMusicSuggestionCache).where(and(
    eq(projectMusicSuggestionCache.user_id, userId),
    eq(projectMusicSuggestionCache.project_id, projectId),
    eq(projectMusicSuggestionCache.project_fingerprint, built.fingerprint),
  ));
  if (cached) return { suggestions: validateSuggestions({ suggestions: cached.suggestions }), cached: true };
  if (!config.geminiApiKey) throw new Error('Music suggestions are not configured');

  const frames = await soundtrackReferenceImages(built.snapshot);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.aiMusicAnalysisModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: `Analyze these ordered frames from a ${built.snapshot.duration_seconds.toFixed(1)} second video with ${built.snapshot.clips.length} scenes. Return exactly three distinct, editable soundtrack directions. Each must be one sentence under 180 characters and describe genre, mood, pacing, and how the music evolves with the edit. Do not name artists or existing songs.` },
              ...frames.map((frame) => ({
                inlineData: { mimeType: frame.mimeType, data: frame.data.toString('base64') },
              })),
            ],
          }],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 300,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              required: ['suggestions'],
              properties: {
                suggestions: { type: 'ARRAY', minItems: 3, maxItems: 3, items: { type: 'STRING' } },
              },
            },
          },
        }),
      },
    );
    if (!response.ok) throw new Error(`Music suggestion request failed (${response.status})`);
    const text = responseText(await response.json());
    const suggestions = validateSuggestions(JSON.parse(text ?? '{}'));
    await db.insert(projectMusicSuggestionCache).values({
      user_id: userId,
      project_id: projectId,
      project_fingerprint: built.fingerprint,
      suggestions,
      provider: 'google',
      model: config.aiMusicAnalysisModel,
    }).onConflictDoNothing();
    return { suggestions, cached: false };
  } finally {
    clearTimeout(timer);
  }
}
