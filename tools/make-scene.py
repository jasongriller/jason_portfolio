#!/usr/bin/env python3
"""Draw the browse-mode workspace scene as braille art.

This is ORIGINAL artwork drawn with primitives, not a traced or dithered
photograph -- there is no source image and so no licence question.

Two things differ from tools/make-portrait.py, and both matter:

1. THRESHOLD, NOT DITHER. make-portrait.py uses convert("1"), which applies
   Floyd-Steinberg. That is right for a photograph and wrong for line art:
   dithering scatters isolated dots along every edge, and at braille
   resolution a 1px-wide scattered edge reads as noise rather than as a line.
   Here the supersampled drawing is downsampled with a box filter and then
   thresholded, so an edge stays an edge.

2. GEOMETRY IS CHOSEN, NOT DERIVED. The portrait's row count falls out of the
   source photo's aspect ratio. This block is 36x15, and both numbers were
   picked against how the page actually renders rather than on paper:

   - 15 rows because height is rows * 1.2 * font-size, so 18 * size must be a
     multiple of the 24px row -- the size ladder has to be multiples of 4/3.
   - 36 columns, not the portrait's 44, because a font renders braille dots
     small relative to their spacing. Drawn at 44 columns the art was correct
     and still read as a faint dotted ghost in the page. Fewer, larger dots beat
     more, smaller ones: 36 columns at 20px is the same physical width as 44 at
     16px, with each dot 25% bigger.

A braille dot is square only at line-height 1.2 (cell 0.6em wide, 1.2em tall,
2x4 dots), so the dot canvas is plain square pixels: 88 x 60.

Usage:  tools/make-scene.py [--cols 36] [--rows 15]
        writes tools/out/scene.txt and tools/out/scene.png (a preview)
"""
import argparse
import math
import pathlib

from PIL import Image, ImageDraw

BITS = {(0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (0, 3): 0x40,
        (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (1, 3): 0x80}

SS = 8          # supersample factor
THRESH = 78     # 0-255; a downsampled pixel this bright or brighter lights a dot


class Iso:
    """Isometric projection. x runs right-and-down, y left-and-down, z up.

    Built in two passes: every primitive is recorded in model coordinates, the
    bounding box of the projected result is measured, and only then are scale
    and offset chosen to fit the canvas. Guessing a scale by hand puts the
    drawing in a corner at the wrong size, which is exactly what happened.
    """

    def __init__(self):
        self.s, self.ox, self.oy = 1.0, 0.0, 0.0

    def raw(self, x, y, z=0.0):
        return ((x - y) * 0.866, (x + y) * 0.5 - z)

    def __call__(self, x, y, z=0.0):
        u, v = self.raw(x, y, z)
        return (self.ox + u * self.s, self.oy + v * self.s)

    def fit(self, pts, w, h, margin):
        proj = [self.raw(*p) for p in pts]
        xs = [u for u, _ in proj]; ys = [v for _, v in proj]
        bw, bh = max(xs) - min(xs), max(ys) - min(ys)
        self.s = min((w - 2 * margin) / bw, (h - 2 * margin) / bh)
        self.ox = (w - bw * self.s) / 2 - min(xs) * self.s
        self.oy = (h - bh * self.s) / 2 - min(ys) * self.s


def model():
    """Every primitive as (kind, points, shade). Model units, no pixels."""
    ops = []
    BW, BD, BH = 3.4, 2.4, 0.22

    # laptop base: top face and the two visible sides
    ops += [("poly", [(0, 0, BH), (BW, 0, BH), (BW, BD, BH), (0, BD, BH)], "fg"),
            ("poly", [(0, BD, 0), (BW, BD, 0), (BW, BD, BH), (0, BD, BH)], "fg"),
            ("poly", [(BW, 0, 0), (BW, BD, 0), (BW, BD, BH), (BW, 0, BH)], "fg")]

    # trackpad, then key rows
    ops.append(("poly", [(1.05, 1.5, BH), (2.35, 1.5, BH),
                         (2.35, 2.1, BH), (1.05, 2.1, BH)], "dim"))
    for i in range(4):
        y = 0.5 + i * 0.21
        ops.append(("line", [(0.3, y, BH), (3.1, y, BH)], "dim"))

    # screen, hinged at the back edge and tilted away
    SB, ST, SZ = 0.05, -1.25, 2.7
    ops.append(("poly", [(0, SB, BH), (BW, SB, BH), (BW, ST, SZ), (0, ST, SZ)], "fg"))
    ib, it, iz = SB - 0.13, ST + 0.15, SZ - 0.22
    ops.append(("poly", [(0.17, ib, BH + 0.17), (BW - 0.17, ib, BH + 0.17),
                         (BW - 0.17, it, iz), (0.17, it, iz)], "dim"))
    for i, (x0, ln) in enumerate([(0.36, 1.15), (0.36, 0.75), (0.62, 1.6),
                                  (0.36, 1.0), (0.62, 1.25)]):
        t = (i + 1) / 6
        yy = ib + (it - ib) * t
        zz = BH + 0.17 + (iz - BH - 0.17) * t
        ops.append(("line", [(x0, yy, zz), (x0 + ln, yy, zz)], "fg"))

    # Coffee cup, as a tapered CYLINDER rather than a box. A box cup was tried
    # first and cannot work here: its lid diamond's two near edges always descend
    # into the cup's mouth and cross the body's near vertical corner, so it reads
    # as an X inside a lantern. A cylinder has no corner edges at all, and the
    # only lines are the two silhouette sides plus the rings.
    ccx, ccy = -1.3, 1.2
    RB, RT, CH = 0.42, 0.58, 1.85
    N = 32

    def ring(r, z):
        return [(ccx + r * math.cos(2 * math.pi * i / N),
                 ccy + r * math.sin(2 * math.pi * i / N), z) for i in range(N)]

    bot, top = ring(RB, 0.0), ring(RT, CH)
    # the silhouette sides are the two points furthest apart in projected x,
    # which for a ring centred on the origin are the ones near theta = +-3pi/4
    iL = min(range(N), key=lambda i: (bot[i][0] - bot[i][1]))
    iR = max(range(N), key=lambda i: (bot[i][0] - bot[i][1]))
    ops.append(("curve", bot + [bot[0]], "fg"))                # base ring
    ops.append(("line", [bot[iL], top[iL]], "fg"))
    ops.append(("line", [bot[iR], top[iR]], "fg"))
    ops.append(("fillring", top, "fg"))                        # lid, opaque
    ops.append(("curve", ring(RT * 1.12, CH + 0.2) + [ring(RT * 1.12, CH + 0.2)[0]], "fg"))

    # Steam at full brightness -- a dim 1px curve downsamples to three unrelated
    # dots at this size.
    for dx, ph, amp, rise in [(-0.16, 0.0, 0.4, 1.0), (0.3, 2.4, 0.3, 0.68)]:
        curl = []
        for j in range(21):
            t = j / 20
            a_ = t * 4.2 + ph
            curl.append((ccx + dx + math.sin(a_) * amp,
                         ccy + math.cos(a_) * amp * 0.55,
                         CH + 0.5 + t * rise))
        ops.append(("curve", curl, "fg"))

    return ops


def draw_scene(w, h):
    img = Image.new("L", (w * SS, h * SS), 0)
    d = ImageDraw.Draw(img)
    ops = model()
    iso = Iso()
    iso.fit([p for _, pts, _ in ops for p in pts], w * SS, h * SS, margin=1.5 * SS)

    # Just over one dot wide. Below a full dot, a diagonal line spreads its
    # coverage across two dots and lights neither reliably, and the art comes out
    # as a dotted ghost of itself.
    LINE = max(1, round(1.25 * SS))
    THIN = max(1, round(0.95 * SS))
    SHADE = {"fg": 255, "dim": 168}
    for kind, pts, shade in ops:
        col = SHADE[shade]
        wid = LINE if shade == "fg" else THIN
        proj = [iso(*p) for p in pts]
        if kind == "poly":
            d.polygon(proj, fill=0, outline=col, width=wid)
        elif kind == "fillring":
            # opaque: painted after the body so it occludes the cup's interior
            d.polygon(proj, fill=0, outline=col, width=wid)
        elif kind == "line":
            d.line(proj, fill=col, width=wid)
        else:
            d.line(proj, fill=col, width=THIN, joint="curve")
    return img


def to_braille(img, cols, rows):
    small = img.resize((cols * 2, rows * 4), Image.BOX)
    px = small.load()
    out = []
    for cy in range(0, rows * 4, 4):
        out.append("".join(
            chr(0x2800 + sum(BITS[(dx, dy)]
                             for dx in range(2) for dy in range(4)
                             if px[cx + dx, cy + dy] >= THRESH))
            for cx in range(0, cols * 2, 2)))
    return out, small


def preview(small, path, dot=7):
    """Draw the dot grid the way a terminal renders braille, so the art can be
    judged before it is pasted into index.html."""
    w, h = small.size
    img = Image.new("RGB", (w * dot, h * dot), (11, 14, 13))
    d = ImageDraw.Draw(img)
    px = small.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] >= THRESH:
                cx, cy = x * dot + dot / 2, y * dot + dot / 2
                r = dot * 0.36
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(184, 196, 191))
    img.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=36)
    ap.add_argument("--rows", type=int, default=15)
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    out = root / "tools" / "out"
    out.mkdir(parents=True, exist_ok=True)

    img = draw_scene(args.cols * 2, args.rows * 4)
    lines, small = to_braille(img, args.cols, args.rows)

    assert " " not in "".join(lines), "ASCII space leaked into the art"
    assert all(len(r) == len(lines[0]) for r in lines), "ragged rows"

    (out / "scene.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    preview(small, out / "scene.png")

    print("\n".join(lines))
    print(f"\n{len(lines[0])} cols x {len(lines)} rows -> tools/out/scene.txt")


if __name__ == "__main__":
    main()
