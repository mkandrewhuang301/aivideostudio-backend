// Server-driven Cast registry. Default characters begin as look-only `soon` rows so their
// presentation can ship before adoption, anchor art, and real voice IDs are enabled.

export const CHARACTERS_VERSION = 1;

export type CharacterCategory = 'popular' | 'anime' | '3d_generated';
export type CharacterStatus = 'soon' | 'live';

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
];

/** Client-safe projection. Future anchor keys and provider voice IDs must never leave server. */
export const CLIENT_CHARACTERS = SERVER_CHARACTERS.map((def) => {
  const { anchor_r2_key, voice_id, ...clientCharacter } = def;
  return clientCharacter;
});
