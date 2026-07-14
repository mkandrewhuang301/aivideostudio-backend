// src/config/presetMusic.ts
//
// Server-side registry of bundled preset background-music tracks for the Edit Studio Audio
// track's "preset music" option (Phase 13, sketch's green Audio track row). Mirrors the
// bundled-asset convention already used by src/config/presets.ts (`driving_video_url`/
// `driver_video_asset`) — this file is the source of truth for which tracks exist and where
// their audio lives in R2; the actual .m4a files are NOT committed to git (see
// assets/audio/README.md) — they are uploaded to the main R2 bucket the same way clip/audio
// assets are downloaded by the ffmpeg compose worker (src/storage/r2.ts's `r2`/`R2_BUCKET`
// client, NOT the separate public-assets bucket used by preset-art marketing content, since
// these tracks are consumed server-side by the ffmpeg worker via the same private
// `downloadR2KeyToFile` pattern as clips/audio — see ffmpegProcessor.ts).
//
// Run `npm run upload:preset-music` (src/scripts/uploadPresetMusic.ts) to (re)upload the source
// files listed in assets/audio/README.md to their r2Key below.

export interface PresetMusicTrack {
  id: string;
  title: string;
  r2Key: string;
  durationSeconds: number;
}

export const PRESET_MUSIC: PresetMusicTrack[] = [
  {
    id: 'upbeat-corporate',
    title: 'Upbeat Corporate',
    r2Key: 'preset-music/upbeat-corporate.m4a',
    durationSeconds: 220,
  },
  {
    id: 'carefree',
    title: 'Carefree',
    r2Key: 'preset-music/carefree.m4a',
    durationSeconds: 205,
  },
  {
    id: 'sneaky-snitch',
    title: 'Sneaky Snitch',
    r2Key: 'preset-music/sneaky-snitch.m4a',
    durationSeconds: 137,
  },
  {
    id: 'cheery-monday',
    title: 'Cheery Monday',
    r2Key: 'preset-music/cheery-monday.m4a',
    durationSeconds: 80,
  },
];
