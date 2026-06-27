// src/middleware/promptModeration.ts
// Two-layer prompt moderation:
//   Layer 1: Regex blocklist (zero latency, catches obvious violations)
//   Layer 2: OpenAI Moderation API (semantic/adversarial bypass detection)
// Both run in parallel via Promise.all. Either flag → reject with 400.
// Per CONTEXT.md: only check categories "sexual/minors" and "violence/graphic".
// Other OpenAI categories are informational only and do NOT block the request.

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

// Blocklist focused on: explicit sexual language, sexual body parts, minors in sexual context, extreme gore.
// Use word-boundary anchors (\b) to avoid false positives on substrings.
const BLOCKED_PATTERNS: RegExp[] = [
  // Explicit sexual terms
  /\b(nude|nudity|naked|nsfw|hentai|porn|porno|pornographic|xxx|erotic|erotica|orgasm|masturbat(e|ion)|ejaculat(e|ion)|cumshot|sex scene|sex tape|onlyfans)\b/i,
  // Explicit sexual body parts (standalone, not anatomical education context)
  /\b(penis|vagina|vulva|clitoris|testicle|scrotum|genitals?|butthole|asshole|anus)\b/i,
  // Minors in sexual context — two-direction pattern catches both orderings
  /\b(child|minor|underage|shota|loli|lolita|preteen|pre-teen)\b.{0,60}\b(nude|naked|sex(ual)?|porn|erotic|genital|fondle|molest|rape|assault)\b/i,
  /\b(nude|naked|sex(ual)?|porn|erotic|genital|fondle|molest|rape|assault)\b.{0,60}\b(child|minor|underage|shota|loli|lolita|preteen|pre-teen)\b/i,
  // Extreme gore / snuff
  /\b(gore|snuff film|torture porn|mutilat(e|ion|ed|ing)|decapitat(e|ion|ed|ing)|dismember(ment|ed|ing)?|beheading|execution video)\b/i,
];

interface OpenAIModerationResponse {
  results: Array<{
    categories: {
      'sexual/minors': boolean;
      'violence/graphic': boolean;
      [key: string]: boolean;
    };
  }>;
}

async function checkOpenAIModeration(prompt: string): Promise<boolean> {
  const response = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'omni-moderation-latest', input: prompt }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI Moderation API error: ${response.status}`);
  }

  const data = (await response.json()) as OpenAIModerationResponse;
  const result = data.results[0];
  // Only block on categories that are unambiguously illegal/CSAM — per CONTEXT.md decision
  return result.categories['sexual/minors'] === true || result.categories['violence/graphic'] === true;
}

export async function promptModerationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const prompt = req.body?.prompt;

  // If no prompt (or not a string), skip moderation — prepareCost will handle validation
  if (!prompt || typeof prompt !== 'string') {
    next();
    return;
  }

  try {
    // Run both checks in parallel — neither waits for the other
    const [blocklistFlagged, openAiFlagged] = await Promise.all([
      Promise.resolve(BLOCKED_PATTERNS.some((pattern) => pattern.test(prompt))),
      checkOpenAIModeration(prompt),
    ]);

    if (blocklistFlagged || openAiFlagged) {
      res.status(400).json({
        error: 'This prompt violates our content policy',
        code: 'content_policy_violation',
      });
      return;
    }

    next();
  } catch (err) {
    console.error('[promptModeration] Moderation check failed:', err);
    res.status(500).json({ error: 'Moderation check failed' });
  }
}
