# jason_portfolio

A single-page resume site with a terminal aesthetic. Everything is in
`index.html` — markup, styles, script, and an embedded font subset. No
framework, no build step, no dependencies.

```
index.html    the entire site
assets/       resume PDF + the headshot the portrait is generated from
tools/        authoring scripts, never run to serve the site
```

## Running it

Open `index.html`. It works from `file://` as well as over HTTP:

```sh
python3 -m http.server
```

## Deploying

GitHub Pages, no workflow needed: **Settings → Pages → Deploy from a branch →
`main` / `/ (root)`**.

## Editing

`index.html` is the source of truth — edit it directly. Two blobs inside it are
generated, and both have a script that reproduces them:

```sh
python3 -m venv tools/.venv && tools/.venv/bin/pip install fonttools brotli pillow

tools/make-font-subset.sh                  # -> tools/out/glyphs.woff2.b64
tools/.venv/bin/python tools/make-portrait.py --cols 44 --contrast 2.0
toilet -f mono12 JASON; toilet -f mono12 GRILLER
```

Paste the output into the `@font-face` `src`, the `.art--port` `<pre>`, and the
`.art--name` `<pre>` respectively.

## Why a font is embedded

JetBrains Mono contains **no braille** (U+2800–28FF) and **no block elements**
(U+2580–259F) — not in any build, including the Nerd Font patched ones
([JetBrainsMono#630](https://github.com/JetBrains/JetBrainsMono/issues/630)) —
and Google Fonts serves neither. The spinners and the ASCII name are made
entirely of those glyphs.

Without the subset the browser picks a per-glyph fallback at a different advance
width — DejaVu Sans is +22%, Noto Sans Mono CJK is +100% — which shears the
ASCII art apart and sizes the spinner grid differently on every OS.

So `index.html` embeds ~2.9 KB of [Adwaita Mono](https://gitlab.gnome.org/GNOME/adwaita-fonts)
(SIL OFL 1.1), subset to just the ranges it needs. Its advance is 600/1000em,
identical to JetBrains Mono, so no `size-adjust` is required. It is declared
under its own family name (`Terminal Glyphs`) rather than as JetBrains Mono, so
the OFL Reserved Font Name clause is not engaged.

Verified: 20 `M`, 20 `⣿`, 20 `█` and 20 spaces all measure exactly 1200.0px at
`font-size: 100px`.

## Things that will bite you

- **`line-height` and the portrait's row count are coupled.** Braille dots are
  only square at `line-height: 1.2`, and `tools/make-portrait.py` derives rows
  from that constant. Change one, change both.
- **The name art needs `line-height: 1`.** Block glyphs are taller than 1em, so
  at 1 they butt cleanly against the row below. If seams appear, go *down*
  toward .95 — never up, or a hairline runs through the letters.
- **The hero stacks at 55rem**, derived from the portrait needing ≥10px for its
  dots to stay distinct in a `4fr` track. Not a round number on purpose.
- **`--fg-faint` may only appear on `aria-hidden` elements.** It is below WCAG AA
  for text and is ornament-only. Greppable invariant.
- **Spinner frames must close.** Frames are precomputed and indexed `% f`, so a
  predicate whose natural period isn't exactly `f` visibly jumps at the wrap.
  Sinusoidal ones advance phase by exactly `2π/f`.

## Licence

Site content © Jason Griller. Embedded font subset: Adwaita Mono, SIL OFL 1.1.
