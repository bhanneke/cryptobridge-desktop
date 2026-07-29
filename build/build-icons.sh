#!/usr/bin/env bash
# Regenerate the vendored Material Symbols subset from the icon names actually
# used in src/index.html.
#
# Why this exists: the font is subsetted to the icons the app uses, so an icon
# name that is not in the subset silently renders as its *ligature text* — a
# button reading "GROUPS" instead of showing a group glyph. Nothing fails; it
# just looks broken. Run this after adding an icon.
#
#   npm run build:icons
#
# The fetch talks to Google Fonts at build time only. The resulting .woff2 is
# committed and served from src/vendor/fonts/, so the app makes no network
# request at runtime (bright line: no CDN, no phone-home).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT="src/vendor/fonts/material-symbols-subset.woff2"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

ICONS=$(grep -oE 'material-symbols-outlined[^>]*>[a-z_]+<' src/index.html \
  | sed 's/.*>\([a-z_]*\)</\1/' | sort -u | paste -sd, -)

if [ -z "$ICONS" ]; then
  echo "no icon names found in src/index.html" >&2
  exit 1
fi
echo "icons: $ICONS"

# Fixed opsz/wght/GRAD, but keep the FILL axis: the UI sets
# font-variation-settings: 'FILL' 1 on a couple of glyphs.
URL="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0..1,0&icon_names=${ICONS}&display=block"

CSS=$(curl -fsS -A "$UA" "$URL")
FONT_URL=$(printf '%s' "$CSS" | grep -oE 'https://fonts\.gstatic\.com/[^)]+')
if [ -z "$FONT_URL" ]; then
  echo "could not find a woff2 URL in the Google Fonts response" >&2
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsS "$FONT_URL" -o "$TMP"

# Refuse to install anything that is not actually a woff2.
case "$(file -b "$TMP")" in
  *"Web Open Font Format (Version 2)"*) ;;
  *) echo "downloaded file is not a woff2: $(file -b "$TMP")" >&2; exit 1 ;;
esac

mv "$TMP" "$OUT"
trap - EXIT
echo "wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
