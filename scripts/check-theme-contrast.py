#!/usr/bin/env python3
"""Check WCAG AA contrast for every theme on every surface. Exit 1 on any failure.

  App (desktop window + web): reads workbench/frontend/src/tokens.css, the one palette file (design system v4,
  "industrial"), and works out each theme's colours the way the browser does: the light block (`:root` and
  html[data-mode="light"]) first, then html[data-mode="dark"] or html[data-mode="contrast"] on top. Then checks text
  pairs at 4.5:1 and the edges a person needs to see (control borders, the focus ring) at 3:1.
  The safety orange (#FF4D00) is 2.97:1 on the light paper and 3.33:1 on white: it is used for marks (dots, squares,
  rules) that always sit beside words, never for small text; the script prints that as a note, not a failure.
  Terminal (Rooks Code, Rooks Browser): every role colour against black, white and the usual off-black/off-white.
  Phone: mobile/src/lib/theme.ts is checked by its own jest test (src/lib/__tests__/theme.test.ts).

Usage: python3 scripts/check-theme-contrast.py [-v]
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "workbench" / "frontend" / "src" / "tokens.css"
THEMES = {"light": 'html[data-mode="light"]', "dark": 'html[data-mode="dark"]', "contrast": 'html[data-mode="contrast"]'}

TEXT_PAIRS = [  # (foreground, background) that must reach 4.5:1
    *[(fg, bg) for fg in ("ink", "ink-soft", "ink-muted") for bg in ("bg", "surface", "surface-raised", "surface-muted", "bg-hover", "accent-soft")],
    ("ink", "bg-active"),
    ("accent-text", "bg"), ("accent-text", "surface"), ("accent-text", "surface-muted"), ("accent-text", "accent-soft"),
    ("on-primary", "primary"), ("on-primary-hover", "primary-hover"), ("on-accent", "accent"), ("on-danger", "danger"),
    ("success-text", "bg"), ("warning-text", "bg"), ("danger-text", "bg"),
    ("success-text", "success-soft"), ("warning-text", "warning-soft"), ("danger-text", "danger-soft"),
    ("code-keyword", "code-bg"), ("code-string", "code-bg"), ("code-number", "code-bg"), ("code-title", "code-bg"), ("code-type", "code-bg"),
    ("on-dark", "dark"), ("on-dark-muted", "dark"),
    # the primitives (industrial step 2): mono badge words on the sunken fill
    ("ink", "surface-sunken"), ("ink-muted", "surface-sunken"),
    # the shell (industrial step 3): grey nav links and menu words on the current row's fill (the phone bar's current
    # cell, ink on paper, is checked in tests/glass.test.mjs)
    ("ink-muted", "bg-active"),
]
UI_PAIRS = [  # non-text that a person needs to see: 3:1
    ("border-strong", "bg"), ("border-strong", "surface"), ("ink-faint", "bg"), ("border-focus", "bg"), ("accent", "surface"),
    # the primitives (industrial step 2): the square marks on toasts and receipts, the ink edge of what you press
    ("on-primary", "success"), ("on-primary", "danger"), ("on-primary", "warning"), ("ink", "bg"),
]
# orange marks on the paper: always beside words, reported for the record. The current link's orange rule in the top
# bar is one of them: the link itself also turns ink and bold and carries aria-current (shell/shell.css).
DECORATIVE = [("accent", "bg")]
def lum(hex_colour: str) -> float:
    h = hex_colour.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)

    def ch(v: int) -> float:
        x = v / 255
        return x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def ratio(a: str, b: str) -> float:
    x, y = sorted((lum(a), lum(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def _blocks(css: str) -> dict:
    """Custom properties per selector block, comments stripped (only plain #rrggbb values matter here)."""
    out: dict = {}
    for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", re.sub(r"/\*.*?\*/", "", css, flags=re.S)):
        decls = dict((k.strip(), v.strip()) for k, v in re.findall(r"(--[\w-]+)\s*:\s*([^;]+)", body))
        for s in sel.split(","):
            out.setdefault(s.strip(), {}).update(decls)
    return out


def tokens(theme: str) -> dict:
    b = _blocks(TOKENS.read_text())
    vals: dict = {}
    vals.update(b.get(":root", {}))
    vals.update(b.get(THEMES["light"], {}))
    if theme != "light":
        vals.update(b.get(THEMES[theme], {}))
    return vals


def check_workbench(verbose: bool) -> list[str]:
    fails = []
    for tid in THEMES:
        t = tokens(tid)
        for pairs, need in ((TEXT_PAIRS, 4.5), (UI_PAIRS, 3.0)):
            for fg, bg in pairs:
                a, b = t.get(f"--color-{fg}"), t.get(f"--color-{bg}")
                if not (a and b and a.startswith("#") and b.startswith("#")):
                    fails.append(f"app {tid}: missing --color-{fg} or --color-{bg}")
                    continue
                r = ratio(a, b)
                if verbose:
                    print(f"  app {tid:<9} {fg:>16} on {bg:<15} {r:5.2f}")
                if r < need:
                    fails.append(f"app {tid}: --color-{fg} {a} on --color-{bg} {b} is {r:.2f}:1 (needs {need})")
        # the focus ring: orange, on a 1 px ink halo; 3:1 against the page by itself or through the halo
        ring, halo, page = t.get("--color-focus"), t.get("--color-focus-halo"), t.get("--color-bg")
        if not (ring and halo and page):
            fails.append(f"app {tid}: missing --color-focus, --color-focus-halo or --color-bg")
        elif not (ratio(ring, page) >= 3 or (ratio(halo, page) >= 3 and ratio(ring, halo) >= 3)):
            fails.append(f"app {tid}: the focus ring {ring} on {page} (halo {halo}) is under 3:1")
        if verbose:
            for fg, bg in DECORATIVE:
                a, b = t.get(f"--color-{fg}"), t.get(f"--color-{bg}")
                print(f"  app {tid:<9} {fg:>16} on {bg:<15} {ratio(a, b):5.2f}  (decoration beside words)")
    return fails


def check_terminal(verbose: bool) -> list[str]:
    sys.path.insert(0, str(ROOT / "rooks-code"))
    from rooks_code import theme as code_theme  # noqa: E402
    sys.path.insert(0, str(ROOT / "rooks-browser"))
    from rooks_browser import theme as browser_theme  # noqa: E402
    fails = []
    if code_theme.PALETTES != browser_theme.PALETTES:
        fails.append("terminal: rooks-code and rooks-browser palettes differ (copy rooks_code/theme.py over)")
    for tid, variants in code_theme.PALETTES.items():
        for bg_kind, backgrounds in (("dark", ("#000000", "#1e1e1e", "#282c34")), ("light", ("#ffffff", "#f5f5f5"))):
            for role, colour in variants[bg_kind].items():
                for bg in backgrounds:
                    r = ratio(colour, bg)
                    if verbose:
                        print(f"  terminal  {tid:<9} {bg_kind:<5} {role:>7} on {bg} {r:5.2f}")
                    if r < 4.5:
                        fails.append(f"terminal {tid}/{bg_kind}: {role} {colour} on {bg} is {r:.2f}:1")
    return fails


if __name__ == "__main__":
    v = "-v" in sys.argv
    fails = check_workbench(v) + check_terminal(v)
    if fails:
        print("Contrast failures:")
        for f in fails:
            print("  ✗ " + f)
        sys.exit(1)
    print(f"All themes pass AA: {len(THEMES)} app themes x {len(TEXT_PAIRS) + len(UI_PAIRS) + 1} pairs, terminal palettes on dark and light terminals.")
