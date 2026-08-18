# jason_portfolio

A single-page resume site with a terminal aesthetic. Everything is in
`index.html` — markup, styles, script, and an embedded font subset. No
framework and no build step: what is in the repo is what the browser gets.

```
index.html    the entire site (~68 KB, ~26 KB over the wire)
assets/       the resume PDF
tools/        authoring scripts, the headshot they read, and the verifier
              (tools/out/ is generated and gitignored)
README.md     this file
CLAUDE.md     notes for working in the repo
```

## Running it

Open `index.html`. It works from `file://` as well as over HTTP:

```sh
python3 -m http.server
```

## Checking a change

```sh
node tools/verify.mjs          # all checks; exits non-zero on failure
node tools/verify.mjs --list   # what it checks
node tools/verify.mjs grid     # just one
```

It needs Node 18+ and `google-chrome` on PATH, and nothing else — it starts its
own static server and headless browser and writes no files. Every check in it
corresponds to a bug this page has actually had. It is a regression harness, not
a proof of correctness; still look at the page.

## Deploying

GitHub Pages, no workflow needed: **Settings → Pages → Deploy from a branch →
`main` / `/ (root)`**.

## Editing

`index.html` is the source of truth — edit it directly. Two blobs inside it are
generated, and both have a script that reproduces them:

```sh
python3 -m venv tools/.venv && tools/.venv/bin/pip install fonttools brotli pillow

tools/make-font-subset.sh                  # -> tools/out/glyphs.woff2.b64
tools/.venv/bin/python tools/make-portrait.py   # -> tools/out/portrait.txt
```

Paste those into the `@font-face` `src` and the `.art--port` `<pre>`. The script
defaults are the values the committed art was rendered at, so running them bare
reproduces what is already there.

The name art is `toilet` with the `mono12` figlet font — a **system** package,
not part of the venv above. Three steps sit between the command and the `<pre>`,
and the trim is not optional: `toilet` indents every line by one space, so
skipping it leaves 70-column art against a divisor sized for 69.

```sh
toilet -f mono12 JASON   >  tools/out/name.txt   # stack the two words into ONE
toilet -f mono12 GRILLER >> tools/out/name.txt   # block, JASON above GRILLER

grep '[^ ]' tools/out/name.txt | cut -c2- | sed 's/ *$//'
#    ^ drop the pad lines       ^ trim the  ^ and the ragged trailing space.
#      (they are spaces, not      leading     `grep .` does NOT work: those
#      empty, so test for a       column      lines are full of spaces
#      non-space)
```

That pipeline reproduces the committed art byte for byte.

## Runtime dependencies

There is no build step and no framework, but the page is not self-contained.
JetBrains Mono is fetched from Google Fonts by a render-blocking stylesheet, and
it is the first family in `--font`. Offline, body text falls back to a system
mono whose advance is not 0.6em (Consolas is 0.5498em), and the `1ch = 9px`
assumption the horizontal grid rests on quietly stops holding. The art is
immune — see below.

## Why a font is embedded

JetBrains Mono contains **no braille** (U+2800–28FF) and **no block elements**
(U+2580–259F) — not in any build, including the Nerd Font patched ones
([JetBrainsMono#630](https://github.com/JetBrains/JetBrainsMono/issues/630)) —
and Google Fonts serves neither. The spinners, the portrait, the ASCII name, the
corner ornaments, the block cursor and every log marker are made of glyphs it
does not have.

Without the subset the browser picks a per-glyph fallback at a different advance
width — DejaVu Sans is +22%, Noto Sans Mono CJK is +100% — which shears the
ASCII art apart and sizes the spinner grid differently on every OS.

So `index.html` embeds a [Adwaita Mono](https://gitlab.gnome.org/GNOME/adwaita-fonts)
subset (SIL OFL 1.1) — 2.9 KB of WOFF2, 3.8 KB once base64'd — covering exactly:

```
U+0020        space, because the name art is spaces + block glyphs and a space
              resolving from a different family would shear it
U+2192        → log prefix
U+2500-259F   box drawing + block elements: rules, name art, block cursor
U+25B2        ▲ warn prefix (Adwaita has no U+26A0)
U+2713        ✓ log prefix
U+2800-28FF   braille: spinners, portrait, corner ornaments
```

Its advance is 600/1000em, identical to JetBrains Mono, so no `size-adjust` is
required. It is declared under its own family name (`Terminal Glyphs`) rather
than as JetBrains Mono, so the OFL Reserved Font Name clause is not engaged.

There are two font stacks, and the difference is deliberate: `--font` starts with
JetBrains Mono, `--font-art` **does not name it at all**, so art always resolves
from the subset first. A new art block that reaches for `--font` will shear.

`node tools/verify.mjs font` measures this in a real browser: every glyph in the
subset must come out the same width as the body font's.

## The layout system

A terminal has exactly two units: **one column and one row**. The reference this
is modelled on puts every line on a 28px pitch and makes every gap an integer
number of those rows — nothing is `1.65 ×` anything. This page keeps the system
and picks its own pitch, 24px:

- **`line-height` is a length, not a ratio.** `line-height: var(--row)` on `body`
  inherits as a computed 24px, so a heading, a bullet and a wrapped paragraph all
  occupy exactly one row. This one declaration is the whole vertical rhythm.
- **There is one text size.** `--fs` is the only font-size any text uses, which
  makes `1ch` the same 9px page-wide, so the 2ch log indent, the 6ch spinner box,
  the 2ch card padding and the 22ch nav column all land on one character grid.
  The other `font-size` declarations in the file are on the two art `<pre>`
  blocks, where size is a function of container width rather than of hierarchy.
- **Hierarchy is weight and brightness, not size** — which is ANSI's own system.
- **One rail.** Every block uses `.wrap` and nothing else, so there is exactly one
  left edge. If you add a section, give it `.wrap`.
- **The shell and the reading measure are separate knobs.** `--page` (68rem =
  1088px) sizes the rail; `--measure` (80ch = 720px) caps every run of text, and
  each text block applies it *itself*. That is what lets the shell widen without
  the prose following — 80 characters is the terminal convention and also the
  upper bound of the readable range, so it must not grow. A new text block that
  forgets `max-width: var(--measure)` is invisible until you meet a 110-character
  line; `node tools/verify.mjs measure` is the guard.

## The two display modes

Motion is deliberately spread rather than pooled: one 1-character spinner per
section heading (the command is still running), one in the mode bar, and the 15
named spinners in the skills grid. Before that split, 21 of the 23 moving elements
sat in a single band three screens down and `tui` had nothing moving above the
fold at all.

One DOM, two presentations. **read** (the default) is terminal output, top to
bottom. **browse** keeps the same font, palette and grid but turns things into
*controls* — the difference between piping a command and running `lazygit` — and
leads with a neofetch-style summary card: the braille portrait on the left, a
key/value résumé table on the right.

**The labels on the toggle are plain English on purpose.** `stdout` and `tui` are
both jargon, and browse mode exists *for* the people who don't know the jargon —
naming it after the thing they don't know defeats the point. The internal names
did not change: `data-mode`, `?mode=tui` and the `localStorage` key all still say
`stdout` / `tui`, so every link already shared keeps working. Only the two button
labels and the two announcement strings are user-facing.

The mode is a class on `<html>`, and `?mode=tui` is a shareable link.

- **The mode class is set in `<head>`, on `<html>`.** It has to be. `<body>`
  doesn't exist yet at that point, and a class applied after first paint means a
  `?mode=tui` visitor watches stdout render and then snap. Moving this to the
  end-of-body script reintroduces that flash.
- **Resolution order is: URL parameter, then `localStorage`, then `stdout`.**
  `?mode=` accepts `tui` and `stdout`, case-insensitively; anything else is
  ignored rather than treated as an error.
- **The mode is persisted on load, not just on click.** So *opening* a shared
  `?mode=tui` link switches that visitor to tui permanently, which is the point —
  without it, someone who follows the link and never touches the toggle is back
  in stdout next visit. It is sticky and user-visible; change it deliberately.
  The URL is not rewritten on load, or every plain visit would grow a
  `?mode=stdout`.
- **Scoping policy.** A new *unscoped* rule is allowed only if every selector
  targets markup that did not exist before the feature. Anything touching
  pre-existing markup must be `.tui`-prefixed. That is what makes "if stdout
  changed, something leaked" a usable review test.
- **Style state off the class, not off `aria-pressed`.** `aria-pressed` is
  hardcoded in markup and only corrected by the end-of-body script, so keying CSS
  off it paints the wrong button as selected until then. JS owns `aria-pressed`
  for assistive tech; CSS keys off `.tui` / `.stdout`.
- **The toggle bar must stay a whole number of rows** (currently 3), or every
  element below it lands off the 24px grid.
- **browse mode re-places the portrait; it never copies it.** `.tui .art--port`
  is `order:-1` on the existing element, which is also the one carrying `role="img"`
  and its `aria-label`. A second copy would be inert — the spinner engine scans
  once at load.

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
- **The two hero blocks must share one font-size cap.** Their tracks are 69fr and
  44fr against 69 and 44 columns, so both resolve to the *same* size and the hero
  reads as one terminal grid instead of two images. The moment one caps and the
  other doesn't they diverge — which is exactly what a 13px portrait cap does
  once the rail passes ~997px. Hence 13px stacked (where the portrait is
  full-width and would otherwise reach ~26px) and 20px side by side. The override
  has the same specificity as the rule it beats, so it must come *after* it in
  the file. `node tools/verify.mjs hero` measures that they stay equal.
- **The hero stacks at 49rem**, derived from the portrait track needing ≥264px so
  its dots stay distinct. Not a round number on purpose — redo the arithmetic if
  `--page` or the hero column gap changes.
- **`--fg-faint` may only appear on `aria-hidden` elements.** It is below WCAG AA
  for text and is ornament-only. Greppable invariant.
- **Don't use `ch` on anything in `--font-art`.** `ch` is the advance of `0` in
  the first available font, and that is `Terminal Glyphs`, which has no digits —
  a case the spec resolves as 0.5em. Use `0.6em`, the subset's real advance.
  The one exception is `probeGlyphs()`, which measures `1ch` precisely *because*
  it only runs when the subset failed to load: there, resolving from the next
  family is the whole point, and `0.6em` would assume metrics that by definition
  are not there.
- **An instance's start-frame offset must be coprime with the frame count.** The
  engine offsets instance *n* by `n*(f-1) mod f`, and `f-1` is coprime with `f`
  for every `f`. A multiplier that shares a factor collapses instances into
  groups — the `n*5` this used to be gave every 10-frame spinner either frame 0
  or frame 5, so six section headings ran as two visibly synchronised sets.
- **Spinner frames must close.** Frames are precomputed and indexed `% f`, so a
  predicate whose natural period isn't exactly `f` visibly jumps at the wrap.
  Sinusoidal ones advance phase by exactly `2π/f`. A frame must also never be
  all-blank, and no two consecutive frames may be identical, or the spinner
  visibly blinks out or stalls.
- **Nothing may start at `opacity: 0` except the boot log.** Anything hidden until
  an `animation-delay` elapses is blank to an immediate capture — Firefox's
  screenshot, a preview crawler, a slow first frame.
- **Never put `:has()` in a comma list with a selector that must survive without
  it.** A selector list is not forgiving: one unparseable compound invalidates the
  whole rule. Combining `:hover, :has(:focus-visible)` cost the *hover* state in
  every browser without `:has()`.
- **A focus ring needs contrast against whatever is behind it, not just a box to
  paint in.** The default ring is `--accent`; inside an element whose background
  has flipped to `--accent` it is 1.00:1 and invisible. Checking that the element
  has a non-zero box is not the same check.
- **The portrait's font-size must be a multiple of 0.8px.** It is 25 cells tall at
  `line-height: 1.2`, so `25 × 1.2 × size` is a whole number of 24px rows only when
  `size` is a multiple of 0.8 — 16px gives exactly 480px, 12.8px gives 384px. That
  is what lets the summary card sit on the same baselines as the portrait beside
  it. Rows align this way; **columns do not** — the portrait's cell is 12px wide
  and `1ch` is 9px — so its grid track is sized in px, never `ch`.
- **A rule under a heading must be `box-shadow`, not `border-bottom`.** A border
  adds 1px of layout and drifts everything below it off the grid; a shadow paints
  for free. `verify.mjs grid` measures each heading's footprint including its
  margin, so swapping one for the other fails.
- **The one frame on the page is a pseudo-element, not a border.** The hero is a
  `.wrap`, so a real border draws at the wrap's outer edge — 40px left of the rail
  every other block starts on. `::before` with `inset: 0 var(--gutter)` puts it on
  the rail and costs no layout.
- **`gap: 1ch` also sets a 9px *row* gap.** On anything that wraps, that puts
  everything below it off the 24px grid. Use `gap: var(--row) 1ch`.

## Known unfinished

The six project links are placeholders pointing at the GitHub profile rather than
at each repo. In `tui` they are full-width targets, so they are the most clickable
thing on the page. They are marked `TODO` in `index.html`.

## Licence

Site content © Jason Griller. Embedded font subset: Adwaita Mono, SIL OFL 1.1.
