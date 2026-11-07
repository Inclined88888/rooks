"""A forgotten PIN cannot be read back. On this computer it can be replaced, and the work stays."""


def test_forgotten_pin_can_be_replaced(client, monkeypatch):
    from app import db, security

    monkeypatch.setattr(security, "_attempts", {})  # earlier tests' sign-ins share the throttle window; start clean

    try:
        r = client.post("/api/lock/reset")
        assert r.status_code == 200
        assert db.get_setting("setup_complete") == "0"
        assert client.post("/api/login", json={"password": "testpassword1"}).status_code == 401
        assert client.post("/api/setup", json={"password": "testpassword1"}).status_code == 200
        assert db.get_setting("setup_complete") == "1"
        assert client.post("/api/login", json={"password": "testpassword1"}).status_code == 200
    finally:
        if db.get_setting("setup_complete") != "1":
            client.post("/api/setup", json={"password": "testpassword1"})
