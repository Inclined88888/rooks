"""Developer tools are hidden behind one switch, and paid-plan checks are off unless a build opts in.

Workplace teams do not need the Terminal, Code, Fine-tune, Compare, Run log, Insights, Status, Extra tools or the packs
in their menus (docs/architecture.md, section g.3). The app keeps them and their addresses; one switch in Settings,
Advanced ("Show developer tools") lists them again. The switch is off on a new install and is remembered by the
install, so every window and paired browser agrees. Only the person can flip it: a helper or coding job holding a
bridge key cannot.

Plan checks: no Rooks cloud sells plans today, so a paywall would point at nothing. account.py keeps its code, but the
checks only run when a build or install opts in with AIW_PLAN_CHECKS=1 (AIW_ENFORCE_PLANS still forces either way).
"""

import httpx

from tests.test_account import CLOUD, PUB, FakeCloud


def test_the_switch_is_off_on_a_new_install(client):
    assert client.get("/api/status").json()["dev_tools"] is False
    assert client.get("/api/settings").json()["dev_tools"] is False


def test_the_switch_is_remembered_by_the_install(client):
    from app import db

    try:
        assert client.put("/api/settings", json={"dev_tools": True}).json()["dev_tools"] is True
        assert db.get_setting("dev_tools") == "1"
        assert client.get("/api/status").json()["dev_tools"] is True
        assert client.get("/api/settings").json()["dev_tools"] is True
        assert client.put("/api/settings", json={"dev_tools": False}).json()["dev_tools"] is False
        assert client.get("/api/status").json()["dev_tools"] is False
    finally:
        db.set_setting("dev_tools", "0")


def _signed_out():
    """A second client on the same running app, with no session cookie (the shared client keeps its own)."""
    from fastapi.testclient import TestClient

    from app import main

    return TestClient(main.app, headers={"X-Workbench": "1"})


def test_signed_out_status_never_says_on(client):
    from app import db

    db.set_setting("dev_tools", "1")
    try:
        assert client.get("/api/status").json()["dev_tools"] is True
        assert _signed_out().get("/api/status").json()["dev_tools"] is False
    finally:
        db.set_setting("dev_tools", "0")


def test_a_bridge_key_cannot_flip_the_switch(client, monkeypatch):
    """The browser and desk helpers and coding jobs hold a bridge key; it must not change the person's settings."""
    from app import config, db

    monkeypatch.setattr(config, "BROWSER_API_KEY", "bridge-key-for-this-test-0123456789")
    r = _signed_out().put("/api/settings", json={"dev_tools": True}, headers={"Authorization": "Bearer bridge-key-for-this-test-0123456789"})
    assert r.status_code == 401
    assert db.get_setting("dev_tools", "0") != "1"


def _cloud_says_billing_is_live(monkeypatch):
    from app import account

    fake = FakeCloud()
    monkeypatch.setenv("AIW_CLOUD_URL", CLOUD)
    monkeypatch.setenv("AIW_CLOUD_PUBLIC_KEY", PUB)
    monkeypatch.delenv("AIW_ENFORCE_PLANS", raising=False)
    monkeypatch.setattr(account, "_http", httpx.Client(transport=httpx.MockTransport(fake)))
    return fake


def _forget_account():
    from app import account, db

    for k in ("account_billing_live", "account_plans_checked_at", "account_setup_seen"):
        db.set_setting(k, "")
    account._sync_cloud_connection(False)


def test_plan_checks_are_off_by_default_even_when_a_cloud_says_billing_is_live(client, monkeypatch):
    from app import account, features_v02

    _cloud_says_billing_is_live(monkeypatch)
    monkeypatch.delenv("AIW_PLAN_CHECKS", raising=False)
    try:
        s = client.get("/api/account").json()
        assert s["billing_live"] is False and all(f["unlocked"] for f in s["pro_features"])
        assert not account.billing_live()
        assert all(features_v02.allowed(f) for f in features_v02.FEATURE_TIERS)
        assert client.post("/api/mobile/pair/start").status_code == 200  # no paywall
    finally:
        _forget_account()


def test_a_build_that_opts_in_still_gets_the_plan_checks(client, monkeypatch):
    _cloud_says_billing_is_live(monkeypatch)
    monkeypatch.setenv("AIW_PLAN_CHECKS", "1")
    try:
        assert client.get("/api/account").json()["billing_live"] is True
        assert client.post("/api/mobile/pair/start").status_code == 402
    finally:
        _forget_account()
