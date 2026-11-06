"""A paired browser and the terminal key share the signed-in account. Computer use says when it can't."""

from starlette.testclient import TestClient


def _anon(client) -> TestClient:
    return TestClient(client.app)


def test_pairing_code_opens_the_same_account(client):
    code = client.post("/api/browser/pair/start").json()["code"]
    claimed = client.post("/api/browser/pair/claim", json={"code": code})
    assert claimed.status_code == 200
    token = claimed.json()["token"]
    assert client.post("/api/browser/pair/claim", json={"code": code}).status_code == 401

    anon = _anon(client)
    assert anon.get("/api/surfaces").status_code == 401
    ok = anon.get("/api/surfaces", headers={"Authorization": f"Bearer {token}"})
    assert ok.status_code == 200
    body = ok.json()
    assert body["local"] is True
    assert body["computer"] is False
    assert body["files"] == "this computer"
    assert "desktop app" in body["note"]
    assert "shared" not in body["note"]
    room = body["room"]  # the Room says what it is, never just "on": available, a plain label, and its isolation
    assert set(room) == {"available", "label", "isolation"}
    assert isinstance(room["available"], bool) and room["isolation"] in ("none", "namespace", "vm")
    for word in ("Xvfb", "driver", "http", "Workbench"):
        assert word not in room["label"], word
    headers = {"Authorization": f"Bearer {token}"}
    main = anon.get("/api/assistant/main", headers=headers).json()["id"]
    again = anon.get("/api/assistant/main", headers=headers).json()["id"]
    assert main == again


def test_the_desktop_key_is_the_same_account(client):
    import os

    key = os.environ["TOOLS_API_KEY"]
    anon = _anon(client)
    assert anon.get("/api/assistant/main", headers={"Authorization": f"Bearer {key}"}).status_code == 200
