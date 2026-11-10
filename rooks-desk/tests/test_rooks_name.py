"""The app is called Rooks on every normal screen, and Rooks Desk says the same (AGENTS.md: the terminal, the browser
and the app match). macOS still lists the desktop app as AI Workspace until it is renamed (the room-browser branch),
so the Privacy & Security steps keep that name."""

from pathlib import Path

import pytest

from rooks_desk import llm

SRC = Path(llm.__file__).resolve().parent


def test_the_app_provider_is_called_rooks(monkeypatch):
    label = llm.PROVIDERS["workbench"].label
    assert "Rooks app" in label and "AI Workspace" not in label
    monkeypatch.delenv("WORKBENCH_URL", raising=False)
    monkeypatch.setattr(llm, "app_link", lambda: {})
    with pytest.raises(ValueError) as e:
        llm.make("workbench", "auto")
    assert "Rooks app" in str(e.value) and "AI Workspace" not in str(e.value)


@pytest.mark.parametrize("name", ["cli.py", "runner.py", "agent.py"])
def test_messages_say_rooks(name):
    text = (SRC / name).read_text()
    for old in ("open AI Workspace", "goes through AI Workspace", "the AI Workspace app", "account in AI Workspace"):
        assert old not in text, f"{name}: {old}"
