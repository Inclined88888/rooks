"""The workplace cleanup (docs/architecture.md, section g) stays done: removed things do not come back."""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _tracked(*paths: str) -> list[str]:
    if not shutil.which("git") or not (ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    out = subprocess.run(["git", "ls-files", "--", *paths], cwd=ROOT, capture_output=True, text=True, check=True)
    return [line for line in out.stdout.splitlines() if line]


def test_screenshots_folder_is_not_tracked():
    """`.gitignore` keeps /screenshots/ for throwaway captures; 347 old pictures (40 MB) were tracked anyway."""
    tracked = _tracked("screenshots")
    assert not tracked, f"{len(tracked)} files under screenshots/ are tracked again, e.g. {tracked[:3]}"
    assert "/screenshots/" in (ROOT / ".gitignore").read_text().splitlines()


def test_removed_root_files_stay_removed():
    gone = ["marketing/launch-posts.md", "PROGRESS-desktop.md", "ai-workspace-audit-report.md",
            "scripts/test_vertical_slice.py"]
    assert not _tracked(*gone)
