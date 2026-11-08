"""The race card (design record 0009, section 7): the terminal posts a race at start and on each change, the app keeps
it as a job of kind race on the Jobs board with the scoreboard, and the pick follows the approvals rule exactly: the
signed in person or the Terminal access token may pick; the app's own key in app.json (readable by any command on this
computer, a candidate's included) gets the approvals' own refusal, and so does a coding job's key.

Every check goes through the real routes and dependencies; nothing here stubs authorisation.
"""

from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient

BROWSER = "browser-helper-key-0123456789abcdef"   # app.json: the terminal, the browser and desk helpers
CODING = "coding-job-key-0123456789abcdef0123"
TOKEN = "wb_terminal-token-for-tests-0123456789"
W = {"X-Workbench": "1"}

ROWS = [
    {"n": 1, "label": "fake-model · smallest", "proof": "fails first", "others": "1/1", "project": "2 passed", "diff": "+6 -1",
     "files": 2, "tokens": 360, "cost": "unknown", "time": "4 s", "status": "finished", "full_pass": True,
     "diff_text": "--- a/calc.py\n+++ b/calc.py\n@@\n-    return a - b\n+    return a + b\n", "tests": {"project": "2 passed"}},
    {"n": 2, "label": "fake-model · robust", "proof": "proves nothing", "others": "1/1", "project": "2 passed", "diff": "+2 -1",
     "files": 2, "tokens": 360, "cost": "unknown", "time": "4 s", "status": "finished", "full_pass": False,
     "diff_text": "", "tests": {}},
]


@pytest.fixture()
def keys(client, monkeypatch):
    from app import config, db, security

    monkeypatch.setattr(config, "BROWSER_API_KEY", BROWSER, raising=False)
    monkeypatch.setattr(config, "CODING_BRIDGE_KEY", CODING, raising=False)
    monkeypatch.setattr(security, "_attempts", {})
    db.set_setting("cli_token_hash", hashlib.sha256(TOKEN.encode()).hexdigest())
    yield


def anon(client) -> TestClient:
    return TestClient(client.app)


def bearer(key: str, write: bool = False) -> dict:
    h = {"Authorization": f"Bearer {key}", "X-Workbench-Channel": "rooks-code"}
    return {**h, **W} if write else h


def _start(a, key=BROWSER, task="make add() handle negative numbers") -> int:
    r = a.post("/v1/rooks/race", headers=bearer(key), json={"race": "20261108T120000Z-abc123", "task": task, "candidates": 2,
                                                            "cap_usd": 1.0, "cap_tokens": 200000})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _board(a, key=BROWSER) -> dict:
    r = a.get("/api/jobs", headers=bearer(key))
    assert r.status_code == 200, r.text
    return r.json()


def test_the_app_shows_a_race_job_and_only_the_person_or_terminal_token_can_pick(client, keys):
    a = anon(client)
    jid = _start(a)
    job = next(j for j in _board(a)["running"] if j["id"] == jid)
    assert job["kind"] == "race" and job["title"] == "Race: make add() handle negative numbers"
    assert job["detail"] == "2 of 2 running" and job["status"] == "running"

    # the scoreboard arrives; the race waits for a pick in the Needs you column
    r = a.post(f"/v1/rooks/race/{jid}", headers=bearer(BROWSER), json={"status": "waiting", "detail": "", "rows": ROWS})
    assert r.status_code == 200, r.text
    job = next(j for j in _board(a)["you"] if j["id"] == jid)
    assert job["status"] == "waiting" and job["needs"] == "pick" and len(job["payload"]["rows"]) == 2
    assert job["payload"]["rows"][0]["proof"] == "fails first" and job["payload"]["picked"] is None
    assert job["detail"] == "Pick one, or none"

    # the app's own key and a coding job's key get the approvals' own refusal; the pick still waits
    for key in (BROWSER, CODING):
        r = a.post(f"/api/jobs/{jid}/pick", headers=bearer(key, write=True), json={"candidate": 1})
        assert r.status_code == 403, (key, r.status_code, r.text)
        assert "Only you" in r.json()["detail"]
    assert a.get(f"/v1/rooks/race/{jid}", headers=bearer(BROWSER)).json()["picked"] is None
    assert a.post(f"/api/jobs/{jid}/pick", headers=W, json={"candidate": 1}).status_code == 401  # nobody at all

    # the Terminal access token (rooks login) picks; the terminal reads it back with the app key
    r = a.post(f"/api/jobs/{jid}/pick", headers={"Authorization": f"Bearer {TOKEN}", **W}, json={"candidate": 1})
    assert r.status_code == 200, r.text
    got = a.get(f"/v1/rooks/race/{jid}", headers=bearer(BROWSER)).json()
    assert got["picked"] == 1 and got["status"] == "waiting"
    job = next(j for j in _board(a)["you"] if j["id"] == jid)
    assert job["detail"] == "Picked here; the terminal applies it." and job["payload"]["picked"] == 1
    assert a.post(f"/api/jobs/{jid}/pick", headers={"Authorization": f"Bearer {TOKEN}", **W}, json={"candidate": 2}).status_code == 409
    assert a.post(f"/api/jobs/{jid}/pick", headers={"Authorization": f"Bearer {TOKEN}", **W}, json={"candidate": 5}).status_code == 400

    # the terminal applied it: the job is done, with what happened
    r = a.post(f"/v1/rooks/race/{jid}", headers=bearer(BROWSER), json={"status": "done", "result": "Applied Candidate 1's changes: 2 files (+6 -1)."})
    assert r.status_code == 200
    job = next(j for j in _board(a)["done"] if j["id"] == jid)
    assert job["status"] == "done" and "Applied Candidate 1" in job["result"]


def test_the_signed_in_person_picks_none_and_a_stop_in_the_app_reaches_the_terminal(client, keys):
    a = anon(client)
    jid = _start(a, task="tidy the imports")
    a.post(f"/v1/rooks/race/{jid}", headers=bearer(BROWSER), json={"status": "waiting", "rows": ROWS})
    r = client.post(f"/api/jobs/{jid}/pick", json={"candidate": 0})  # the signed in app: "Use none"
    assert r.status_code == 200, r.text
    assert a.get(f"/v1/rooks/race/{jid}", headers=bearer(BROWSER)).json()["picked"] == 0
    # a race runs in the terminal: the app can stop it, and never pauses, resumes or reruns it itself
    jid2 = _start(a, task="rename foo")
    for verb in ("pause", "resume", "retry", "start"):
        assert client.post(f"/api/jobs/{jid2}/{verb}").status_code == 409, verb
    assert client.post(f"/api/jobs/{jid2}/stop").status_code == 200
    assert a.get(f"/v1/rooks/race/{jid2}", headers=bearer(BROWSER)).json()["status"] == "stopped"
    # a later post from the terminal does not wake a stopped race
    r = a.post(f"/v1/rooks/race/{jid2}", headers=bearer(BROWSER), json={"status": "running", "detail": "1 of 2 running"})
    assert r.status_code == 200 and r.json()["status"] == "stopped"


def test_a_race_update_is_only_taken_from_the_terminal_and_only_for_a_race(client, keys):
    a = anon(client)
    assert a.post("/v1/rooks/race", headers=W, json={"race": "x", "task": "t", "candidates": 1}).status_code == 401
    assert a.get("/v1/rooks/race/999999", headers=bearer(BROWSER)).status_code == 404
    chat = client.post("/api/jobs", json={"kind": "chat", "prompt": "hello there"}).json()
    r = a.post(f"/v1/rooks/race/{chat['id']}", headers=bearer(BROWSER), json={"status": "waiting", "rows": ROWS})
    assert r.status_code == 404  # not a race
    assert client.post(f"/api/jobs/{chat['id']}/pick", json={"candidate": 1}).status_code == 409
    client.post(f"/api/jobs/{chat['id']}/stop")
