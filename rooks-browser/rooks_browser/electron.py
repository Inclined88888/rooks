"""The Rooks Browser app as the agent's browser (docs/design/0005-rooks-browser-app.md).

The agent (agent.py) drives this exactly as it drives Chrome through Playwright (browser.py): the same methods, the same
site rules, the same receipts and approvals. The difference is where the tab lives. Here it is a tab in the person's own
Rooks Browser window, reached through that app's control channel (127.0.0.1, random port, random token). Chromium's
remote debugging port is never opened.

What the app enforces on its side, so a misbehaving agent cannot skip it: the job's site rules on every request the tab
makes (pages get every rule, page resources the deny list, as browser.py does), no camera, microphone, location or
notifications for the tab, and the person can stop or take over at any time. A stop ends the run as cancelled.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from . import page_js
from .browser import PolicyBlocked, Snapshot, _filename, _unique, normalise_url
from .policy import SitePolicy
from .receipts import RunLog


class _Page:
    """Enough of Playwright's Page for the helpers that take one (search.page_results)."""

    def __init__(self, browser: "ElectronBrowser"):
        self._b = browser
        self.url = ""

    async def evaluate(self, js: str, arg=None):
        return await self._b._eval(js, arg)


class ElectronBrowser:
    def __init__(self, *, policy: SitePolicy, log: RunLog, control: dict, downloads: Path | None = None, overlay: bool = True):
        self.policy, self.log = policy, log
        self.url = str(control["url"]).rstrip("/")
        self.token = str(control["token"])
        self.tab = control.get("tab")
        self.job = control.get("job")
        if urlsplit(self.url).hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("the browser's control channel must be on this computer")
        self.downloads = Path(downloads or Path.cwd() / "downloads")
        self.overlay = overlay
        self.engine_used = "rooks-browser-app"
        self.parent: int | None = None
        self.blocked: list[tuple[str, str]] = []
        self.saved: list[dict] = []
        self.page = _Page(self)
        self._navs_seen = 0
        self._blocked_seen = 0
        self._downloads_seen = 0
        self._shown: tuple | None = None

    # the control channel -------------------------------------------------------------------------------------------
    def _call_sync(self, method: str, path: str, body: dict | None = None, timeout: float = 60) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - loopback only, checked in __init__
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read() or b"{}").get("detail", "")
            except ValueError:
                pass
            if e.code == 409:  # the person stopped the task or took over
                raise asyncio.CancelledError(detail or "stopped") from None
            raise RuntimeError(detail or f"browser control: HTTP {e.code}") from None

    async def _call(self, method: str, path: str, body: dict | None = None, timeout: float = 60) -> dict:
        out = await asyncio.to_thread(self._call_sync, method, path, body, timeout)
        return out

    async def _eval(self, fn: str, arg=None):
        return (await self._call("POST", "/tab/eval", {"tab": self.tab, "fn": fn, "arg": arg})).get("result")  # undefined: no key

    async def _sync(self) -> dict:
        """Bring the receipt up to date with what the tab did: pages visited, pages blocked, files saved."""
        st = await self._call("GET", "/agent/state")
        self.page.url = st.get("url") or ""  # empty while the app shows its own "could not open" page
        # Pages visited and pages blocked, in the order they happened (the app numbers them), so a blocked page is a
        # blocked row and nothing else: the app's own "could not open" page is never a visited page.
        new = [("nav", n) for n in st.get("navs", [])[self._navs_seen:]] + [("blocked", b) for b in st.get("blocked", [])[self._blocked_seen:]]
        for kind, row in sorted(new, key=lambda kr: int(kr[1].get("seq") or 0)):
            if kind == "nav":
                code = int(row.get("status") or 0)
                self.log.egress("GET", row["url"], "ok" if code < 400 else f"http_{code}", 0, self.parent, tool="page")
            else:
                self.blocked.append((row["url"], row["why"]))
                self.log.egress(row.get("method") or "GET", row["url"], "blocked", 0, self.parent, tool="page", error=row["why"])
        self._navs_seen = len(st.get("navs", []))
        self._blocked_seen = len(st.get("blocked", []))
        downloads = st.get("downloads", [])
        for d in downloads[self._downloads_seen:]:
            if not d.get("done"):
                break
            self._downloads_seen += 1
            if d.get("error"):
                self.saved.append({"path": "", "bytes": 0, "error": d["error"]})
            else:
                self.log.egress("GET", self.page.url, "ok", 0, self.parent, tool="download", detail=f"saved {Path(d['path']).name}")
                self.saved.append({"path": d["path"], "bytes": d.get("bytes", 0)})
        return st

    # lifecycle -----------------------------------------------------------------------------------------------------
    async def start(self) -> "ElectronBrowser":
        r = await self._call("POST", "/agent/start", {"tab": self.tab, "job": self.job, "downloads": str(self.downloads),
                                                      "policy": {"allow": self.policy.allow, "deny": self.policy.deny,
                                                                 "block_private": self.policy.block_private}})
        self.tab = r["tab"]
        await self._sync()
        return self

    async def close(self) -> None:
        try:
            await self._call("POST", "/agent/end", {}, timeout=10)
        except BaseException:  # noqa: BLE001 - the app may already be gone
            pass

    async def __aenter__(self):
        return await self.start()

    async def __aexit__(self, *exc):
        await self.close()

    def flush(self) -> None:
        """Chrome's driver adds one row per host for page resources; the app does not report those yet."""

    # reading the page ----------------------------------------------------------------------------------------------
    async def _settle(self) -> None:
        await self._call("POST", "/tab/wait", {"tab": self.tab, "ms": 8000})
        await self._sync()

    async def snapshot(self, max_elements: int = 120) -> Snapshot:
        last = None
        for _ in range(3):
            try:
                await self._call("POST", "/tab/wait", {"tab": self.tab, "ms": 10000})
                d = await self._eval(page_js.SNAPSHOT, max_elements)
                st = await self._sync()
                return Snapshot(**d, tabs=int(st.get("tabs") or 1))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - navigation in flight: wait and retry
                last = e
                await asyncio.sleep(0.7)
        raise RuntimeError(f"could not read the page: {str(last).splitlines()[0] if last else 'no answer'}")

    async def screenshot(self, path: Path | None = None, full_page: bool = False, for_model: bool = False) -> bytes:
        if for_model and self.overlay:
            await self._overlay_call("hide")
        try:
            data = base64.b64decode((await self._call("POST", "/tab/screenshot", {"tab": self.tab, "jpeg": for_model}))["data"])
        finally:
            if for_model and self.overlay and self._shown:
                await self._overlay_call("show", *self._shown)
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return data

    async def screenshot_b64(self) -> str:
        return base64.b64encode(await self.screenshot(for_model=True)).decode()

    async def show(self, text: str, eid=None) -> None:
        self._shown = (text, eid)
        if self.overlay:
            await self._overlay_call("show", text, eid)

    async def _overlay_call(self, fn: str, *args) -> None:
        try:
            await self._eval(page_js.OVERLAY)  # pages navigate away; inject again (it is a no-op when present)
            await self._eval(f"(a) => window.__rooks && window.__rooks.{fn}(...a)", list(args))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the overlay is only a courtesy
            pass

    # actions -------------------------------------------------------------------------------------------------------
    async def open(self, url: str) -> str:
        url = normalise_url(url)
        ok, why = self.policy.check(url)
        if not ok:
            self.blocked.append((url, why))
            self.log.egress("GET", url, "blocked", 0, self.parent, tool="page", error=why)
            raise PolicyBlocked(why)
        before = len(self.saved)
        r = await self._call("POST", "/tab/open", {"tab": self.tab, "url": url})
        await self._sync()
        if r.get("blocked"):
            raise PolicyBlocked(r["blocked"])
        if len(self.saved) > before or (r.get("error") and "download" in r["error"].lower()):
            return "that URL is a file download; use the download action"
        if r.get("error"):
            raise RuntimeError(r["error"])
        status = int(r.get("status") or 0)
        return f"opened {r.get('url') or url}" + (f" (HTTP {status})" if status >= 400 else "")

    async def _center(self, eid) -> tuple[float, float]:
        i = int(str(eid).strip("[] "))
        pt = await self._eval("""(i) => {
          const el = document.querySelector(`[data-rb-id="${i}"]`);
          if (!el) return null;
          el.scrollIntoView({block: 'center', inline: 'center'});
          const r = el.getBoundingClientRect();
          return [r.left + r.width / 2, r.top + r.height / 2];
        }""", i)
        if not pt:
            raise RuntimeError(f"element [{i}] is not on the page any more; take a fresh look")
        return pt[0], pt[1]

    async def click(self, eid) -> str:
        await self._sync()
        before, n = self.page.url, len(self.blocked)
        x, y = await self._center(eid)
        await self._call("POST", "/tab/click", {"tab": self.tab, "x": x, "y": y})
        await self._settle()
        if len(self.blocked) > n:
            await self._leave_error_page(before)
            return f"clicked, but the page it leads to was blocked: {self.blocked[-1][1]}. Still at {self.page.url}"
        return "clicked" + (f", now at {self.page.url}" if self.page.url != before else "")

    async def _leave_error_page(self, before: str) -> None:
        if self.page.url != before:
            await self._call("POST", "/tab/back", {"tab": self.tab})
            await self._sync()
            if self.page.url != before and before:
                await self._call("POST", "/tab/open", {"tab": self.tab, "url": before})
                await self._sync()

    async def type(self, eid, text: str, submit: bool = False, clear: bool = True) -> str:
        x, y = await self._center(eid)
        await self._call("POST", "/tab/click", {"tab": self.tab, "x": x, "y": y})  # focus it the way a person would
        await self._eval("""([i, clear]) => {
          const el = document.querySelector(`[data-rb-id="${i}"]`);
          if (!el) return false;
          el.focus();
          if (clear) {
            if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', {bubbles: true})); }
            else if (el.isContentEditable) { el.textContent = ''; }
          }
          return true;
        }""", [int(str(eid).strip("[] ")), bool(clear)])
        await self._call("POST", "/tab/insert", {"tab": self.tab, "text": str(text)})
        if submit:
            before, n = self.page.url, len(self.blocked)
            await self._call("POST", "/tab/key", {"tab": self.tab, "key": "Enter"})
            await self._settle()
            if len(self.blocked) > n:
                await self._leave_error_page(before)
                return f"typed, but submitting was blocked: {self.blocked[-1][1]}"
            return f"typed and pressed Enter, now at {self.page.url}"
        return "typed"

    async def select(self, eid, value: str) -> str:
        ok = await self._eval("""([i, v]) => {
          const el = document.querySelector(`[data-rb-id="${i}"]`);
          if (!el || !el.options) return false;
          const opt = [...el.options].find(o => o.label.trim() === v || o.text.trim() === v) || [...el.options].find(o => o.value === v);
          if (!opt) return false;
          el.value = opt.value;
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
          return true;
        }""", [int(str(eid).strip("[] ")), str(value)])
        if not ok:
            raise RuntimeError(f"no option {value!r} in that list")
        await self._settle()
        return f"selected {value!r}"

    async def scroll(self, direction: str = "down") -> str:
        d = (direction or "down").lower()
        js = {"up": "window.scrollBy(0, -window.innerHeight * 0.8)", "top": "window.scrollTo(0, 0)",
              "bottom": "window.scrollTo(0, document.documentElement.scrollHeight)"}.get(d, "window.scrollBy(0, window.innerHeight * 0.8)")
        await self._eval(js)
        await asyncio.sleep(0.3)
        return f"scrolled {d}"

    async def back(self) -> str:
        await self._call("POST", "/tab/back", {"tab": self.tab})
        await self._sync()
        return f"went back to {self.page.url}"

    async def extract(self, max_chars: int = 8000) -> str:
        snap = await self.snapshot()
        return snap.text.strip()[:max_chars]

    async def download(self, eid=None, url: str | None = None) -> dict:
        self.downloads.mkdir(parents=True, exist_ok=True)
        if url:
            url = normalise_url(url, base=self.page.url)
            ok, why = self.policy.check(url)
            if not ok:
                self.log.egress("GET", url, "blocked", 0, self.parent, tool="download", error=why)
                raise PolicyBlocked(why)
            started = time.monotonic()

            def fetch():
                with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 - checked against the site rules above
                    return r.headers.get("content-disposition", ""), r.read()

            disposition, body = await asyncio.to_thread(fetch)
            self.log.egress("GET", url, "ok", int((time.monotonic() - started) * 1000), self.parent, tool="download")
            path = _unique(self.downloads / _filename(disposition, url))
            path.write_bytes(body)
            self.saved.append({"path": str(path), "bytes": path.stat().st_size})
            return self.saved[-1]
        n = len(self.saved)
        x, y = await self._center(eid)
        await self._call("POST", "/tab/click", {"tab": self.tab, "x": x, "y": y})
        for _ in range(600):
            await self._sync()
            if len(self.saved) > n:
                d = self.saved[-1]
                if d.get("error"):
                    raise RuntimeError(f"download failed: {d['error']}")
                return d
            await asyncio.sleep(0.1)
        raise RuntimeError("clicking that did not start a download within 60 seconds")
