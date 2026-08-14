#!/usr/bin/env python3
"""Render assets/profile_pic.jpeg as braille art for the hero block.

Two constraints drive the geometry, and both are easy to get wrong:

1. Blank cells MUST be U+2800 BRAILLE PATTERN BLANK, never ASCII space.
   A space would render from JetBrains Mono at 0.6em while the braille
   renders from the embedded subset, and any advance-width difference
   accumulates across the row and shears the image apart. Using U+2800
   keeps every glyph in the block coming from one family.

2. Row count is a function of line-height, not a free choice. A braille
   cell is 2 dots wide by 4 tall inside a monospace cell of 0.6em by
   line-height. So dot width is 0.3em and dot height is line-height/4,
   and for a source of aspect A (height/width):

       rows = A * cols * 0.6 / line-height

   At the line-height of 1.2 that index.html uses for .portrait, dots
   come out square and this reduces to rows = A * cols / 2. Rendering at
   cols/4 -- the intuitive but wrong guess -- squashes the face by half.

Usage:  tools/make-portrait.py [--cols 44] [--contrast 1.7]
        writes tools/out/portrait.txt
"""
import argparse
import pathlib

from PIL import Image, ImageEnhance, ImageOps

# Dot (dx, dy) -> bit in the U+2800 offset. Braille numbers its dots
# 1,2,3,7 down the left column and 4,5,6,8 down the right.
BITS = {(0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (0, 3): 0x40,
        (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (1, 3): 0x80}

LINE_HEIGHT = 1.2  # must match .portrait in index.html


def render(img, cols, contrast, crop=None, cutoff=3):
    if crop:
        img = img.crop(crop)
    aspect = img.height / img.width
    width = cols * 2
    rows = round(aspect * cols * 0.6 / LINE_HEIGHT)
    height = rows * 4

    g = ImageOps.grayscale(img).resize((width, height), Image.LANCZOS)
    g = ImageOps.autocontrast(g, cutoff=cutoff)
    g = ImageEnhance.Contrast(g).enhance(contrast)
    # Invert so bright regions of the photo become lit dots: the page is
    # light-on-dark, so a dot is light and must map to a light pixel.
    g = ImageOps.invert(g)
    px = g.convert("1").load()  # convert("1") applies Floyd-Steinberg dithering

    out = []
    for cy in range(0, height, 4):
        row = "".join(
            chr(0x2800 + sum(BITS[(dx, dy)]
                             for dx in range(2) for dy in range(4)
                             if px[cx + dx, cy + dy] == 0))
            for cx in range(0, width, 2)
        )
        out.append(row)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=44)
    ap.add_argument("--contrast", type=float, default=1.7)
    ap.add_argument("--src", default="assets/profile_pic.jpeg")
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parent.parent
    img = Image.open(root / args.src)
    w, h = img.size
    # Trim the empty margins of the headshot so the face fills the frame.
    crop = (int(w * 0.10), 0, int(w * 0.94), int(h * 0.96))

    rows = render(img, args.cols, args.contrast, crop=crop)

    assert " " not in "".join(rows), "ASCII space leaked into the art"
    assert all(len(r) == len(rows[0]) for r in rows), "ragged rows"

    out = root / "tools" / "out" / "portrait.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(rows) + "\n", encoding="utf-8")

    print("\n".join(rows))
    print(f"\n{len(rows[0])} cols x {len(rows)} rows -> {out.relative_to(root)}")


if __name__ == "__main__":
    main()
