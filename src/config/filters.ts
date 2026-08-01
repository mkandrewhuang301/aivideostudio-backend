// src/config/filters.ts
//
// The Studio filter catalog. Every entry maps 1:1 to a generated LUT in assets/luts — the
// catalog.json read below is written by scripts/generate-filter-luts.mjs alongside the .cube
// files, so the list can never drift from the files that actually exist on disk.
//
// The SAME ids and the SAME .cube files ship inside the iOS bundle. That is the whole parity
// story: 'noir' means one specific lookup table, and the live preview, the on-device export, and
// this server's ffmpeg compose all read it rather than each re-deriving a look from parameters.
//
// Adding a filter: add it to scripts/generate-filter-luts.mjs, re-run the generator, copy the
// pack into the iOS bundle, ship both. There is deliberately no way to add one from the server
// alone — an id the client cannot resolve would preview as ungraded and then change appearance
// on export, which is worse than not offering it.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface FilterCatalogEntry {
  id: string;
  name: string;
  category: string;
}

/** Filesystem home of the generated pack. Mirrors how ffmpegProcessor resolves assets/fonts. */
export function lutsDir(): string {
  return path.resolve('assets/luts');
}

/** Absolute path to one filter's .cube file, for ffmpeg's `lut3d=file=`. */
export function lutPath(filterId: string): string {
  return path.join(lutsDir(), `${filterId}.cube`);
}

let cachedCatalog: FilterCatalogEntry[] | null = null;

export function filterCatalog(): FilterCatalogEntry[] {
  if (cachedCatalog) return cachedCatalog;
  const raw = readFileSync(path.join(lutsDir(), 'catalog.json'), 'utf8');
  cachedCatalog = JSON.parse(raw) as FilterCatalogEntry[];
  return cachedCatalog;
}

let cachedIds: Set<string> | null = null;

/**
 * Whether an id names a real LUT. Every write path validates through this so a typo is rejected
 * at the API boundary instead of surfacing as an unresolvable `lut3d=file=` path inside the
 * compose worker, where it would fail the whole export rather than one filter.
 */
export function isKnownFilterId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (!cachedIds) cachedIds = new Set(filterCatalog().map((entry) => entry.id));
  return cachedIds.has(id);
}

/** Test seam — the catalog is read once and memoized for the process lifetime otherwise. */
export function resetFilterCatalogCache(): void {
  cachedCatalog = null;
  cachedIds = null;
}
