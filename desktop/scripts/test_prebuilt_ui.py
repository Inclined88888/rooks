"""The one-command install trusts the committed web UI only when every file it asks for is there.

A dist/ with a new index.html but without its hashed scripts opened as a blank window on every fresh install
(commit 4bbb480): `.gitignore` made `git add` skip the new files while it still recorded the new index.html.
"""

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "desktop" / "launcher"))

import install_helper  # noqa: E402

INDEX = '<html><head><script type="module" src="/assets/index-A1.js"></script>' \
        '<link rel="stylesheet" href="/assets/index-B2.css"></head></html>'
ENTRY = 'const P=()=>import("./Page-C3.js");const d=["assets/Page-D4.css"];'


def build(tmp_path: Path, *, skip: str = "") -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX)
    files = {"index-A1.js": ENTRY, "index-B2.css": "body{}", "Page-C3.js": "export default 1", "Page-D4.css": "p{}"}
    for name, text in files.items():
        if name != skip:
            (dist / "assets" / name).write_text(text)
    return dist


def test_a_complete_build_is_trusted(tmp_path):
    assert install_helper.missing_web_files(build(tmp_path)) == []


@pytest.mark.parametrize("gone", ["index-A1.js", "index-B2.css", "Page-C3.js", "Page-D4.css"])
def test_any_missing_file_is_reported(tmp_path, gone):
    assert install_helper.missing_web_files(build(tmp_path, skip=gone)) == [f"assets/{gone}"]


def test_no_index_or_an_empty_one_is_not_a_build(tmp_path):
    assert install_helper.missing_web_files(tmp_path / "nothing") == ["index.html"]
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "index.html").write_text("<html></html>")
    assert install_helper.missing_web_files(tmp_path / "dist") == ["index.html (names no script)"]


def test_an_incomplete_prebuilt_copy_is_built_instead(tmp_path, monkeypatch):
    src = tmp_path / "src"
    dist = src / "workbench" / "frontend" / "dist"
    dist.parent.mkdir(parents=True)
    build(tmp_path / "x", skip="index-A1.js").rename(dist)
    ran: list[list[str]] = []
    monkeypatch.setattr(install_helper.shutil, "which", lambda name: "/usr/bin/npm" if name == "npm" else None)
    monkeypatch.setattr(install_helper, "run", lambda argv, **kw: ran.append(list(argv)))
    install_helper.ensure_frontend(src, tmp_path / "home")
    assert ran == [["/usr/bin/npm", "ci", "--no-audit", "--no-fund", "--loglevel=error"], ["/usr/bin/npm", "run", "build"]]


def test_a_complete_prebuilt_copy_is_not_rebuilt(tmp_path, monkeypatch):
    src = tmp_path / "src"
    dist = src / "workbench" / "frontend" / "dist"
    dist.parent.mkdir(parents=True)
    build(tmp_path / "x").rename(dist)
    monkeypatch.setattr(install_helper, "run", lambda *a, **k: pytest.fail("rebuilt a complete copy"))
    install_helper.ensure_frontend(src, tmp_path / "home")


def test_the_committed_web_ui_is_complete():
    """What the one-command install downloads from main. If this fails, rebuild (npm run build in workbench/frontend)
    and commit the whole workbench/frontend/dist folder."""
    assert install_helper.missing_web_files(REPO / "workbench" / "frontend" / "dist") == []
