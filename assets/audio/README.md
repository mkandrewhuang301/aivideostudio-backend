# Preset Background Music

The actual audio files backing `src/config/presetMusic.ts`'s `PRESET_MUSIC` registry are **not
committed to git** — they are uploaded directly to R2 under the `preset-music/` prefix in the
main (private) R2 bucket, the same bucket the ffmpeg compose worker already downloads clip/audio
assets from (`src/storage/r2.ts`'s `r2`/`R2_BUCKET` client — NOT the separate public-assets
bucket used for preset-art marketing loops/posters).

Run `npm run upload:preset-music` (`src/scripts/uploadPresetMusic.ts`) to (re)upload the source
files below. The script downloads each track fresh from its royalty-free source URL, transcodes
it to AAC/`.m4a` via `ffmpeg`, and `PutObjectCommand`s it to the `r2Key` declared in
`presetMusic.ts` — there is no local source-file directory to keep in sync; the script is the
single source of truth for "where does this track come from."

## Tracks

All four tracks are by Kevin MacLeod (incompetech.com), licensed under
[Creative Commons: By Attribution 4.0 (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
Attribution requirement: credit "Kevin MacLeod (incompetech.com)" wherever the app's music
credits/about page lists third-party assets (tracked as a follow-up copy task, not blocking this
plan).

| id | title | source |
|----|-------|--------|
| `upbeat-corporate` | Upbeat Corporate (source track: "Wallpaper") | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wallpaper.mp3 |
| `carefree` | Carefree | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3 |
| `sneaky-snitch` | Sneaky Snitch | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Sneaky%20Snitch.mp3 |
| `cheery-monday` | Cheery Monday | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Cheery%20Monday.mp3 |

Full incompetech.com licensing terms: https://incompetech.com/wp-sun/licensing/
