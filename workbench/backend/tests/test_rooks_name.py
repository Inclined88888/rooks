"""The product is called Rooks on every normal screen (docs/architecture.md, g.4 and contradiction 3).

The old names "AI Workspace", "Workbench" and the wake phrase "hey workspace" must not come back in anything a person
reads: the server's own strings (errors, pages, mail steps, exports, Slack and Discord set-up), the built screens, and
the defaults a Docker install starts with. Internal names stay as they are (g.5): `aiworkspace://` links,
`~/.ai-workspace`, the `ai-workspace` command, `AI_WORKSPACE_*` and `WORKBENCH_*` settings, the `X-Workbench` request
header and Docker project and image names. Those are all lower case or upper case, or listed in ALLOWED below with the
reason; anything else is a new old name and fails here.
"""

import ast
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / "workbench" / "backend" / "app"
DIST = ROOT / "workbench" / "frontend" / "dist"

OLD = re.compile(r"AI Workspace|Workbench|(?i:hey workspace)")

# (file under app/ or "*" for any, exact text that may stay, why). Each entry must still be needed, so the list cannot go stale.
ALLOWED: list[tuple[str, str, str]] = [
    ("*", "X-Workbench", "the request header every screen sends; an internal name, not a product name"),
    ("account.py", "AI Workspace Cloud", "the old name of the hosted models connection, renamed once to Rooks Cloud"),
    ("connect.py", "its old name, AI Workspace",
     "Google and Microsoft still show the sign-in app under the old name until the owner renames it in their consoles"),
]


def _docstrings(tree: ast.AST) -> set[int]:
    """Strings that stand alone as a statement: docstrings, and the odd one placed after an import."""
    return {id(n.value) for n in ast.walk(tree)
            if isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)}


def _server_strings():
    """Every string literal in the server's code that is not a docstring (docstrings are for the people who code it)."""
    for path in sorted(APP.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        docs = _docstrings(tree)
        for n in ast.walk(tree):
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docs:
                yield path.relative_to(APP).as_posix(), n.lineno, n.value


def test_the_servers_words_say_rooks():
    used: set[int] = set()
    found = []
    for rel, line, text in _server_strings():
        for i, (where, keep, _why) in enumerate(ALLOWED):
            if where in (rel, "*") and keep in text:
                used.add(i)
                text = text.replace(keep, "")
        for m in OLD.finditer(text):
            found.append(f"{rel}:{line}: ...{text[max(0, m.start() - 40):m.end() + 40]}...")
    assert not found, "old product names on screen (say Rooks):\n" + "\n".join(found)
    stale = [ALLOWED[i][:2] for i in range(len(ALLOWED)) if i not in used]
    assert not stale, f"allow list entries no longer needed, remove them: {stale}"


def test_the_built_screens_say_rooks():
    files = sorted(DIST.rglob("*.js")) + sorted(DIST.rglob("*.html"))
    if not files:
        pytest.skip("the screens are not built")
    found = []
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace").replace("X-Workbench", "")
        if '"hey rooks"' in text:
            # the old wake phrase still wakes Rooks for people who learned it; it is never shown
            text = text.replace('"hey workspace"', "", 1)
        for m in OLD.finditer(text):
            found.append(f"{path.relative_to(DIST)}: ...{text[max(0, m.start() - 40):m.end() + 40]}...")
    assert not found, "old product names in the built screens (say Rooks, then rebuild):\n" + "\n".join(found)


def test_a_new_install_is_named_rooks():
    """The name a Docker install shows (Open WebUI's title, the server's name) and the search server's name."""
    compose = (ROOT / "docker-compose.yml").read_text()
    assert "${WORKSPACE_NAME:-AI Workspace}" not in compose
    assert compose.count("${WORKSPACE_NAME:-Rooks}") == 2
    assert re.search(r"^WORKSPACE_NAME=Rooks$", (ROOT / ".env.example").read_text(), re.M)
    assert 'ask NAME "Workspace name" "Rooks"' in (ROOT / "setup.sh").read_text()
    assert re.search(r'^\s*instance_name: "Rooks Search"$', (ROOT / "searxng" / "settings.yml").read_text(), re.M)
    assert '"name":"Workbench"' not in compose  # the tool server's name as Open WebUI lists it


def test_wake_phrase_is_hey_rooks(client):  # client first: the app reads its settings when imported
    from app import voice

    assert voice.DEFAULTS["voice_wake_phrase"] == "hey rooks"


def test_the_hosted_models_connection_keeps_its_row_under_the_new_name(client):
    """Someone who had "AI Workspace Cloud" keeps the same connection (history, default model), now called Rooks Cloud."""
    from app import account, db

    # the test session shares one database: set aside any cloud row another test made, and put it back after
    kept = [r["id"] for r in db.all("SELECT id FROM connections WHERE name IN ('AI Workspace Cloud', 'Rooks Cloud')")]
    for cid in kept:
        db.run("UPDATE connections SET name = ? WHERE id = ?", f"set aside {cid}", cid)
    old = db.run("INSERT INTO connections(name, auth_kind, protocol, base_url, secret_enc, models, enabled, residency, "
                 "created_at) VALUES ('AI Workspace Cloud', 'api_key', 'chat_completions', 'https://x.invalid/v1', '', "
                 "'auto', 1, 'cloud', ?)", db.now())
    try:
        account._sync_cloud_connection(False)
        rows = db.all("SELECT id, name, enabled FROM connections WHERE name IN ('AI Workspace Cloud', 'Rooks Cloud')")
        assert [(r["id"], r["name"], r["enabled"]) for r in rows] == [(old, "Rooks Cloud", 0)]
    finally:
        db.run("DELETE FROM connections WHERE id = ?", old)
        for cid in kept:
            db.run("UPDATE connections SET name = 'Rooks Cloud' WHERE id = ?", cid)


def test_connect_result_page_says_rooks(client):
    from app import connect

    assert "<title>Rooks</title>" in connect._PAGE and "AI Workspace" not in connect._PAGE
