#!/usr/bin/env python3
"""Regenerate the tray icons in desktop/assets/tray/ from the app artwork.

Run by hand after the logo changes; the output is committed, so neither the
build nor the packaged app needs Python. Pillow is used rather than an npm
package because it adds nothing to the distributed product (rule 12).

  python3 desktop/scripts/generate-tray-icons.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'app' / 'public'
OUT = ROOT / 'desktop' / 'assets' / 'tray'

# The meerkat of the wordmark, before the "timon" lettering starts (x >= 210).
MARK_BOX = (0, 0, 196, 197)


def square(img: Image.Image) -> Image.Image:
    side = max(img.size)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon = Image.open(PUBLIC / 'icon-512.png').convert('RGBA')

    # Windows picks the frame matching the DPI scale (100% -> 16, 150% -> 24...).
    icon.save(OUT / 'tray.ico', sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48)])
    # Linux panels (AppIndicator, GNOME, KDE) expect 22-24 px.
    icon.resize((24, 24), Image.LANCZOS).save(OUT / 'tray.png')
    icon.resize((48, 48), Image.LANCZOS).save(OUT / 'tray@2x.png')

    # macOS template: only the alpha channel counts, the system paints it for
    # a light or dark menu bar. The full app icon would be an opaque square.
    mark = Image.open(PUBLIC / 'logo-black.png').convert('RGBA').crop(MARK_BOX)
    alpha = square(mark.crop(mark.getbbox())).getchannel('A')
    for name, size in (('trayTemplate.png', 18), ('trayTemplate@2x.png', 36)):
        # 1 px margin so the silhouette does not touch the menu bar edges.
        a = alpha.resize((size - 2, size - 2), Image.LANCZOS)
        # Downscaling thins the strokes to grey; lift them back towards opaque.
        a = a.point(lambda v: min(255, v * 3 // 2))
        out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        black = Image.new('RGBA', a.size, (0, 0, 0, 255))
        black.putalpha(a)
        out.paste(black, (1, 1))
        out.save(OUT / name)


if __name__ == '__main__':
    main()
