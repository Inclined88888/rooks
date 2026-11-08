"""Every icon file exists at its declared size and shows the Rooks mark (docs/design/0007, the mark).

The mark is the chess rook as a plain tower: an ink tile, a paper tower with three merlons, and an arched doorway
lit in gold (desktop/app-icon.svg is the source). Each raster is opened, its size checked against what declares it
(tauri.conf.json and the file names Tauri uses, mobile/app.json, the native palette's pack files), and a few points
are read back: ink above the tower, paper in the tower's wall, gold in the doorway. At 16 px it is still a tower
with a gold door. desktop/scripts/make_icons.py makes the files that `npx tauri icon` does not.
"""

import json
import re
from pathlib import Path

import pytest
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
TAURI = REPO / "desktop" / "src-tauri"
ICONS = TAURI / "icons"
NATIVE = REPO / "desktop" / "rooks-native" / "assets"
MOBILE = REPO / "mobile" / "assets"

INK, PAPER, GOLD = (0x16, 0x16, 0x15), (0xFA, 0xFA, 0xF9), (0xE3, 0xA8, 0x2B)

# Where to look, as fractions of the 1024 design (desktop/app-icon.svg): the tile above the tower, the wall left of
# the door, the doorway, and the gap between the first two merlons.
TILE_POINTS = {"ink": [(0.50, 0.15), (0.41, 0.26)], "paper": [(0.36, 0.55), (0.64, 0.40)], "gold": [(0.50, 0.70)]}


def _near(rgb, want, tol):
    return all(abs(a - b) <= tol for a, b in zip(rgb, want))


def _is_ink(rgba):
    r, g, b, a = rgba
    return a > 200 and max(r, g, b) < 0x40


def _is_paper(rgba):
    return rgba[3] > 200 and _near(rgba[:3], PAPER, 24)


def _is_gold(rgba):
    r, g, b, a = rgba
    return a > 200 and r > 0xB8 and 0x80 < g < 0xC8 and b < 0x70 and r - b > 0x80


CHECK = {"ink": _is_ink, "paper": _is_paper, "gold": _is_gold}


def _shows_the_tower(im, points=TILE_POINTS, box=(0.0, 0.0, 1.0, 1.0)):
    """Read the points back; box is where the 1024 design sits in this image (x0, y0, x1, y1 as fractions)."""
    im = im.convert("RGBA")
    w, h = im.size
    x0, y0, x1, y1 = box
    bad = []
    for kind, pts in points.items():
        for fx, fy in pts:
            px = min(w - 1, int((x0 + fx * (x1 - x0)) * w))
            py = min(h - 1, int((y0 + fy * (y1 - y0)) * h))
            got = im.getpixel((px, py))
            if not CHECK[kind](got):
                bad.append(f"{kind} at {fx},{fy} is {got}")
    return bad


# The desktop app (Tauri): the bundle list in tauri.conf.json, plus every PNG Tauri's icon command writes. A name
# says its size: 32x32, 128x128@2x (256), Square150x150Logo; the two that do not are icon.png (512) and StoreLogo (50).
CONF = json.loads((TAURI / "tauri.conf.json").read_text())
TAURI_PNG = {
    "32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512, "StoreLogo.png": 50,
    **{f"Square{n}x{n}Logo.png": n for n in (30, 44, 71, 89, 107, 142, 150, 284, 310)},
}


def _declared(name):
    m = re.fullmatch(r"(?:Square)?(\d+)x\1(@2x)?(?:Logo)?\.png", name)
    return int(m.group(1)) * (2 if m.group(2) else 1) if m else TAURI_PNG[name]


def test_the_bundle_list_names_files_that_exist():
    for rel in CONF["bundle"]["icon"]:
        assert (TAURI / rel).is_file(), rel
    names = {Path(p).name for p in CONF["bundle"]["icon"]}
    assert {"icon.icns", "icon.ico"} <= names


@pytest.mark.parametrize("name", sorted(TAURI_PNG))
def test_each_desktop_png_is_its_declared_size_and_shows_the_tower(name):
    path = ICONS / name
    assert path.is_file(), name
    with Image.open(path) as im:
        assert im.format == "PNG"
        assert im.size == (_declared(name), _declared(name)) == (TAURI_PNG[name],) * 2
        assert not _shows_the_tower(im), (name, _shows_the_tower(im))


def test_no_stray_icon_files_without_a_declared_size():
    for p in ICONS.iterdir():
        assert p.name in TAURI_PNG or p.name in {"icon.icns", "icon.ico"}, f"{p.name} has no declared size"


def _ico_frames(path):
    with Image.open(path) as ico:
        sizes = sorted(ico.info["sizes"])
        frames = {}
        for s in sizes:
            ico.size = s
            frames[s] = ico.copy()
        return sizes, frames


def test_windows_icon_has_every_size_from_16_to_256_and_each_shows_the_tower():
    sizes, frames = _ico_frames(ICONS / "icon.ico")
    assert {(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)} <= set(sizes), sizes
    for s, im in frames.items():
        assert im.size == s
        assert not _shows_the_tower(im), (s, _shows_the_tower(im))


def test_mac_icon_opens_and_shows_the_tower_at_every_size():
    with Image.open(ICONS / "icon.icns") as icns:
        sizes = icns.info["sizes"]
        assert {(16, 16, 1), (32, 32, 1), (128, 128, 1), (256, 256, 1), (512, 512, 1)} <= set(sizes) or (
            {(16, 16, 2), (128, 128, 2), (512, 512, 1)} <= set(sizes)), sizes
        for s in sizes:
            frame = icns.icns.getimage(s)  # one entry: (16, 16, 2) is the 32 px picture for a 16 point icon
            assert frame.size == (s[0] * s[2], s[1] * s[2]), s
            assert not _shows_the_tower(frame), (s, _shows_the_tower(frame))


# The floating Ask palette (desktop/rooks-native): main.rs embeds app-icon.png, the pack scripts read it and the
# 256 one, and Rooks.wxs ships app-icon.ico.
def test_the_native_palette_icons():
    for name, size in (("app-icon.png", 1024), ("app-icon-256.png", 256)):
        with Image.open(NATIVE / name) as im:
            assert im.size == (size, size), name
            assert not _shows_the_tower(im), (name, _shows_the_tower(im))
    sizes, frames = _ico_frames(NATIVE / "app-icon.ico")
    assert {(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)} <= set(sizes), sizes
    for s, im in frames.items():
        assert not _shows_the_tower(im), (s, _shows_the_tower(im))
    main = (REPO / "desktop" / "rooks-native" / "src" / "main.rs").read_text()
    assert 'include_bytes!("../assets/app-icon.png")' in main


def test_the_svg_sources_are_the_tower():
    for svg in (REPO / "desktop" / "app-icon.svg", REPO / "workbench" / "frontend" / "public" / "favicon.svg"):
        text = svg.read_text()
        assert "#E3A82B" in text.upper(), f"{svg.name}: the gold door"
        assert "H379V336H467V224H557V336H645V224" in text.replace(" ", ""), f"{svg.name}: the three merlons"


# The phone app (mobile/app.json). Expo asks for a 1024 square app icon with no transparency, Android's adaptive
# icon in layers (the template's sizes: 512 foreground and background, 432 monochrome), a 48 web favicon and a
# splash image shown 160 wide on paper or, in dark mode, on near black.
APP = json.loads((REPO / "mobile" / "app.json").read_text())["expo"]
ADAPTIVE = APP["android"]["adaptiveIcon"]
SPLASH = next(p[1] for p in APP["plugins"] if isinstance(p, list) and p[0] == "expo-splash-screen")
MOBILE_SIZES = {
    APP["icon"]: 1024, ADAPTIVE["foregroundImage"]: 512, ADAPTIVE["backgroundImage"]: 512,
    ADAPTIVE["monochromeImage"]: 432, APP["web"]["favicon"]: 48, SPLASH["image"]: 1024,
}


@pytest.mark.parametrize("rel", sorted(MOBILE_SIZES))
def test_each_phone_icon_is_its_declared_size(rel):
    path = REPO / "mobile" / rel
    assert path.is_file(), rel
    with Image.open(path) as im:
        assert im.size == (MOBILE_SIZES[rel],) * 2, rel


def test_the_phone_icons_show_the_tower():
    def img(rel):
        return Image.open(REPO / "mobile" / rel).convert("RGBA")

    # the app icon is full bleed (the phone rounds it) and opaque: iOS refuses one with an alpha channel
    with Image.open(REPO / "mobile" / APP["icon"]) as icon:
        assert icon.mode == "RGB", "the app icon has no transparency"
    full = (0.5 - 0.5 * 1024 / 896, 0.5 - 0.5 * 1024 / 896, 0.5 + 0.5 * 1024 / 896, 0.5 + 0.5 * 1024 / 896)
    assert not _shows_the_tower(img(APP["icon"]), box=full)
    # the splash is the tile with its margin; the 48 px favicon is cropped to the tile so the tower is as big as it can be
    assert not _shows_the_tower(img(SPLASH["image"])), _shows_the_tower(img(SPLASH["image"]))
    assert not _shows_the_tower(img(APP["web"]["favicon"]), box=full), _shows_the_tower(img(APP["web"]["favicon"]), box=full)
    # Android's layers: an ink background, the tower alone on clear glass inside the safe circle, and a one colour
    # silhouette with the doorway cut out so it still reads as a door when the phone tints it
    bg = img(ADAPTIVE["backgroundImage"])
    assert all(_is_ink(bg.getpixel((x, y))) for x in (0, 255, 511) for y in (0, 255, 511))
    fg = img(ADAPTIVE["foregroundImage"])
    assert fg.getpixel((0, 0))[3] == 0 and fg.getpixel((511, 511))[3] == 0, "the foreground is clear around the tower"
    assert _is_gold(fg.getpixel((256, 300))) and _is_paper(fg.getpixel((200, 256)))
    bbox = fg.getbbox()
    # Android crops the layer to a circle 66 of its 108 units across: every corner of the tower stays inside it
    assert bbox and all(((x - 256) ** 2 + (y - 256) ** 2) ** 0.5 <= 512 * 33 / 108 for x, y in _corners(bbox)), bbox
    mono = img(ADAPTIVE["monochromeImage"])
    w = mono.size[0]
    assert mono.getpixel((int(w * 0.39), int(w * 0.5)))[3] > 200, "the wall is solid"
    assert mono.getpixel((w // 2, int(w * 0.6)))[3] == 0, "the doorway is cut out"
    assert mono.getpixel((0, 0))[3] == 0


def _corners(bbox):
    x0, y0, x1, y1 = bbox
    return [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
