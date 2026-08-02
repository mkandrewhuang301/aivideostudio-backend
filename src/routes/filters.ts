// src/routes/filters.ts
// Public endpoint — no auth required. Returns the Studio filter catalog so the picker's chip rows
// and display names come from the server, mirroring the serve-config-from-backend pattern in
// routes/rates.ts.
//
// This does NOT make filters fully server-driven the way presets are: a filter is a .cube lookup
// table that must ship inside the app bundle, so ADDING one still needs an app release. What this
// buys is the ability to pull or rename a look without one — an id the client cannot resolve
// would preview ungraded and then change appearance on export, which is worse than not offering
// it at all.

import { Router } from 'express';
import { filterCatalog } from '../config/filters';

export const filtersRouter = Router();

filtersRouter.get('/', (_req, res) => {
  try {
    res.status(200).json({ filters: filterCatalog() });
  } catch (err) {
    console.error('[filters] Error reading filter catalog:', err);
    res.status(500).json({ error: 'Failed to load filter catalog' });
  }
});
