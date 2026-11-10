"""Terminal colours that follow the app's three themes: Light, Dark and High contrast, or auto (match the terminal).

Restraint, like the app (design record 0003, section 6): text is neutral, and one amber accent marks only what is live or
needs you. ok and error are calm greens and reds for diffs and results; nothing else is coloured.

Which theme: --theme, then ROOKS_THEME, then the app's choice in ~/.ai-workspace/appearance.json (written by the app;
AI_WORKSPACE_APPEARANCE_FILE overrides the path), then auto. An older saved name is mapped the way the app maps it:
night, lamp, neon, cherry -> dark; contrast -> contrast; everything else -> light.
Which variant: a colour that reads on black fails on white, so every theme has a set for dark terminals and one for
light terminals. ROOKS_TERMINAL=light|dark decides; otherwise COLORFGBG (set by many terminals); otherwise the chosen
theme (light or dark) is taken as a hint; otherwise dark. auto is the terminal's own background.
How: 24-bit colour when the terminal says it supports it (COLORTERM=truecolor/24bit, Windows Terminal, iTerm, VS Code,
WezTerm), else the nearest of the 256 xterm colours. NO_COLOR and --no-color turn colour off (handled by the caller).
Every colour meets WCAG AA (4.5:1) against a black or white background.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

ROLES = ("accent", "ok", "error", "warn", "dim", "prompt")
THEMES = ("light", "dark", "contrast")
CHOICES = ("auto", *THEMES)
DARK_NAMES = ("night", "lamp", "neon", "cherry", "dark")
ALIASES = {**{n: "dark" for n in DARK_NAMES}, "high-contrast": "contrast", "contrast": "contrast", "auto": "auto",
           "match": "auto", "system": "auto"}
KNOWN_LIGHT = ("light", "sunshine", "paper", "linen", "gallery", "studio")

# theme -> terminal background -> role -> colour. The app's tokens: ink, ink-muted, accent-text, success/danger/warning-text.
_NEUTRAL = {
    "dark": {"accent": "#e9b949", "ok": "#8fd8ab", "error": "#f2a193", "warn": "#f0c870", "dim": "#a3a29e", "prompt": "#ededec"},
    "light": {"accent": "#7a5300", "ok": "#1e5a37", "error": "#82231a", "warn": "#7a4300", "dim": "#5e5d59", "prompt": "#1a1a19"},
}
PALETTES: dict[str, dict[str, dict[str, str]]] = {
    "light": _NEUTRAL,
    "dark": _NEUTRAL,  # the app's Dark and Light differ in the surface; in a terminal the surface is the terminal's own
    "contrast": {
        "dark": {"accent": "#ffd75e", "ok": "#5ef08a", "error": "#ff9a9a", "warn": "#ffd75e", "dim": "#e0e0e0", "prompt": "#ffffff"},
        "light": {"accent": "#6b4000", "ok": "#005c1f", "error": "#a00000", "warn": "#6b4000", "dim": "#1f1f1f", "prompt": "#000000"},
    },
}
BOLD_THEMES = ("contrast",)  # high contrast also makes every coloured line bold


def appearance_file() -> Path:
    p = os.environ.get("AI_WORKSPACE_APPEARANCE_FILE")
    return Path(p) if p else Path.home() / ".ai-workspace" / "appearance.json"


def normalise(name: str | None) -> str | None:
    """'light', 'dark', 'contrast' or 'auto'; an older theme name is mapped like the app maps it; None when unknown."""
    if not name:
        return None
    n = name.strip().lower()
    if n in ALIASES:
        return ALIASES[n]
    return "light" if n in KNOWN_LIGHT else None


def theme_from_app() -> str | None:
    try:
        data = json.loads(appearance_file().read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    resolved = normalise(data.get("resolved"))
    return resolved if resolved and resolved != "auto" else normalise(data.get("theme"))


def _told(env) -> str | None:
    """The background the terminal (or the person) says it has, or None."""
    forced = (env.get("ROOKS_TERMINAL") or "").strip().lower()
    if forced in ("light", "dark"):
        return forced
    fgbg = env.get("COLORFGBG", "")
    if fgbg:
        try:
            bg = int(fgbg.split(";")[-1])
            return "light" if bg in (7, 15) or 9 < bg < 16 and bg != 8 else "dark"
        except ValueError:
            pass
    return None


def terminal_background(env: dict | None = None) -> str:
    env = os.environ if env is None else env
    return _told(env) or "dark"


def truecolor(env: dict | None = None) -> bool:
    env = os.environ if env is None else env
    if env.get("COLORTERM", "").lower() in ("truecolor", "24bit"):
        return True
    if env.get("WT_SESSION"):
        return True
    return env.get("TERM_PROGRAM", "") in ("iTerm.app", "vscode", "WezTerm", "ghostty")


def _rgb(hex_colour: str) -> tuple[int, int, int]:
    h = hex_colour.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def to_256(hex_colour: str) -> int:
    """Nearest xterm-256 colour (6x6x6 cube or the grey ramp)."""
    r, g, b = _rgb(hex_colour)
    steps = [0, 95, 135, 175, 215, 255]

    def idx(v: int) -> int:
        return min(range(6), key=lambda i: abs(steps[i] - v))

    ci = (idx(r), idx(g), idx(b))
    cube = (steps[ci[0]], steps[ci[1]], steps[ci[2]])
    grey_i = max(0, min(23, round((sum((r, g, b)) / 3 - 8) / 10)))
    grey = 8 + grey_i * 10
    d_cube = sum((a - c) ** 2 for a, c in zip((r, g, b), cube))
    d_grey = sum((a - grey) ** 2 for a in (r, g, b))
    return 232 + grey_i if d_grey < d_cube else 16 + 36 * ci[0] + 6 * ci[1] + ci[2]


@dataclass
class TerminalTheme:
    name: str
    background: str
    true_colour: bool

    @property
    def palette(self) -> dict[str, str]:
        return PALETTES[self.name][self.background]

    def sgr(self, role: str) -> str:
        """The SGR parameters (the part between ESC[ and m) for a role, or a plain style ('bold')."""
        if role == "bold":
            return "1"
        colour = self.palette.get(role)
        if colour is None:
            return "0"
        r, g, b = _rgb(colour)
        base = f"38;2;{r};{g};{b}" if self.true_colour else f"38;5;{to_256(colour)}"
        return f"1;{base}" if self.name in BOLD_THEMES else base


# What the older hard-coded ANSI codes meant, so callers can keep passing them. Cyan and magenta were decoration: they
# are neutral ink now, so the accent stays for what is live or needs you.
LEGACY_CODES = {"31": "error", "32": "ok", "33": "warn", "36": "prompt", "2": "dim", "1": "bold", "35": "prompt", "34": "prompt"}


def load(name: str | None = None, env: dict | None = None) -> TerminalTheme:
    env = os.environ if env is None else env
    chosen = normalise(name) or normalise(env.get("ROOKS_THEME")) or theme_from_app() or "auto"
    told = _told(env)
    if chosen == "auto":
        background = told or "dark"
        chosen = background
    else:
        background = told or ("light" if chosen == "light" else "dark")
    return TerminalTheme(chosen, background, truecolor(env))
