# 0005: Rooks Browser, our own browser

Status: first increment on branch `feat/browser-app` (2026-11-07). Not merged, not in the installers yet.

## 1. What the owner asked for

A browser of our own that people can use like Chrome, and hand a task to: "fully AI based", private ("like Onion Browser"), safe, autonomous yet friendly, with every integration possible. The owner left the technical choices to the implementer.

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Engine | Electron (Chromium), in `rooks-browser/app/` | A real, separate browser with the same engine as Chrome, on macOS, Windows and Linux. The operating system's own web views (WebKit, WebView2) cannot be driven the same way everywhere. A Chromium fork (how Opera, Comet and Arc are built) needs a build farm and a Chromium security merge every few weeks: rejected. |
| How the agent drives a tab | Through the app's own control channel: 127.0.0.1, random port, random token, requests carrying an `Origin` header (web pages) refused | Chromium's remote debugging port is never opened. Any program on the computer could connect to it and take over signed in tabs. |
| Which agent | The existing `rooks-browser` agent, unchanged. A second driver (`rooks_browser/electron.py`) gives it the same methods as the Chrome driver (`browser.py`) | One agent, one set of site rules, approvals and receipts (AGENTS.md parity rule; no second agent engine). |
| Where tasks run | The existing job server (`rooks-browser serve`), started by the app with its own random token | Its approvals already feed ROOKS's Needs you; the side panel reads the same job. |
| "Onion" | Privacy first, honestly scoped: private tabs that keep nothing, https first, permissions always asked, no telemetry, DuckDuckGo for searches typed in the address bar | Tor Browser's anonymity comes from its own anti fingerprinting patches, which a new Chromium browser does not have. Rooks Browser does not claim Tor level anonymity. Optional Tor routing is a later increment (section 6). |

No code, names or design were taken from Opera, Comet, Arc or Onion Browser.

## 3. Security model

1. Web pages run in sandboxed views with no Node, no preload and context isolation. Only the browser's own interface page has a preload, and it exposes a fixed list of calls (`app/ui/preload.js`).
2. Popups open as tabs; pages never get a second window. `<webview>` is refused. The interface page cannot navigate away from itself.
3. Camera, microphone, location, notifications, clipboard reading and screen capture are asked for every time (until the app closes), and always refused for a tab the agent is driving.
4. Plain `http` is upgraded to `https` for public sites; an address typed with `http://` on purpose is respected; local addresses are left alone. The address bar labels plain http "Not secure".
5. While the agent drives a tab, the app itself checks every request that tab makes against the job's site rules (`app/policy.js`, a port of `policy.py` checked against 125 answers from the Python code). Pages the agent opens get every rule; a page's own resources get the deny list, as in the Chrome driver.
6. Private tabs cannot be handed to a model.
7. The person can stop or take over at any time: the Stop button, Esc, typing in the address bar, or typing in the page. The agent's next call then fails with 409 and the run ends as cancelled.
8. The browser's control token is passed to the job only in its run settings, never stored in the job record that the job API lists.

## 4. Tests

| Test | What it proves |
| --- | --- |
| `rooks-browser/tests/test_electron_app.py` (5) | Real Electron under Xvfb. The same shop task as the Chrome end to end test, step for step: browse, extract, download, purchase asks first and goes through on yes; a denied purchase is not made; the in page banner shows what Rooks is doing; the app blocks an allow listed or denied site even when a page script navigates; the control channel refuses no token, a wrong token, a web page origin, another tab and a stopped task; a side panel style job through the helper finishes and the token is never in the job record. |
| `rooks-browser/app/test/policy.test.mjs` (3) | The site rules give the same verdict and the same reason as `policy.py` for 105 rule and address pairs and 20 hosts. |
| `rooks-browser/app/test/ui.test.mjs` (1) | The interface driven like a person: address bar, page titles, "Not secure", a private tab, the panel saying plainly when the task helper is missing, Stop taking the tab back, and typing in the address bar taking over. |

A mutation check: with the `Origin` guard removed, the control channel test fails.

Results on 2026-11-07, in a Linux container: the 5 Electron tests and 4 app tests pass. The full `rooks-browser` suite: 101 passed, 1 failed. The failure, `test_redaction_is_a_verbatim_copy_of_workbench`, fails the same way on `main` in CI.

### Bugs the tests caught while building it

1. Evaluating script in a tab that never loaded a document hangs. Every new tab now loads `about:blank`.
2. A script ending in `;` failed inside the eval wrapper, so the agent's "what I am doing" banner never appeared, and the driver swallowed the error. Fixed, with a test.
3. A page script returning nothing came back as `{}`, not `{"result": null}`.
4. The first port of the local address rule treated `fcbarcelona.com` as local. Rewritten to match Python exactly.

## 5. Not done, not proven

1. No real model ran a task in the app; tests use the scripted model.
2. Only Linux was tested. macOS and Windows have not been run.
3. The app is not in `install.sh`, the desktop installers, code signing or auto update. Electron security releases must be shipped promptly once it is: that is the main maintenance cost of owning a browser.
4. Tracker and ad blocking is not built. The common filter lists carry licence terms (GPL or CC BY-SA) that need a decision before they ship with a proprietary app.
5. "Ask about this page" runs as a short agent job limited to the page's own site. It is not yet a direct question and answer over the page text.
6. A person's mouse click in the page does not count as taking over yet; keys, Esc, the address bar and Stop do.
7. Downloads by URL in the Electron driver do not carry the tab's cookies (the Chrome driver's do).
8. Page resource rows in the receipt (one per host) are not reported by the app.

## 6. Next increments

1. Package the app in `install.sh` and the desktop release, with signing and auto update, and run the tests on macOS and Windows.
2. Tracker blocking, after the filter list licence decision.
3. Optional Tor routing: when the person has Tor running, a "Tor tab" sends its traffic through Tor's local SOCKS port in its own private session. The agent may read in a Tor tab but never signs in, buys or submits there.
4. Approvals from the app also appear in ROOKS's Needs you and on the phone, as other `rooks-browser` jobs already do.
5. A direct page question and answer using the app's model bridge.
EOF
echo ok