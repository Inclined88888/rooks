"""Notices a person sees when a piece is missing stay in plain words."""

from fastapi import HTTPException


def test_browser_off_does_not_mention_the_installer(client, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "BROWSER_URL", "")
    monkeypatch.setattr(config, "BROWSER_API_KEY", "")
    r = client.get("/api/browser/jobs")
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail == "The browser is not turned on for this computer."
    assert "--" not in detail


def test_no_model_says_where_to_connect_one(monkeypatch):
    from app import db, llm

    monkeypatch.setattr(db, "get_setting", lambda key, default=None: "" if key == "default_model" else default)
    monkeypatch.setattr(db, "one", lambda *a, **k: None)
    monkeypatch.setattr(db, "all", lambda *a, **k: [])
    try:
        llm.default_model_ref()
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "No model is connected yet. Open AI models and connect one."
        assert "API key" not in exc.detail
    else:
        raise AssertionError("a missing model should say so")
