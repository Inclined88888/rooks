"""Terminal colours follow the app's three themes (light, dark, high contrast) or auto, keep one amber accent, pick a
light or dark set for the terminal, and stay off for NO_COLOR."""

import io
import json

import pytest

from rooks_code import theme
from rooks_code.cli import UI, parser


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


def test_every_theme_has_both_variants_and_meets_aa():
    assert set(theme.PALETTES) == set(theme.THEMES)
    for name, variants in theme.PALETTES.items():
        for bg, against in (("dark", "#000000"), ("light", "#ffffff")):
            for role in theme.ROLES:
                c = variants[bg][role]
                assert _ratio(c, against) >= 4.5, (name, bg, role, c)
            # and on the usual off-black / off-white terminal defaults
            for role in theme.ROLES:
                other = "#1e1e1e" if bg == "dark" else "#f5f5f5"
                assert _ratio(variants[bg][role], other) >= 4.5, (name, bg, role, other)


def test_restraint_neutral_text_and_one_amber_accent():
    for name, variants in theme.PALETTES.items():
        for bg, roles in variants.items():
            r, g, b = _rgb(roles["prompt"])
            assert max(r, g, b) - min(r, g, b) <= 12, (name, bg, "the prompt is neutral ink, not a colour")
            r, g, b = _rgb(roles["dim"])
            assert max(r, g, b) - min(r, g, b) <= 12, (name, bg, "secondary text is a neutral grey")
            r, g, b = _rgb(roles["accent"])
            assert r > g > b, (name, bg, "the one accent is amber")


@pytest.mark.parametrize("saved,expected", [
    ("night", "dark"), ("lamp", "dark"), ("neon", "dark"), ("cherry", "dark"), ("dark", "dark"),
    ("contrast", "contrast"), ("high-contrast", "contrast"),
    ("sunshine", "light"), ("paper", "light"), ("linen", "light"), ("gallery", "light"), ("studio", "light"), ("light", "light"),
])
def test_an_old_saved_theme_maps_like_the_app(saved, expected):
    assert theme.normalise(saved) == expected


def test_choice_order_flag_then_env_then_app_file(tmp_path, monkeypatch):
    f = tmp_path / "appearance.json"
    f.write_text(json.dumps({"theme": "auto", "resolved": "night"}))
    monkeypatch.setenv("AI_WORKSPACE_APPEARANCE_FILE", str(f))
    monkeypatch.delenv("ROOKS_THEME", raising=False)
    assert theme.load(env={}).name == "dark"
    assert theme.load(env={"ROOKS_THEME": "neon"}).name == "dark"
    assert theme.load(env={"ROOKS_THEME": "light"}).name == "light"
    assert theme.load("contrast", env={"ROOKS_THEME": "light"}).name == "contrast"
    f.write_text("{broken")
    assert theme.load(env={}).name == "dark"  # auto: follows the terminal (dark when it does not say)
    assert theme.load(env={"COLORFGBG": "0;15"}).name == "light"
    f.write_text(json.dumps({"theme": "purple"}))
    assert theme.load(env={"ROOKS_TERMINAL": "light"}).name == "light"


def test_a_chosen_theme_hints_the_terminal_background_unless_the_terminal_says():
    assert theme.load("light", env={}).background == "light"
    assert theme.load("dark", env={}).background == "dark"
    assert theme.load("light", env={"COLORFGBG": "15;0"}).background == "dark"  # the terminal knows best
    assert theme.load("dark", env={"ROOKS_TERMINAL": "light"}).background == "light"


def test_terminal_background_detection():
    assert theme.terminal_background({}) == "dark"
    assert theme.terminal_background({"COLORFGBG": "0;15"}) == "light"
    assert theme.terminal_background({"COLORFGBG": "15;0"}) == "dark"
    assert theme.terminal_background({"COLORFGBG": "15;default;0"}) == "dark"
    assert theme.terminal_background({"ROOKS_TERMINAL": "light", "COLORFGBG": "15;0"}) == "light"


def test_truecolor_or_256():
    t = theme.TerminalTheme("dark", "dark", True)
    r, g, b = _rgb(theme.PALETTES["dark"]["dark"]["accent"])
    assert t.sgr("accent") == f"38;2;{r};{g};{b}"
    t = theme.TerminalTheme("dark", "dark", False)
    assert t.sgr("accent").startswith("38;5;")
    assert theme.to_256("#000000") in (16, 232)
    assert theme.TerminalTheme("contrast", "light", True).sgr("error").startswith("1;"), "high contrast is bold"
    assert theme.TerminalTheme("light", "dark", True).sgr("bold") == "1"


def test_ui_uses_theme_colours_and_respects_no_color(monkeypatch):
    monkeypatch.setenv("ROOKS_THEME", "dark")
    monkeypatch.setenv("COLORTERM", "truecolor")
    monkeypatch.delenv("ROOKS_TERMINAL", raising=False)
    monkeypatch.delenv("COLORFGBG", raising=False)
    ui = UI(out=io.StringIO(), err=io.StringIO(), color=True)
    r, g, b = _rgb(theme.PALETTES["dark"]["dark"]["prompt"])
    assert ui.c("36", "x") == f"\033[38;2;{r};{g};{b}mx\033[0m"  # the old cyan prompt is now neutral ink
    r, g, b = _rgb(theme.PALETTES["dark"]["dark"]["accent"])
    assert ui.c("accent", "x").startswith(f"\033[38;2;{r};{g};{b}m")
    off = UI(out=io.StringIO(), err=io.StringIO(), color=False)
    assert off.c("accent", "x") == "x"
    monkeypatch.setenv("NO_COLOR", "1")
    tty = io.StringIO()
    tty.isatty = lambda: True
    assert UI(out=tty, err=io.StringIO()).color is False


def test_theme_flag():
    assert parser().parse_args(["--theme", "contrast", "hi"]).theme == "contrast"
    assert parser().parse_args(["--theme", "auto", "hi"]).theme == "auto"
    assert parser().parse_args(["--theme", "neon", "hi"]).theme == "dark"  # an old name still works, mapped like the app
    with pytest.raises(SystemExit):
        parser().parse_args(["--theme", "purple", "hi"])
