"""The Rooks Browser app (app/, Electron) driven by the same agent as Chrome, through its control channel.

Real Electron under a virtual display (xvfb-run), the local test shop, and the scripted model. Skipped when the app's
dependencies are not installed (cd rooks-browser/app && npm install) or there is no xvfb-run.
"""

import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from fakes import act, click

from rooks_browser import receipts
from rooks_browser.llm import ScriptedModel
from rooks_browser.runner import Settings, run_task

APP = Path(__file__).resolve().parent.parent / "app"
ELECTRON = APP / "node_modules" / "electron" / "dist" / ("electron.exe" if os.name == "nt" else "electron")


@pytest.fixture
def app(tmp_path):
    if not ELECTRON.exists():
        pytest.skip("the browser app is not installed (cd rooks-browser/app && npm install)")
    xvfb = shutil.which("xvfb-run")
    if sys.platform.startswith("linux") and not os.environ.get("DISPLAY") and not xvfb:
        pytest.skip("no display and no xvfb-run")
    control_file = tmp_path / "control.json"
    env = {k: v for k, v in os.environ.items() if k != "NODE_OPTIONS"}
    env.update(ROOKS_BROWSER_APP_DATA=str(tmp_path / "appdata"), ROOKS_BROWSER_CONTROL_FILE=str(control_file),
               ROOKS_BROWSER_CMD=json.dumps([sys.executable, "-m", "rooks_browser"]),
               PYTHONPATH=str(APP.parent) + os.pathsep + env.get("PYTHONPATH", ""))
    cmd = [str(ELECTRON), str(APP)]
    if hasattr(os, "geteuid") and os.geteuid() == 0:  # containers run tests as root; Chromium needs this there
        env["ROOKS_BROWSER_TEST_NO_SANDBOX"] = "1"
        cmd.append("--no-sandbox")
    if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
        cmd = [xvfb, "-a", *cmd]
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    try:
        for _ in range(300):
            if control_file.exists() and control_file.stat().st_size:
                break
            if proc.poll() is not None:
                pytest.fail("the app exited: " + proc.stderr.read().decode(errors="replace")[-2000:])
            time.sleep(0.1)
        else:
            pytest.fail("the app did not start in 30 seconds")
        c = json.loads(control_file.read_text())
        assert oct(control_file.stat().st_mode & 0o777) == "0o600"  # tokens are for this user only
        yield c
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)


def call(c, method, path, body=None, token=None, headers=None, base=None):
    req = urllib.request.Request((base or c["url"]) + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {}),
                                          **({"Authorization": f"Bearer {token if token is not None else c['token']}"} if token != "" else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def run(c, goal, script, approver=lambda a: False, **kw):
    model = ScriptedModel(script)
    asked = []
    s = Settings(provider="scripted", electron={"url": c["url"], "token": c["token"], "tab": c["tab"]}, **kw)
    res = asyncio.run(run_task(goal, s, approver=lambda a: asked.append(a) or approver(a), model=model))
    return res, model, asked, receipts.read(res.receipt)


def test_the_same_shop_task_as_chrome_works_in_our_own_browser(app, site):
    """test_e2e.py's first task, step for step, in a tab of the Rooks Browser app instead of Chrome."""
    script = [
        act("open", url=f"{site}/index.html"),
        click("link", "Browse all products"),
        click("link", "Blue Widget"),
        act("extract"),
        lambda p: look(p),  # same page as the step before: the person should see what Rooks just did
        click("button", "Buy now"),
        act("done", answer="Blue Widget costs $12.50; ordered (CS-1042); spec saved", success=True),
    ]
    seen = {}

    def look(p):
        seen["banner"] = call(app, "POST", "/tab/eval", {"fn": "() => (document.getElementById('__rooks_banner') || {}).textContent"})[1].get("result")
        return click("link", "Download spec sheet")(p)

    approvals = []
    res, model, asked, rows = run(app, "Buy one Blue Widget and save its spec sheet", script,
                                  approver=lambda a: approvals.append(a.category) or True)
    assert res.done and res.success and "$12.50" in res.final
    assert approvals == ["purchase"]  # buying asks first, exactly as in Chrome
    assert "Order confirmed" in model.prompts[-1]  # the purchase went through after the yes
    assert "Price: $12.50" in model.prompts[4]  # extract read the real page
    assert res.downloads and res.downloads[0]["path"].endswith("widget-spec.csv")
    assert "price_usd,12.50" in open(res.downloads[0]["path"]).read()
    pages = [r for r in rows if r["kind"] == "egress" and r["tool"] == "browser.page"]
    assert [r["args"].split("/", 3)[-1] for r in pages][:4] == ["index.html", "products.html", "widget.html", "order.html"]
    assert [r["outcome"] for r in rows if r["kind"] == "decision"] == ["approved"]
    turn = next(r for r in rows if r["kind"] == "turn")
    assert "engine=rooks-browser-app" in (turn.get("detail") or "")
    assert seen["banner"], "the page banner saying what Rooks is doing never appeared"


def test_a_denied_purchase_is_not_made_in_our_browser(app, site):
    script = [act("open", url=f"{site}/widget.html"), click("button", "Buy now"),
              act("done", answer="I did not buy it", success=False)]
    res, model, asked, rows = run(app, "Buy the Blue Widget", script, approver=lambda a: False)
    assert [a.category for a in asked] == ["purchase"]
    assert not any("Order confirmed" in p for p in model.prompts)
    st = call(app, "GET", "/agent/state")[1]
    assert not st["url"].endswith("order.html")


def test_the_browser_itself_enforces_the_site_rules(app, site):
    """Even a driver that skips the Python check cannot take the agent's tab somewhere the job does not allow."""
    assert call(app, "POST", "/agent/start", {"policy": {"allow": ["example.com"]}})[0] == 200
    code, r = call(app, "POST", "/tab/open", {"url": f"{site}/index.html"})
    assert code == 200 and "not on the allow list" in r.get("blocked", "")
    call(app, "POST", "/agent/end", {})
    assert call(app, "POST", "/agent/start", {"policy": {"deny": ["127.0.0.1"]}})[0] == 200
    call(app, "POST", "/tab/eval", {"fn": f"() => {{ location.href = '{site}/products.html'; }}"})
    time.sleep(1.5)
    st = call(app, "GET", "/agent/state")[1]
    assert any("deny list" in b["why"] for b in st["blocked"])  # a page script's own navigation is refused too
    assert not st["url"].endswith("products.html")
    call(app, "POST", "/agent/end", {})


def test_the_control_channel_refuses_pages_strangers_and_stopped_tasks(app, site):
    assert call(app, "GET", "/agent/state", token="")[0] == 401
    assert call(app, "GET", "/agent/state", token="x" * 64)[0] == 401
    assert call(app, "GET", "/agent/state", headers={"Origin": "https://evil.example"})[0] == 403  # a web page
    assert call(app, "POST", "/agent/start", {"policy": {}})[0] == 200
    assert call(app, "POST", "/agent/start", {"policy": {}})[0] == 409  # one task at a time
    assert call(app, "POST", "/tab/eval", {"tab": 999, "fn": "() => 1"})[0] == 403  # only the agent's own tab
    assert call(app, "POST", "/tab/eval", {"fn": "() => 1 + 1"}) == (200, {"result": 2})
    assert call(app, "POST", "/tab/eval", {"fn": "(() => { window.__x = 7; })();"})[0] == 200  # a script ending in ";" (OVERLAY)
    assert call(app, "POST", "/tab/eval", {"fn": "window.__x"}) == (200, {"result": 7})  # a plain expression
    call(app, "POST", "/agent/end", {})
    assert call(app, "POST", "/tab/eval", {"fn": "() => 1"})[0] == 409  # after the task, the tab is the person's again


def test_a_task_from_the_side_panel_runs_through_the_helper_and_keeps_the_token_private(app, site, tmp_path):
    assert not app.get("helper_error"), app.get("helper_error")
    script = tmp_path / "script.json"
    script.write_text(json.dumps([act("open", url=f"{site}/widget.html"), act("extract"),
                                  act("done", answer="The Blue Widget is $12.50", success=True)]))
    helper = {"url": app["helper"], "token": app["helper_token"]}
    code, job = call(helper, "POST", "/api/jobs", {"goal": "How much is the Blue Widget?", "provider": "scripted", "model": str(script),
                                                   "electron": {"url": app["url"], "token": app["token"], "tab": app["tab"]}})
    assert code == 200, job
    for _ in range(300):
        code, job = call(helper, "GET", f"/api/jobs/{job['id']}")
        if job["status"] in ("done", "error", "cancelled"):
            break
        time.sleep(0.1)
    assert job["status"] == "done", job
    assert "$12.50" in job["result"]["final"]
    assert app["token"] not in json.dumps(job)  # the browser's token is never in the job record
    listing = call(helper, "GET", "/api/jobs")[1]
    assert app["token"] not in json.dumps(listing)
    assert call(app, "GET", "/agent/state")[1]["url"].endswith("widget.html")  # it used the person's tab
