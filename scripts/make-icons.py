"""Render the app icon to the PNG sizes an installable web app needs.

    python scripts/make-icons.py

static/icon.svg is the source of truth for the DESIGN; this redraws the same
shapes with Pillow because there is no SVG rasteriser here and the artwork is
a handful of rectangles and lines. Keep the two in step by eye - if the icon
ever gets complicated, install cairosvg and rasterise instead.

Why PNG at all, when a manifest can reference an SVG: iOS does not accept one
for apple-touch-icon, and it composites transparency onto black, so the home
screen icon has to be an opaque bitmap.
"""
from PIL import Image, ImageDraw

INK = (34, 34, 34, 255)        # #222, as in the svg
PAPER = (254, 254, 254, 255)   # the page itself
BG = (253, 251, 245, 255)      # --paper in the default theme, opaque for iOS


def draw(size: int, pad: float = 0.06) -> Image.Image:
    """The icon at `size` px. `pad` is the margin as a fraction of the side —
    a maskable icon needs a wide one, because the launcher crops to a circle."""
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)

    box = size * (1 - 2 * pad)
    off = size * pad
    u = box / 32.0                       # one svg unit in px
    def X(v): return off + v * u

    stroke = max(1, round(2 * u))
    d.rounded_rectangle([X(5), X(3), X(27), X(29)], radius=max(1, round(2 * u)),
                        fill=PAPER, outline=INK, width=stroke)

    # Punch tabs down both edges.
    for y in (6, 13, 20):
        d.rectangle([X(3), X(y), X(7), X(y + 3)], fill=INK)
        d.rectangle([X(25), X(y), X(29), X(y + 3)], fill=INK)

    # Lines of script.
    rule = max(1, round(1.5 * u))
    for x1, y, x2 in ((11, 10, 21), (11, 14, 19), (13, 18, 22), (13, 22, 20)):
        d.line([X(x1), X(y), X(x2), X(y)], fill=INK, width=rule)
    return img


OUTPUTS = [
    # (file, size, padding) — maskable needs its content inside the safe circle,
    # which is the central 80%, so it gets a much wider margin.
    ("static/icon-192.png", 192, 0.06),
    ("static/icon-512.png", 512, 0.06),
    ("static/icon-maskable-512.png", 512, 0.18),
    ("static/apple-touch-icon.png", 180, 0.08),
]

for path, size, pad in OUTPUTS:
    im = draw(size, pad)
    if path.endswith("apple-touch-icon.png"):
        im = im.convert("RGB")           # iOS composites alpha onto black
    im.save(path)
    print(f"{path}  {size}x{size}  pad {pad:.0%}")
