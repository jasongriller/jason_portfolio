# jason_portfolio

A single-page resume site with a terminal aesthetic. Everything is in
`index.html` — markup, styles, script, and an embedded font subset. No
framework, no build step, no dependencies.

```
index.html    the entire site
assets/       the resume PDF (the only thing the page links out to)
tools/        authoring scripts + the headshot they read, never run to serve the site
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

## The layout system

A terminal has exactly two units: **one column and one row**. The reference this
is modelled on puts every line on a 28px pitch and makes every gap an integer
number of those rows — nothing is `1.65 ×` anything. So:

- **`line-height` is a length, not a ratio.** `line-height: var(--row)` on `body`
  inherits as a computed 24px, so a heading, a bullet and a wrapped paragraph all
  occupy exactly one row. This one declaration is the whole vertical rhythm.
- **There is one font-size.** That makes `1ch` the same 9px page-wide, so the 2ch
  log indent, the 6ch spinner box, the 2ch card padding and the 22ch nav column
  all land on one character grid.
- **Hierarchy is weight and brightness, not size** — which is ANSI's own system.
- **One rail.** Every block uses `.wrap` and nothing else, so there is exactly one
  left edge. If you add a section, give it `.wrap`.

## Things that will bite you

- **`line-height` and the portrait's row count are coupled.** Braille dots are
  only square at `line-height: 1.2`, and `tools/make-portrait.py` derives rows
  from that constant. Change one, change both.
- **The name art needs `line-height: 1`.** Block glyphs are taller than 1em, so
  at 1 they butt cleanly against the row below. If seams appear, go *down*
  toward .95 — never up, or a hairline runs through the letters.
- **The art divisors track the column count.** `100cqi / 41.4` is 69 columns ×
  0.6em; `100cqi / 26.4` is 44. Regenerate the art at a different width and both
  numbers must move with it.
- **The hero stacks at 49rem**, derived from the portrait track needing ≥264px so
  its dots stay distinct. Not a round number on purpose — redo the arithmetic if
  `--page` or the hero column gap changes.
- **`--fg-faint` may only appear on `aria-hidden` elements.** It is below WCAG AA
  for text and is ornament-only. Greppable invariant.
- **Don't use `ch` on anything in `--font-art`.** `ch` is the advance of `0` in
  the first available font, and that is `Terminal Glyphs`, which has no digits —
  a case the spec resolves as 0.5em. Use `0.6em`, the subset's real advance.
- **Spinner frames must close.** Frames are precomputed and indexed `% f`, so a
  predicate whose natural period isn't exactly `f` visibly jumps at the wrap.
  Sinusoidal ones advance phase by exactly `2π/f`. A frame must also never be
  all-blank, and no two consecutive frames may be identical, or the spinner
  visibly blinks out or stalls.
- **Nothing may start at `opacity: 0` except the boot log.** Anything hidden until
  an `animation-delay` elapses is blank to an immediate capture — Firefox's
  screenshot, a preview crawler, a slow first frame.

## Licence

Site content © Jason Griller. Embedded font subset: Adwaita Mono, SIL OFL 1.1.
