"""Server installs sign in with a one-time link instead of a typed PIN. The lock stays: without a link, nothing opens."""

import time


def _fresh_cookies(client):
    client.cookies.clear()


def test_a_link_signs_in_once_and_only_once(client, monkeypatch):
    from app import security, signin

    monkeypatch.setattr(security, "_attempts", {})
    code = signin.make_code()
    _fresh_cookies(client)
    try:
        assert client.get("/api/status").json()["signed_in"] is False
        r = client.get(f"/api/signin?code={code}", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/"
        assert client.get("/api/status").json()["signed_in"] is True
        _fresh_cookies(client)
        again = client.get(f"/api/signin?code={code}", follow_redirects=False)
        assert again.status_code == 303 and again.headers["location"] == "/?signin=expired", "a used link does not work twice"
        assert client.get("/api/status").json()["signed_in"] is False
    finally:
        _fresh_cookies(client)
        assert client.post("/api/login", json={"password": "testpassword1"}).status_code == 200


def test_a_wrong_or_old_link_opens_nothing(client, monkeypatch):
    from app import security, signin

    monkeypatch.setattr(security, "_attempts", {})
    _fresh_cookies(client)
    try:
        assert client.get("/api/signin?code=not-a-real-code", follow_redirects=False).headers["location"] == "/?signin=expired"
        old = signin.make_code(ttl=60)
        later = time.time() + 120
        monkeypatch.setattr(signin.time, "time", lambda: later)
        assert client.get(f"/api/signin?code={old}", follow_redirects=False).headers["location"] == "/?signin=expired"
        assert client.get("/api/status").json()["signed_in"] is False
    finally:
        monkeypatch.undo()
        _fresh_cookies(client)
        assert client.post("/api/login", json={"password": "testpassword1"}).status_code == 200


def test_a_signed_in_person_can_make_a_link_for_another_device(client):
    r = client.post("/api/signin/link")
    assert r.status_code == 200
    url = r.json()["url"]
    assert "/api/signin?code=" in url
    code = url.split("code=", 1)[1]
    from app import signin

    assert signin.take(code) is True
    assert signin.take(code) is False


def test_making_a_link_needs_a_signed_in_person(client):
    _fresh_cookies(client)
    try:
        assert client.post("/api/signin/link").status_code == 401
    finally:
        assert client.post("/api/login", json={"password": "testpassword1"}).status_code == 200


def test_the_first_link_finishes_setup_with_no_pin(client, monkeypatch):
    from app import api, db, security, signin

    monkeypatch.setattr(security, "_attempts", {})
    saved = {k: db.get_setting(k) or "" for k in ("password_hash", "setup_complete", "lock_kind")}
    monkeypatch.setattr(api, "SETUP_CODE", "first-run-code")
    db.set_setting("setup_complete", "0")
    _fresh_cookies(client)
    try:
        status = client.get("/api/status").json()
        assert status["setup_complete"] is False and status["pin_login"] is False
        r = client.get("/api/signin?code=first-run-code", follow_redirects=False)
        assert r.status_code == 303
        assert db.get_setting("setup_complete") == "1"
        assert db.get_setting("lock_kind") == "link"
        assert client.get("/api/status").json()["signed_in"] is True
        assert client.get("/api/status").json()["pin_login"] is False, "nobody typed a PIN, so none is offered"
        _fresh_cookies(client)
        later = client.get("/api/signin?code=first-run-code", follow_redirects=False)
        assert later.headers["location"] == "/?signin=expired", "the setup code only works before setup"
        assert signin.take("first-run-code") is False
    finally:
        for k, v in saved.items():
            db.set_setting(k, v)
        _fresh_cookies(client)
        assert client.post("/api/login", json={"password": "testpassword1"}).status_code == 200
