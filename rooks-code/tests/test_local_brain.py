"""One local brain under ~/.rooks — paths, migration, skills, keys, Needs you."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from rooks_code import config, local_brain, learning


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "rooks-home"
    h.mkdir()
    monkeypatch.setenv("ROOKS_HOME", str(h))
    monkeypatch.delenv("ROOKS_CONFIG", raising=False)
    monkeypatch.delenv("AI_WORKSPACE_APP_FILE", raising=False)
    monkeypatch.delenv("ROOKS_APP_FILE", raising=False)
    local_brain._MIGRATED.clear()
    return h


def test_rooks_home_and_layout(home):
    assert local_brain.rooks_home() == home
    assert local_brain.config_dir() == home / "config"
    assert local_brain.terminal_memory_path() == home / "config" / "terminal-memory.json"
    assert local_brain.skills_dir() == home / "skills"
    assert local_brain.needs_you_dir() == home / "run" / "needs-you"
    assert config.config_path() == home / "config" / "rooks.toml"
    assert config.keys_path() == home / "config" / "rooks-keys.json"
    assert config.app_link_path() == home / "run" / "app.json"


def test_migrates_legacy_toml_and_memory(home, tmp_path, monkeypatch):
    legacy = tmp_path / "legacy-ai-workspace"
    legacy.mkdir()
    (legacy / "rooks.toml").write_text('provider = "ollama"\n', encoding="utf-8")
    (legacy / "memory.json").write_text(json.dumps({"facts": ["Uses pnpm"]}), encoding="utf-8")
    (legacy / "rooks-keys.json").write_text(json.dumps({"groq": "gsk_x"}), encoding="utf-8")
    monkeypatch.setattr(local_brain, "legacy_config_dir", lambda: legacy)

    assert config.config_path().read_text(encoding="utf-8").startswith("provider")
    assert config.config_path() == home / "config" / "rooks.toml"
    assert json.loads(config.keys_path().read_text())["groq"] == "gsk_x"
    facts = learning._load_local()
    assert facts == ["Uses pnpm"]
    assert learning.local_path() == home / "config" / "terminal-memory.json"


def test_store_key_mirrors_secrets_env(home, monkeypatch):
    path = config.store_key("groq", "gsk_test_shared")
    assert path == home / "config" / "rooks-keys.json"
    secrets = (home / "secrets.env").read_text(encoding="utf-8")
    assert "GROQ_API_KEY=gsk_test_shared" in secrets
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    s = config.resolve({"provider": "groq"}, home, {})
    assert s.api_key == "gsk_test_shared"


def test_offline_skills_from_rooks_skills_dir(home):
    skill = home / "skills" / "ship-check"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: ship-check\ndescription: Run the release checklist\n---\n\n1. Test\n2. Tag\n",
        encoding="utf-8",
    )
    listed = local_brain.list_rooks_skills()
    assert listed[0]["name"] == "ship-check"
    assert "release checklist" in listed[0]["description"]

    s = config.resolve({"provider": "ollama"}, home, {})
    learn = learning.Learning(s)
    ctx = learn.context("ship it")
    assert "ship-check" in ctx
    body = learn.load_skill("ship-check")
    assert "1. Test" in body


def test_needs_you_drop_and_clear(home):
    path = local_brain.write_needs_you({
        "id": "t:abc", "anchor": "t:abc", "title": "Edit file", "source": "rooks-code", "status": "pending",
    })
    assert path is not None and path.exists()
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["title"] == "Edit file"
    local_brain.clear_needs_you("t:abc")
    assert not path.exists()


def test_parse_secrets_env_matches_daemon_shape():
    raw = '# c\nexport OPENAI_API_KEY="sk-1"\nGROQ_API_KEY=gsk_2\n'
    assert local_brain.parse_secrets_env(raw) == {
        "OPENAI_API_KEY": "sk-1",
        "GROQ_API_KEY": "gsk_2",
    }
