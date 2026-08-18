# Working in this repo

One file, `index.html`, holds the markup, the CSS, the JavaScript and a base64
WOFF2 font subset. There is no build step, no framework, and no package manager —
`git push` and what is in the file is what ships. `tools/` holds authoring
scripts that are run by hand and never at serve time.

`README.md` is not background reading, it is the spec: the layout system, the
reason a font is embedded, how the two display modes resolve, and a list of
non-obvious things that have broken before. Read it before changing layout,
fonts, spinners or mode behaviour. This file covers how to *work* here, and does
not repeat it.

## Verify before you claim

```sh
node tools/verify.mjs            # everything; non-zero exit on failure
node tools/verify.mjs --list     # the checks and what each one catches
node tools/verify.mjs focus grid # a subset while iterating
```

Needs Node 18+ and `google-chrome`. Zero dependencies, no temp files. Every check
in it exists because that exact defect shipped once — including three added when
the rail was widened to 68rem: `measure` (no line of text outruns 80 columns
however wide the shell gets), `hero` (both ASCII blocks resolve to one cell size)
and `stagger` (instances of one spinner do not start on the same frame), plus
`fetch`, which pins the browse-mode summary card to the portrait's baselines.

The two modes are labelled **read** and **browse** in the UI but are `stdout` /
`tui` everywhere in the code — `data-mode`, `?mode=`, the `localStorage` key and
every CSS selector. Don't "fix" that inconsistency; it is what keeps already-shared
`?mode=tui` links working.

It does not cover everything. Two things still have to be done by hand:

- **Did anything move that shouldn't have?** Screenshot before and after and
  compare. This is how a class-name collision (`.tl`) and a `display:contents`
  regression were caught — both invisible to structural assertions. No baseline
  image is committed: it would be a binary blob that goes stale on the first
  intentional visual change.
- **Is the page blank on the very first frame?** Load it in Firefox and take an
  immediate screenshot. Anything gated behind an `animation-delay` or a JS
  callback shows up here and nowhere else.

And a warning that has already cost a debugging session: **do not emulate
`prefers-reduced-motion` to make a headless run deterministic.** The page's
reduced-motion block is the usual reset, `*{transition-duration:.01ms
!important}`, and because `transition-property` stays at its initial `all`, that
does not shorten transitions — it creates one on every property, `outline`
included. Headless produces no frames while idle, so the transition never
advances and `getComputedStyle` returns the *start* value. Every focus ring then
reads as unstyled and you go hunting a bug that is not there.

Verifying that a mechanism is present is not the same as verifying the rendered
result. "The element has a box, so a focus ring can paint" passed; the ring was
`--accent` on an `--accent` background at 1.00:1 and invisible.

## Content provenance

**Every claim on this page traces to `assets/jason_griller_resume_se.pdf` or to
the hand-authored hero blurb.** Never infer a title, a date, a technology or a
metric; never round a number up; never fill a gap with something plausible.

This is the repo's most important rule because of what it replaced. The previous
Hugo site was roughly 70% unmodified theme demo data, and it publicly claimed
roles at Amazon, Apple, Netflix and Google. If a section looks thin, it is thin
because the source is thin. Leave it thin or ask.

The phone number is in the PDF and must **not** appear on the page.

**The rule catches things late if nobody checks.** A GPA on both education entries
and an entire second institution shipped and survived several reviews before an
audit against the PDF found that none of it was in there; all of it is now gone.
When you touch content, diff it against the PDF, not against what the page already
says.

**The PDF is also the source for *structure*, not only for facts.** Its
`TECHNICAL SKILLS` block is four labelled groups — Languages / Tools / Frontend /
Backend — and the skills card reproduces them, in that order, because that grouping
is a claim about what he does. Those labels were once deleted as decoration; they
are not. Same for `EDUCATION`'s `Relevant Coursework` and `Extracurriculars`, which
the page renders as `coursework/` and `activities/`.

## Regenerating the two embedded blobs

Both have a script, both scripts default to exactly what is committed, and both
write to the gitignored `tools/out/`:

```sh
python3 -m venv tools/.venv && tools/.venv/bin/pip install fonttools brotli pillow
tools/make-font-subset.sh
tools/.venv/bin/python tools/make-portrait.py
tools/.venv/bin/python tools/make-scene.py
```

`make-scene.py` draws browse mode's graphic from primitives rather than tracing an
image, and thresholds instead of dithering — dithering is right for a photograph
and turns line art into noise. It writes a `scene.png` preview; use it, because
braille line art cannot be judged from the characters.

The portrait's column count and the CSS `cqi` divisor are one number in two
places: `100cqi / 26.4` is 44 columns × 0.6em. Re-render at a different width and
the divisor moves with it, or the art overflows its container. Same for the name
art and `41.4` / 69 columns. The README documents the full name-art pipeline —
it is not just the `toilet` command.

## Don't

- **Don't add a build step, a dependency, or a framework.** The constraint is the
  point. `tools/verify.mjs` is deliberately zero-dependency for the same reason.
- **Don't duplicate DOM for the second display mode.** One DOM, two
  presentations. The two modes show different art blocks, but they *swap* — one is
  hidden while the other shows — never a clone of one element.
- **Don't state a fact twice in one mode.** The two modes deliberately carry two
  copies of some summaries and hide one per mode — `.meta` and `#about`'s `.now`
  list are hidden in browse because the card restates them; the card is hidden in
  read. `node tools/verify.mjs once` asserts each pair. Before adding a line, grep
  the rendered text: at the last audit, LikeMinds and homelab were each stated four
  times in browse mode, twice inside `#about` alone.
- **Don't restate below-the-fold content in the browse summary card.** It was
  fourteen rows once, and an audit found **zero** of them unique: 79% of its
  characters repeated text further down the page, and one fact appeared three
  times. It is five rows now. Anything added to it should be something a visitor
  cannot read one scroll later. Beyond the maintenance cost, the spinner engine calls
  `querySelectorAll('[data-spinner]')` exactly once at load, so a spinner added
  to a second copy of a section is inert — a bug that looks like a CSS problem.
- **Don't add an unscoped CSS rule that touches pre-existing markup.** New rules
  for tui must be `.tui`-prefixed unless every selector targets markup that did
  not exist before. That is what keeps "if stdout changed, something leaked" a
  usable review test.
- **Don't gate anything visible on a JS callback.** CSS owns the reveal; JS owns
  only the typewriter and the toggle. A failure in the script must never be able
  to leave a blank page.

## Known unfinished

The six project links are `TODO` placeholders pointing at the GitHub profile
instead of at individual repos. That is a decision, not an oversight — but in
`tui` they render as full-width click targets, so they are the most prominent
unfinished thing on the site.
