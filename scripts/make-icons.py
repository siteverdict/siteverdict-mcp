"""Renders the PLACEHOLDER icon (same design as marketplace/assets/icon.svg) to PNG sizes
needed by marketplaces: 512 (registry/Docker/Glama/MCPB), 400 (Cline). Requires Pillow.
Usage: python3 scripts/make-icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "marketplace" / "assets"
NAVY, WHITE, GREEN = (15, 42, 74, 255), (255, 255, 255, 255), (61, 220, 151, 255)


def render(size: int) -> Image.Image:
    s = 4  # supersample for smooth edges
    big = 512 * s
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = lambda v: int(v * s)  # noqa: E731
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=k(112), fill=NAVY)
    d.rounded_rectangle([k(96), k(120), k(416), k(356)], radius=k(28), outline=WHITE, width=k(28))
    d.line([k(96), k(178), k(416), k(178)], fill=WHITE, width=k(20))
    d.line([k(186), k(268), k(236), k(318), k(330), k(222)], fill=GREEN, width=k(36), joint="curve")
    for x, y in [(186, 268), (330, 222)]:
        r = k(18)
        d.ellipse([k(x) - r, k(y) - r, k(x) + r, k(y) + r], fill=GREEN)
    d.rounded_rectangle([k(176), k(384), k(336), k(412)], radius=k(14), fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (512, 400, 128):
        render(size).save(OUT / f"icon-{size}.png")
        print(f"wrote {OUT / f'icon-{size}.png'}")
