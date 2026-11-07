"""Rooks Browser's terminal output follows the app's three themes (light, dark, high contrast) or auto, keeps one amber
accent on neutral text, and stays plain for NO_COLOR or pipes. The same palettes as the rooks terminal."""

import io
import json
import sys
from pathlib import Path

import pytest

from rooks_browser import cli, theme


def _lum(h):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (int(h.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def _ratio(a, b):
    x, y = sorted((_lum(a), _lum(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def _rgb(h):
    return tuple(int(h.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))


def test_the_three_app_themes_and_auto():
    assert theme.THEMES == ("light", "dark", "contrast")
    assert theme.CHOICES == ("auto", "light", "dark", "contrast")
    assert set(theme.PALETTES) == set(theme.THEMES)
    for name in theme.THEMES:
        assert set(theme.PALETTES[name]) == {"dark", "light"}


def test_same_palettes_as_the_rooks_terminal():
    code = Path(__file__).resolve().parents[2] / "rooks-code"
    if not (code / "rooks_code" / "theme.py").is_file():
        pytest.skip("rooks-code is not next to rooks-browser")
    sys.path.insert(0, str(code))
    try:
        from rooks_code import theme as code_theme
    finally:
        sys.path.remove(str(code))
    assert theme.PALETTES == code_theme.PALETTES and theme.ALIASES == code_theme.ALIASES
    assert theme.KNOWN_LIGHT == code_theme.KNOWN_LIGHT and theme.LEGACY_CODES == code_theme.LEGACY_CODES


def test_every_colour_meets_aa_on_black_and_white():
    for name, variants in theme.PALETTES.items():
        for bg, against in (("dark", "#000000"), ("light", "#ffffff")):
            for role in theme.ROLES:
                assert _ratio(variants[bg][role], against) >= 4.5, (name, bg, role)


def test_restraint_neutral_text_and_one_amber_accent():
    for name, variants in theme.PALETTES.items():
        for bg, roles in variants.items():
            for role in ("prompt", "dim"):
                r, g, b = _rgb(roles[role])
                assert max(r, g, b) - min(r, g, b) <= 12, (name, bg, role, "neutral ink, not a colour")
            r, g, b = _rgb(roles["accent"])
            assert r > g > b, (name, bg, "the one accent is amber")


@pytest.mark.parametrize("saved,expected", [
    ("night", "dark"), ("lamp", "dark"), ("neon", "dark"), ("cherry", "dark"), ("dark", "dark"),
    ("contrast", "contrast"), ("high-contrast", "contrast"), ("auto", "auto"),
    ("sunshine", "light"), ("paper", "light"), ("linen", "light"), ("gallery", "light"), ("studio", "light"), ("light", "light"),
])
def test_an_old_saved_theme_maps_like_the_app(saved, expected):
    assert theme.normalise(saved) == expected


def test_auto_follows_the_terminal_and_a_choice_hints_it(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_WORKSPACE_APPEARANCE_FILE", str(tmp_path / "none.json"))
    assert theme.load(env={}).name == "dark"
    assert theme.load(env={"COLORFGBG": "0;15"}).name == "light"
    assert theme.load("light", env={}).background == "light"
    assert theme.load("light", env={"COLORFGBG": "15;0"}).background == "dark"  # the terminal knows best
    assert theme.TerminalTheme("contrast", "light", True).sgr("error").startswith("1;"), "high contrast is bold"


def test_painter_uses_the_app_theme(tmp_path, monkeypatch):
    f = tmp_path / "appearance.json"
    f.write_text(json.dumps({"theme": "cherry"}))  # an old dark theme: Dark now
    monkeypatch.setenv("AI_WORKSPACE_APPEARANCE_FILE", str(f))
    monkeypatch.delenv("ROOKS_THEME", raising=False)
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.setenv("ROOKS_TERMINAL", "light")
    paint = cli.painter(io.StringIO(), enabled=True)
    r, g, b = _rgb(theme.PALETTES["dark"]["light"]["accent"])
    assert paint("accent", "x") == f"\033[38;2;{r};{g};{b}mx\033[0m"
    assert cli.painter(io.StringIO(), enabled=True, theme="neon")("ok", "x").startswith("\033[38;2;")
    r, g, b = _rgb(theme.PALETTES["contrast"]["light"]["accent"])
    assert cli.painter(io.StringIO(), enabled=True, theme="contrast")("accent", "x") == f"\033[1;38;2;{r};{g};{b}mx\033[0m"


def test_plain_when_not_a_terminal_or_no_color(monkeypatch):
    assert cli.painter(io.StringIO())("accent", "x") == "x"
    tty = io.StringIO()
    tty.isatty = lambda: True
    monkeypatch.setenv("NO_COLOR", "1")
    assert cli.painter(tty)("accent", "x") == "x"
