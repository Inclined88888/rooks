"""The app is called Rooks on every normal screen, and the terminal agents it hands work to say the same (AGENTS.md:
the terminal, the browser and the app match). Internal names (WORKBENCH_URL, the `ai-workspace` command, app.json's
folder) are unchanged."""

from pathlib import Path

import pytest

from rooks_browser import llm

SRC = Path(llm.__file__).resolve().parent


def test_the_app_provider_is_called_rooks(monkeypatch):
    label = llm.PROVIDERS["workbench"].label
    assert "Rooks app" in label and "AI Workspace" not in label
    monkeypatch.delenv("WORKBENCH_URL", raising=False)
    monkeypatch.setattr(llm, "app_link", lambda: {})
    with pytest.raises(ValueError) as e:
        llm.make("workbench", "auto")
    assert "Rooks app" in str(e.value) and "AI Workspace" not in str(e.value)


def test_the_run_header_says_rooks():
    assert '"AI Workspace app' not in (SRC / "cli.py").read_text()
