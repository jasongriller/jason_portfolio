#!/usr/bin/env bash
# Regenerate the inline WOFF2 glyph subset embedded in index.html.
#
# Why this exists: JetBrains Mono ships NO braille (U+2800-28FF), no block
# elements (U+2580-259F), and no check mark. Google Fonts serves none of them
# either. Without this subset the browser substitutes a per-glyph fallback at a
# different advance width, which shears the ASCII art apart and makes the
# spinner grid jitter differently on every OS.
#
# Adwaita Mono's advance is exactly 600/1000em -- identical to JetBrains Mono --
# so no size-adjust is required. `node tools/verify.mjs font` re-checks that in a
# real browser: every glyph in the subset must measure the same as the body font.
#
# Source font: Adwaita Mono, SIL Open Font License 1.1.
#   https://gitlab.gnome.org/GNOME/adwaita-fonts
# Subsetting and embedding are expressly permitted by the OFL. The subset is
# declared in index.html under its own family name ('Terminal Glyphs'), never
# under the JetBrains Mono family, so the OFL Reserved Font Name clause is not
# engaged.
#
# Usage:  tools/make-font-subset.sh   ->  writes tools/out/glyphs.woff2.b64
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=/usr/share/fonts/adwaita-mono-fonts/AdwaitaMono-Regular.ttf
OUT=tools/out
PY=tools/.venv/bin/python

# U+0020  space                  (the mono12 name art is spaces + block glyphs;
#                                without it the spaces would resolve from a
#                                different font and shear the art apart)
# U+2192  right arrow            (log prefix)
# U+2500-259F  box drawing + block elements  (rules, name art, block cursor)
# U+25B2  black up triangle      (warn prefix; Adwaita has no U+26A0)
# U+2713  check mark             (log prefix)
# U+2800-28FF  braille           (spinners, portrait, corner ornaments)
RANGES='U+0020,U+2192,U+2500-259F,U+25B2,U+2713,U+2800-28FF'

mkdir -p "$OUT"
[ -f "$SRC" ] || { echo "source font missing: $SRC" >&2; exit 1; }

"$PY" -m fontTools.subset "$SRC" \
  --unicodes="$RANGES" \
  --flavor=woff2 \
  --layout-features='' \
  --no-hinting \
  --desubroutinize \
  --name-IDs='' \
  --drop-tables+=DSIG \
  --output-file="$OUT/glyphs.woff2"

base64 -w0 "$OUT/glyphs.woff2" > "$OUT/glyphs.woff2.b64"

printf 'woff2  %6s bytes\nbase64 %6s bytes\n' \
  "$(stat -c%s "$OUT/glyphs.woff2")" "$(stat -c%s "$OUT/glyphs.woff2.b64")"
