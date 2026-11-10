"""Draw the Rooks mark into every icon `npx tauri icon` does not make. Pillow only, no SVG library.

    cd desktop && npx tauri icon app-icon.svg -o src-tauri/icons   # the desktop app (then delete android/ and ios/)
    python desktop/scripts/make_icons.py                            # everything below

desktop/app-icon.svg is the source. This draws the same shapes in the same 1024 units at four times the size and
scales down, so the edges are smooth at 16 px too:

* the tile: 64..960, corner 208, a vertical ink gradient and a faint paper edge
* the tower: 288..736 by 224..808, top corners 24, bottom corners 48, with the gaps between the merlons at
  379..467 and 557..645 down to 336
* the door: 448..576, a half circle on top (centre 512,624, radius 64), down to 808, in gold

Files: desktop/app-icon.png, the palette's assets (desktop/rooks-native/assets), and the phone app's (mobile/assets,
sizes as mobile/app.json and Expo ask). desktop/scripts/test_icons.py checks each one's size and reads the mark back.
"""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

REPO = Path(__file__).resolve().parents[2]
INK_TOP, INK, PAPER, GOLD = (0x2A, 0x2A, 0x28), (0x16, 0x16, 0x15), (0xFA, 0xFA, 0xF9), (0xE3, 0xA8, 0x2B)
SS = 4  # supersampling
D = 1024 * SS


def _s(*v):
    return [round(x * SS) for x in v]


def _ink_gradient(size):
    """The tile's fill: INK_TOP at the top to INK at the bottom, as the SVG's linearGradient."""
    ramp = Image.linear_gradient("L").resize((size, size))
    return Image.composite(Image.new("RGB", (size, size), INK), Image.new("RGB", (size, size), INK_TOP), ramp)


def _tower_masks():
    """(wall, door) as L masks at D x D: the wall has the merlon gaps and the doorway cut out."""
    wall = Image.new("L", (D, D), 0)
    d = ImageDraw.Draw(wall)
    # two rounded slabs: the union has the small corners at the top and the large ones at the bottom
    d.rounded_rectangle(_s(288, 224, 736, 808), radius=48 * SS, fill=255)
    d.rounded_rectangle(_s(288, 224, 736, 700), radius=24 * SS, fill=255)
    for x0, x1 in ((379, 467), (557, 645)):
        d.rectangle(_s(x0, 224, x1, 336), fill=0)
    door = Image.new("L", (D, D), 0)
    dd = ImageDraw.Draw(door)
    dd.ellipse(_s(448, 560, 576, 688), fill=255)
    dd.rectangle(_s(448, 624, 576, 808), fill=255)
    wall = ImageChops.subtract(wall, door)
    return wall, door


def _tile_mask():
    m = Image.new("L", (D, D), 0)
    ImageDraw.Draw(m).rounded_rectangle(_s(64, 64, 960, 960), radius=208 * SS, fill=255)
    return m


def _edge():
    m = Image.new("L", (D, D), 0)
    ImageDraw.Draw(m).rounded_rectangle(_s(68, 68, 956, 956), radius=204 * SS, outline=round(255 * 0.14), width=8 * SS)
    return m


def _layer(colour, mask) -> Image.Image:
    im = Image.new("RGBA", (D, D), colour + (255,))
    im.putalpha(mask)
    return im


def _paint(base: Image.Image, wall, door):
    """Lay the wall and the door over base with straight alpha, so no dark fringe on clear glass."""
    return Image.alpha_composite(Image.alpha_composite(base, _layer(PAPER, wall)), _layer(GOLD, door))


def tile() -> Image.Image:
    """The app icon: the tile on clear glass (desktop/app-icon.svg)."""
    wall, door = _tower_masks()
    im = _ink_gradient(D).convert("RGBA")
    im.putalpha(_tile_mask())
    im = Image.alpha_composite(im, _layer(PAPER, _edge()))
    return _paint(im, wall, door)


def _scaled(layer: Image.Image, scale: float, centre=(512, 512)) -> Image.Image:
    """layer scaled about centre (1024 units) and put back at the middle of a D x D canvas."""
    side = round(D * scale)
    small = layer.resize((side, side), Image.LANCZOS)
    out = Image.new(layer.mode, (D, D), 0 if layer.mode == "L" else (0, 0, 0, 0))
    cx, cy = centre[0] * SS * scale, centre[1] * SS * scale
    out.paste(small, (round(D / 2 - cx), round(D / 2 - cy)))
    return out


def full_bleed() -> Image.Image:
    """The phone's app icon: no corners of its own (the phone rounds it), the tower as large as on the tile."""
    wall, door = _tower_masks()
    k = 1024 / 896
    wall, door = _scaled(wall, k), _scaled(door, k)
    return _paint(_ink_gradient(D).convert("RGBA"), wall, door).convert("RGB")


TOWER_CENTRE = (512, 516)
ADAPTIVE_SCALE = 0.75  # the tower fills about the same share of the visible 72 of 108 units as it does of the tile


def adaptive_foreground() -> Image.Image:
    wall, door = _tower_masks()
    wall, door = _scaled(wall, ADAPTIVE_SCALE, TOWER_CENTRE), _scaled(door, ADAPTIVE_SCALE, TOWER_CENTRE)
    return _paint(Image.new("RGBA", (D, D), (0, 0, 0, 0)), wall, door)


def adaptive_background() -> Image.Image:
    return _ink_gradient(D).convert("RGBA")


def monochrome() -> Image.Image:
    """One colour (the phone tints it): the tower's silhouette with the doorway cut out."""
    wall, _ = _tower_masks()
    wall = _scaled(wall, ADAPTIVE_SCALE, TOWER_CENTRE)
    im = Image.new("RGBA", (D, D), (255, 255, 255, 0))
    im.putalpha(wall)
    return im


def _at(im: Image.Image, size: int) -> Image.Image:
    return im.resize((size, size), Image.LANCZOS)


def _ico(im: Image.Image, sizes) -> bytes:
    buf = io.BytesIO()
    biggest = _at(im, max(sizes))
    biggest.save(buf, format="ICO", sizes=[(s, s) for s in sizes], append_images=[_at(im, s) for s in sizes])
    return buf.getvalue()


def main() -> None:
    t = tile()
    _at(t, 1024).save(REPO / "desktop" / "app-icon.png", optimize=True)
    native = REPO / "desktop" / "rooks-native" / "assets"
    _at(t, 1024).save(native / "app-icon.png", optimize=True)
    _at(t, 256).save(native / "app-icon-256.png", optimize=True)
    (native / "app-icon.ico").write_bytes(_ico(t, (16, 24, 32, 48, 64, 128, 256)))
    mobile = REPO / "mobile" / "assets"
    _at(full_bleed(), 1024).save(mobile / "icon.png", optimize=True)
    _at(adaptive_foreground(), 512).save(mobile / "android-icon-foreground.png", optimize=True)
    _at(adaptive_background(), 512).save(mobile / "android-icon-background.png", optimize=True)
    _at(monochrome(), 432).save(mobile / "android-icon-monochrome.png", optimize=True)
    _at(t.crop(_s(64, 64, 960, 960)), 48).save(mobile / "favicon.png", optimize=True)
    _at(t, 1024).save(mobile / "splash-icon.png", optimize=True)


if __name__ == "__main__":
    main()
