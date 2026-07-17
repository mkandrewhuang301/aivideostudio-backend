import express from 'express';
import request from 'supertest';
import {
  CHARACTERS_VERSION,
  CLIENT_CHARACTERS,
  SERVER_CHARACTERS,
} from '../../config/characters';
import { charactersRouter } from '../../routes/characters';

const app = express();
app.use('/api/characters', charactersRouter);

describe('characters registry config', () => {
  it('publishes the nine-row v0 roster across the three launch genres', () => {
    expect(CHARACTERS_VERSION).toBe(1);
    expect(SERVER_CHARACTERS).toHaveLength(9);
    expect(new Set(SERVER_CHARACTERS.map((row) => row.category))).toEqual(
      new Set(['popular', 'anime', '3d_generated']),
    );
  });

  it('keeps every v0 character look-only and server-swappable', () => {
    for (const character of SERVER_CHARACTERS) {
      expect(character.status).toBe('soon');
      expect(character.art_url).toMatch(/^https:\/\//);
      expect(character.bio).toBeTruthy();
      expect(character.voice_label).toBeTruthy();
    }
  });

  it('strips future anchor and voice IDs from client rows', () => {
    const serverOnlyFixture = {
      ...SERVER_CHARACTERS[0],
      anchor_r2_key: 'private/characters/nova/anchor-v1.png',
      voice_id: 'provider-voice-id',
    };
    const { anchor_r2_key, voice_id, ...expectedClientShape } = serverOnlyFixture;

    expect(expectedClientShape).not.toHaveProperty('anchor_r2_key');
    expect(expectedClientShape).not.toHaveProperty('voice_id');
    expect(JSON.stringify(CLIENT_CHARACTERS)).not.toContain('anchor_r2_key');
    expect(JSON.stringify(CLIENT_CHARACTERS)).not.toContain('voice_id');
  });
});

describe('GET /api/characters', () => {
  it('returns the versioned public character roster', async () => {
    const res = await request(app).get('/api/characters');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(CHARACTERS_VERSION);
    expect(res.body.characters).toEqual(CLIENT_CHARACTERS);
  });

  it('does not expose future server-only character fields', async () => {
    const res = await request(app).get('/api/characters');
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain('anchor_r2_key');
    expect(serialized).not.toContain('voice_id');
  });
});
