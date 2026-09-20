#!/usr/bin/env python3
"""Rebuild reels/src/catalog.json from the logo files in the repository root.

For every logo it records:
  * the file name (used as a relative URL by the reel stage);
  * the alpha bounding box, so the stage can crop away transparent padding and
    give every logo the same optical size;
  * the mean luminance of the artwork, which decides light or dark tile;
  * a brand colour picked from the most saturated pixels, used for glows.

Usage:  python3 reels/tools/build_catalog.py        (needs Pillow)
"""

import colorsys
import json
import os
import unicodedata
from collections import Counter

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "reels", "src", "catalog.json")
EXTS = (".png", ".webp", ".jpg", ".jpeg")
SKIP = {"claude дизайн.png"}  # duplicate of Claude.PNG, kept out of the catalogue


def brand_color(im):
    """Most representative saturated colour of the artwork."""
    small = im.convert("RGBA").resize((72, 72), Image.LANCZOS)
    px = small.load()
    buckets = Counter()
    for y in range(small.height):
        for x in range(small.width):
            r, g, b, a = px[x, y]
            if a < 140:
                continue
            h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if s < 0.18 or l < 0.12 or l > 0.94:
                continue  # ignore greys, near-black and near-white
            buckets[(round(h * 24), round(s * 4), round(l * 4))] += 1
    if not buckets:
        return "#8A93A6"
    (hb, sb, lb), _ = buckets.most_common(1)[0]
    h, s, l = hb / 24, min(sb / 4, 0.95), min(max(lb / 4, 0.42), 0.68)
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return "#%02X%02X%02X" % (int(r * 255), int(g * 255), int(b * 255))


def mean_luminance(im):
    """Average luminance of the opaque pixels, 0 (black mark) .. 1 (white mark).

    The stage uses it to decide whether a logo needs a light or a dark tile:
    half of these marks are pure black and would disappear on a dark card.
    """
    small = im.convert("RGBA").resize((64, 64), Image.LANCZOS)
    px = small.load()
    total = 0.0
    seen = 0
    for y in range(small.height):
        for x in range(small.width):
            r, g, b, a = px[x, y]
            if a < 140:
                continue
            total += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
            seen += 1
    return round(total / seen, 3) if seen else 0.5


def trim_box(im):
    """Alpha bounding box as fractions of the image, plus its aspect ratio."""
    w, h = im.size
    alpha = im.convert("RGBA").getchannel("A")
    box = alpha.point(lambda v: 255 if v > 12 else 0).getbbox()
    if not box:
        box = (0, 0, w, h)
    x0, y0, x1, y1 = box
    return {
        "x": round(x0 / w, 4),
        "y": round(y0 / h, 4),
        "w": round((x1 - x0) / w, 4),
        "h": round((y1 - y0) / h, 4),
        "ratio": round((x1 - x0) / max(y1 - y0, 1), 4),
    }


def main():
    entries = []
    for name in sorted(os.listdir(ROOT)):
        norm = unicodedata.normalize("NFC", name).lower()
        if not norm.endswith(EXTS) or norm in SKIP:
            continue
        path = os.path.join(ROOT, name)
        with Image.open(path) as im:
            im.load()
            entries.append(
                {
                    "id": os.path.splitext(name)[0].strip(),
                    "file": name,
                    "color": brand_color(im),
                    "lum": mean_luminance(im),
                    "trim": trim_box(im),
                }
            )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(entries, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"{len(entries)} logos -> {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
