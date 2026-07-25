// Server-driven Cast registry. Default characters begin as look-only `soon` rows so their
// presentation can ship before adoption, anchor art, and real voice IDs are enabled.

export const CHARACTERS_VERSION = 1;

export type CharacterCategory = 'popular' | 'anime' | '3d_generated';
export type CharacterStatus = 'soon' | 'live';

/**
 * Character-vlog capability block (v1 one-shot, 2026-07-25 lock: user writes ONE beat → one
 * cheap LLM expansion pass → one Mini clip; the 7/24 multi-take planner shape is shelved).
 * Presence marks the character as selectable in the character-vlog format roster — independent
 * of the Cast page `status` (Cast stays look-only; the vlog roster is the live surface).
 *
 * The roster is ALL-NONHUMAN by design (Andrew lock): fictional characters never trip Mini's
 * real-face E005 rejection, so reference_images injection is safe.
 */
export interface CharacterVlogConfig {
  /** SERVER-ONLY. Persona + showrunner context injected into the planner system prompt. */
  persona_prompt: string;
  /** SERVER-ONLY. Framing prefix every resolved take prompt starts from (selfie-cam language). */
  vlog_framing_prefix: string;
  /** Bundled character reference sheet — injected into gpt-image-2 `input_images` for the
   *  per-take still (frame-first pipeline, 7/25 arm-C lock). Client-displayable URL. */
  sheet_url: string;
  /** SERVER-ONLY. R2 key of the canonical sheet the worker presigns for provider calls
   *  (sheet_url above is the client-facing twin; O-3 replaces both with final art). */
  sheet_r2_key?: string;
  /**
   * SERVER-ONLY. R2 key of the canonical qwen voice-clone reference clip (≤15s) for this
   * character. The worker clones EACH beat's spoken_line through qwen3-tts voice_clone against
   * this clip, and that per-beat audio goes to Mini as reference_audios — voice identity AND
   * lip-sync in one mechanism (2026-07-25 lock, supersedes the 7/24 "one pinned clip" spec).
   * OPTIONAL: while unset the worker skips the TTS stage and Mini rolls its own voice.
   */
  voice_reference_r2_key?: string;
  /** SERVER-ONLY. Transcript of the voice reference clip (qwen reference_text — raw clones
   *  look worse without it). */
  voice_reference_text?: string;
  /** qwen style_instruction + Mini-prompt delivery note (pace/energy), character-consistent. */
  default_voice_direction: string;
}

export interface CharacterDef {
  character_id: string;
  name: string;
  category: CharacterCategory;
  status: CharacterStatus;
  art_url: string;
  bio: string;
  voice_label: string;
  sort_order: number;
  /** SERVER-ONLY. Added when Andrew approves and uploads the canonical anchor art. */
  anchor_r2_key?: string;
  /** SERVER-ONLY. Real TTS wiring belongs to the later Cast phase, not v0. */
  voice_id?: string;
  /** Character-vlog roster membership. Partially SERVER-ONLY (see client projection below). */
  vlog?: CharacterVlogConfig;
}

function placeholderArt(characterId: string): string {
  return `https://assets.fantasia.example/characters/${characterId}/card-v1.jpg`;
}

export const SERVER_CHARACTERS: CharacterDef[] = [
  {
    character_id: 'nova',
    name: 'Nova',
    category: 'popular',
    status: 'soon',
    art_url: placeholderArt('nova'),
    bio: 'A fearless adventurer who turns every moment into a cinematic story.',
    voice_label: 'Kore — warm, grounded',
    sort_order: 1,
  },
  {
    character_id: 'milo',
    name: 'Milo',
    category: 'popular',
    status: 'soon',
    art_url: placeholderArt('milo'),
    bio: 'A quick-witted creator who always finds the funny side of the scene.',
    voice_label: 'Puck — bright, playful',
    sort_order: 2,
  },
  {
    character_id: 'sable',
    name: 'Sable',
    category: 'popular',
    status: 'soon',
    art_url: placeholderArt('sable'),
    bio: 'A poised storyteller with a taste for mystery and dramatic reveals.',
    voice_label: 'Aoede — clear, poised',
    sort_order: 3,
  },
  {
    character_id: 'aiko',
    name: 'Aiko',
    category: 'anime',
    status: 'soon',
    art_url: placeholderArt('aiko'),
    bio: 'A determined city dreamer chasing impossible goals with an open heart.',
    voice_label: 'Kore — warm, calm',
    sort_order: 1,
  },
  {
    character_id: 'ren',
    name: 'Ren',
    category: 'anime',
    status: 'soon',
    art_url: placeholderArt('ren'),
    bio: 'A cool rival whose quiet confidence hides a fiercely loyal side.',
    voice_label: 'Charon — steady, deep',
    sort_order: 2,
  },
  {
    character_id: 'emi',
    name: 'Emi',
    category: 'anime',
    status: 'soon',
    art_url: placeholderArt('emi'),
    bio: 'A high-energy optimist who can turn any setback into a new adventure.',
    voice_label: 'Leda — bright, expressive',
    sort_order: 3,
  },
  {
    character_id: 'byte',
    name: 'Byte',
    category: '3d_generated',
    status: 'soon',
    art_url: placeholderArt('byte'),
    bio: 'A curious little robot learning the wonderfully strange habits of humans.',
    voice_label: 'Puck — lively, curious',
    sort_order: 1,
  },
  {
    character_id: 'moss',
    name: 'Moss',
    category: '3d_generated',
    status: 'soon',
    art_url: placeholderArt('moss'),
    bio: 'A gentle forest guardian with ancient wisdom and an enormous soft spot.',
    voice_label: 'Fenrir — deep, kind',
    sort_order: 2,
  },
  {
    character_id: 'zuri',
    name: 'Zuri',
    category: '3d_generated',
    status: 'soon',
    art_url: placeholderArt('zuri'),
    bio: 'A bold space explorer who treats the unknown like an invitation.',
    voice_label: 'Aoede — confident, clear',
    sort_order: 3,
  },
  // The first vlogger (2026-07-24 lock): fictional gorilla, first entry of the all-nonhuman
  // vlog roster. Cast `status` stays 'soon' (look-only there) — the vlog block is what makes
  // him selectable in the character-vlog format.
  // TODO(art): sheet_url is placeholder art — replace with the real bundled gorilla character
  // sheet (and record the pinned qwen-clone voice_asset_url) once Andrew delivers the assets.
  {
    character_id: 'gorilla',
    name: 'Gorilla',
    category: '3d_generated',
    status: 'soon',
    art_url: placeholderArt('gorilla'),
    bio: 'A selfie-cam vlogger with big opinions and zero chill.',
    voice_label: 'Fenrir — deep, warm',
    sort_order: 99,
    vlog: {
      persona_prompt:
        'A charismatic gorilla who vlogs his daily life selfie-style. He is blunt, funny, ' +
        'weirdly wise, and talks to the camera like a close friend. He never breaks character, ' +
        'never mentions being AI, and treats ordinary topics with dramatic gorilla gravitas.',
      vlog_framing_prefix:
        'Selfie-cam vlog style, handheld phone camera framing: a gorilla vlogger holds up the ' +
        'phone to film themself talking directly to the camera, natural gestures, casual vlog ' +
        'energy.',
      sheet_url: 'https://assets.fantasia.example/characters/gorilla/sheet-v1.jpg',
      // Smoke-grade real art (Andrew's gorilla selfie, uploaded 2026-07-25) until O-3 final art.
      sheet_r2_key: 'assets/characters/gorilla/sheet-smoke.png',
      // Stand-in clone reference (harvard.wav 14s trim, smoke-proven 2026-07-25). No transcript
      // until the canonical clip lands — raw clone beat the unpinned baseline in the smoke.
      // TODO(O-3): Andrew's canonical gorilla voice clip + voice_reference_text transcript.
      voice_reference_r2_key: 'assets/characters/gorilla/voice-smoke-harvard.wav',
      default_voice_direction: 'warm, gravelly, conversational',
    },
  },
];

/** Roster for the character-vlog format: every character with a vlog block, registry order. */
export const VLOG_ROSTER: CharacterDef[] = SERVER_CHARACTERS.filter((def) => def.vlog);

/** Client-safe projection. Future anchor keys, provider voice IDs, and vlog prompt IP
 *  (persona/framing/voice asset) must never leave server — the client only needs to know the
 *  character is vlog-capable and which sheet art represents it. */
export const CLIENT_CHARACTERS = SERVER_CHARACTERS.map((def) => {
  const { anchor_r2_key, voice_id, vlog, ...clientCharacter } = def;
  return vlog
    ? { ...clientCharacter, vlog: { sheet_url: vlog.sheet_url } }
    : clientCharacter;
});
