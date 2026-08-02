#!/usr/bin/env bash
# Copies the generated .cube pack + catalog into the iOS app bundle.
#
# The SAME files must exist on both sides. That is the entire parity mechanism for Studio filters:
# CoreImage's CIColorCubeWithColorSpace and ffmpeg's lut3d are both plain table lookups, so as long
# as they read identical data the live preview, the on-device export, and the cloud compose cannot
# disagree about what a look is. Re-derive a grade from parameters on either side and they drift.
#
# Run after any change to scripts/generate-filter-luts.mjs:
#   node scripts/generate-filter-luts.mjs
#   ./scripts/sync-luts-to-ios.sh [path-to-ios-repo]
#
# The files still have to be added to the Xcode target as a folder reference (blue folder) so they
# land in the bundle — see FilterCatalog.swift for how they are resolved at runtime.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/assets/luts"
IOS_REPO="${1:-$HOME/aivideostudio-ios}"
DEST="$IOS_REPO/Fantasia/Resources/Luts"

if [ ! -d "$SRC" ]; then
  echo "error: no LUT pack at $SRC — run 'node scripts/generate-filter-luts.mjs' first" >&2
  exit 1
fi

if [ ! -d "$IOS_REPO" ]; then
  echo "error: no iOS repo at $IOS_REPO" >&2
  exit 1
fi

mkdir -p "$DEST"
# --delete so a filter removed from the generator disappears from the bundle too, rather than
# lingering as an id the server no longer serves.
rsync -a --delete "$SRC"/ "$DEST"/

echo "synced $(ls -1 "$DEST"/*.cube | wc -l | tr -d ' ') LUTs + catalog.json -> $DEST"
