"""`ai-workspace`: the one launch command that install.sh / install.ps1 put on the PATH.

  ai-workspace              open Rooks: the Rooks app when it is installed and this version. Without one, a Chrome or
                            Edge window of its own or the usual browser, as the person chose (asked once; never a
                            window nobody chose)
  ai-workspace --shell window|browser   choose that, and remember it
  ai-workspace --web        this once, use a Chrome or Edge window (skip the Rooks app)
  ai-workspace --no-open    start the backend only and print the sign-in link (servers, testing)
  ai-workspace --stop       stop a copy started by this launcher
  ai-workspace --status     is it running, where, and which agents are linked
  ai-workspace --logs       where the logs are, and their last lines (paste these when reporting a problem)
  ai-workspace --update     update to the newest release on this install's channel (--check: only look)
  ai-workspace --update --channel edge|stable   switch channel (edge = every commit on main) and update

The window is Chrome or Edge in --app mode with its own profile: no tabs, no address bar, its own icon in the dock or
taskbar. Closing that window stops the backend. Data lives in the same folder the Rooks app uses (the identifier below,
not the name), so switching between them later keeps chats, keys and settings.

Standard library only; runs with the Python of the install's venv (~/.ai-workspace/venv).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import update as updates  # noqa: E402  (desktop/launcher/update.py)
ROOT = HERE.parent.parent  # the installed source tree (contains workbench/ and desktop/)
IDENT = "com.inclined88888.aiworkspace"  # desktop/src-tauri/tauri.conf.json identifier: same data folder as the native app
NAME = "Rooks"
OLD_NAMES = ("AI Workspace",)  # the app before it was called Rooks: still found, still opened
NO_APP = "There is no Rooks app for this computer yet."
QUESTION = f"{NO_APP} Open Rooks in a Chrome or Edge window, or in your usual browser?"
SHELLS = ("window", "browser")


def data_dir() -> Path:
    if os.environ.get("AI_WORKSPACE_DATA_DIR"):
        return Path(os.environ["AI_WORKSPACE_DATA_DIR"])
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / IDENT
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / IDENT
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / IDENT


def state_file() -> Path:
    return Path(os.environ.get("AI_WORKSPACE_HOME") or Path.home() / ".ai-workspace") / "launcher.json"


def install_file() -> Path:
    return Path(os.environ.get("AI_WORKSPACE_HOME") or Path.home() / ".ai-workspace") / "install.json"


def install_record() -> dict:
    try:
        d = json.loads(install_file().read_text())
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def shell_choice() -> str | None:
    """Where Rooks opens without a Rooks app, as the person answered: "window", "browser", or None (not asked yet)."""
    v = install_record().get("shell")
    return v if v in SHELLS else None


def save_shell_choice(choice: str) -> None:
    if choice not in SHELLS:
        raise ValueError(f"choose one of {', '.join(SHELLS)}")
    d = install_record()
    d["shell"] = choice
    f = install_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(d, indent=1))


def open_plan(native: list[str] | None, choice: str | None, interactive: bool, have_window: bool, web: bool) -> dict:
    """How this launch opens Rooks, and the line it says. `how`: native, window, browser, or ask (a question in the
    terminal first). `shell` goes to the page (?shell=...), which then says the same and offers the choice."""
    if web:
        if have_window:
            return {"how": "window", "say": "Opening Rooks in a Chrome or Edge window (--web)."}
        return {"how": "browser", "say": "There is no Chrome or Edge on this computer, so Rooks opens in your usual browser."}
    if native:
        return {"how": "native", "say": f"Opening the {NAME} app…"}
    if choice == "browser":
        return {"how": "browser", "say": f"{NO_APP} Opening Rooks in your usual browser. "
                                         "To use a window of its own: ai-workspace --shell window"}
    if choice == "window":
        if not have_window:
            return {"how": "browser", "say": f"{NO_APP} You chose a Chrome or Edge window, but there is no Chrome or Edge "
                                             "on this computer now, so Rooks opens in your usual browser."}
        return {"how": "window", "shell": "window",
                "say": f"{NO_APP} Opening Rooks in a Chrome or Edge window. To use your usual browser: ai-workspace --shell browser"}
    if not have_window:
        return {"how": "browser", "say": f"{NO_APP} There is no Chrome or Edge for a window of its own, so Rooks opens "
                                         "in your usual browser."}
    if interactive:
        return {"how": "ask", "say": QUESTION}
    # Started from the Dock, Finder or the Start menu: no terminal to ask in. Never a window nobody chose: the usual
    # browser opens, and the page asks.
    return {"how": "browser", "shell": "ask", "say": f"{NO_APP} Opening Rooks in your usual browser; it asks there "
                                                     "where to open next time."}


def ask_in_terminal() -> str:
    try:
        reply = input(f"{QUESTION}\n  1. A Chrome or Edge window of its own\n  2. My usual browser\nChoose 1 or 2 [1]: ")
    except EOFError:
        reply = ""
    return "browser" if reply.strip().lower() in ("2", "b", "browser", "usual") else "window"


def bundle_version(app: Path) -> str | None:
    """The version baked into a Mac app, or None when it cannot be read."""
    try:
        text = (app / "Contents" / "Info.plist").read_text(errors="replace")
    except OSError:
        return None
    m = re.search(r"<key>CFBundleShortVersionString</key>\s*<string>([^<]*)</string>", text)
    return m.group(1).strip() if m else None


def native_app() -> list[str] | None:
    """The installed native app, if any, as a command that opens it."""
    if os.environ.get("AI_WORKSPACE_NO_NATIVE") == "1":
        return None
    names = (NAME, *OLD_NAMES)
    if sys.platform == "darwin":
        for n in names:
            for d in (Path("/Applications"), Path.home() / "Applications"):
                app = d / f"{n}.app"
                # the real app (Tauri binary inside, mainBinaryName), not the shortcut to this launcher install.sh makes
                if (app / "Contents" / "MacOS" / "ai-workspace-desktop").exists():
                    return ["open", "-a", str(app)]
    elif sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        roots = [local, os.environ.get("PROGRAMFILES", ""), local + r"\Programs" if local else ""]
        for n in names:
            for r in filter(None, roots):
                for exe in ("ai-workspace-desktop.exe", f"{n}.exe"):
                    p = Path(r) / n / exe
                    if p.exists():
                        return [str(p)]
    else:
        bins = [Path.home() / ".ai-workspace" / "bin" / f"{n.replace(' ', '-')}.AppImage" for n in names]
        for p in (*bins, Path("/usr/bin/ai-workspace-desktop")):
            if p.exists() and os.access(p, os.X_OK):
                return [str(p)]
    return None


def installed_native() -> list[str] | None:
    """The desktop app to open, or None when the one on disk is an older download.

    An older app left in Applications keeps launching the unfixed version. This copy is what
    should open instead.
    """
    found = native_app()
    if not found:
        return None
    recorded = str(install_record().get("native") or "")
    if sys.platform == "darwin":
        app = Path(found[-1])
        have = bundle_version(app)
        want = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else ""
        if have and want and updates.parse_version(have) and updates.parse_version(want):
            if updates.newer(want, have):
                return None
            return found
    if recorded and recorded in found:
        return found
    return None


def window_browser() -> str | None:
    """Chrome, Edge or Chromium, for an app-mode window."""
    if os.environ.get("AI_WORKSPACE_BROWSER"):
        return os.environ["AI_WORKSPACE_BROWSER"]
    if sys.platform == "darwin":
        for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                  "/Applications/Chromium.app/Contents/MacOS/Chromium"):
            if Path(p).exists():
                return p
    elif sys.platform == "win32":
        for r in filter(None, (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA"))):
            for p in (r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"):
                if (Path(r) / p).exists():
                    return str(Path(r) / p)
    else:
        for n in ("google-chrome", "google-chrome-stable", "microsoft-edge", "chromium", "chromium-browser"):
            if shutil.which(n):
                return shutil.which(n)
    # Playwright's Chromium, installed for Rooks Browser when the computer has no Chrome or Edge
    cache = {"darwin": Path.home() / "Library" / "Caches" / "ms-playwright",
             "win32": Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"}.get(sys.platform, Path.home() / ".cache" / "ms-playwright")
    pats = {"darwin": "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
            "win32": "chromium-*/chrome-win*/chrome.exe"}.get(sys.platform, "chromium-*/chrome-linux*/chrome")
    found = sorted(cache.glob(pats)) if cache.exists() else []
    return str(found[-1]) if found else None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def healthy(url: str, timeout: float = 1.5) -> bool:
    try:
        urllib.request.urlopen(f"{url}/healthz", timeout=timeout).close()
        return True
    except OSError:
        return False


def read_state() -> dict:
    try:
        return json.loads(state_file().read_text())
    except (OSError, ValueError):
        return {}


def write_state(d: dict) -> None:
    f = state_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(d, fh)


def logs_dir() -> Path:
    return data_dir() / "logs"


_LOG: list = []


def say(msg: str, err: bool = False) -> None:
    """Print, and keep a copy in logs/launcher.log (a launcher started from the Dock or Finder has no terminal)."""
    print(msg, file=sys.stderr if err else sys.stdout, flush=True)
    try:
        if not _LOG:
            logs_dir().mkdir(parents=True, exist_ok=True)
            _LOG.append(open(logs_dir() / "launcher.log", "a", encoding="utf-8"))  # noqa: SIM115
        _LOG[0].write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
        _LOG[0].flush()
    except OSError:
        pass


def handoff_url(url: str, token: str, shell: str | None = None) -> str | None:
    """A one-time sign-in link (expires in two minutes) for the window. The launch token itself never goes on a
    command line, where other local users could read it (ps / Task Manager). `shell` (window or ask) tells the page
    it is not in the Rooks app, so it says so and offers the choice."""
    req = urllib.request.Request(f"{url}/api/desktop/handoff", method="POST", data=b"",
                                 headers={"Authorization": f"Bearer {token}", "X-Workbench": "1"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            link = f"{url}/api/desktop/handoff?code={json.load(r)['code']}"
            return link + (f"&shell={shell}" if shell in ("window", "ask") else "")
    except (OSError, ValueError, KeyError) as e:
        say(f"Could not get a sign-in link from the app at {url}: {e}", err=True)
        return None


def ui_ok(url: str) -> bool:
    """The web UI is there and complete: the page and every script and style it names. A copy with the page but
    without its hashed files opens as a blank window (every fresh install from main did, 2026-11-07), and --status
    used to call that "ok"."""
    try:
        with urllib.request.urlopen(f"{url}/", timeout=5) as r:
            html = r.read(20000).decode("utf-8", "replace")
        if '<div id="root"' not in html:
            return False
        for name in re.findall(r'(?:src|href)="(/assets/[^"?#]+)"', html):
            with urllib.request.urlopen(f"{url}{name}", timeout=5) as r:
                if r.status != 200 or not r.read(2):
                    return False
        return True
    except OSError:
        return False


def open_window(url: str, profile: Path, window: bool = True) -> subprocess.Popen | None:
    """A Chrome or Edge window of its own, or (window=False, or none found) the usual browser."""
    exe = window_browser() if window else None
    if exe:
        profile.mkdir(parents=True, exist_ok=True)
        args = [exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
                "--window-size=1280,860", f"--class={NAME}"]
        if os.environ.get("AI_WORKSPACE_WINDOW_ARGS"):
            args += os.environ["AI_WORKSPACE_WINDOW_ARGS"].split()
        try:
            return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass
    webbrowser.open(url)
    return None


def window_pid(profile: Path) -> int | None:
    """The pid of a Chrome/Edge app window still running on our profile (POSIX: its SingletonLock is host-pid)."""
    try:
        pid = int(os.readlink(profile / "SingletonLock").rsplit("-", 1)[1])
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError, IndexError):
        return None


def close_window(profile: Path) -> None:
    pid = None if sys.platform == "win32" else window_pid(profile)
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def stop(state: dict) -> bool:
    close_window(data_dir() / "window")
    pid = state.get("pid")
    if not pid:
        return False
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ai-workspace", description="Open Rooks.")
    p.add_argument("--web", action="store_true", help="this once, use a Chrome or Edge window even when the Rooks app is installed")
    p.add_argument("--shell", choices=SHELLS, help="without a Rooks app: open in a Chrome or Edge window, or the usual browser (saved)")
    p.add_argument("--no-open", action="store_true", help="start the backend only and print the sign-in link")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--stop", action="store_true")
    p.add_argument("--status", action="store_true")
    p.add_argument("--logs", action="store_true", help="show where the logs are and their last lines")
    p.add_argument("--version", action="store_true")
    p.add_argument("--update", action="store_true", help="update to the newest release on this install's channel")
    p.add_argument("--check", action="store_true", help="with --update: only report whether an update exists")
    p.add_argument("--channel", choices=updates.CHANNELS, help="with --update: stable (releases) or edge (main), saved")
    a = p.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)  # progress lines show up at once, even when piped to a log

    st = read_state()
    running = bool(st.get("url")) and healthy(st["url"])
    if a.version:
        print((ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "dev")
        return 0
    current = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "dev"
    if a.update or a.channel:
        if running and not a.check:
            say("Stopping the running copy first…")
            stop(st)
        return updates.run_update(current, a.channel, os.environ.get("AI_WORKSPACE_REPO") or updates.DEFAULT_REPO,
                                  check_only=a.check)
    if a.logs:
        print(f"logs: {logs_dir()}")
        for name in ("launcher.log", "workbench.log"):
            f = logs_dir() / name
            print(f"\n--- {f} (last 40 lines)")
            try:
                print("\n".join(f.read_text(errors="replace").splitlines()[-40:]) or "(empty)")
            except OSError:
                print("(not there yet)")
        return 0
    if a.status:
        print(f"app: {'running at ' + st['url'] if running else 'not running'}")
        if running:
            print(f"web UI: {'ok' if ui_ok(st['url']) else 'MISSING (the window would be blank; run the installer again)'}")
            print(f"backend pid: {st.get('pid')}")
        print(f"version: {(ROOT / 'VERSION').read_text().strip() if (ROOT / 'VERSION').exists() else 'dev'}")
        print(f"channel: {updates.get_channel()}")
        if updates.get_channel() == updates.CHANNEL_STABLE:
            res = updates.check(current)
            print(f"update: {'available, ' + res['latest'] + ' (ai-workspace --update)' if res['available'] else 'none'}")
        print(f"data: {data_dir()}")
        print(f"logs: {logs_dir()}  (ai-workspace --logs)")
        native = installed_native()
        print(f"Rooks app: {' '.join(native) if native else 'not installed'}")
        choice = shell_choice()
        how = ("the Rooks app" if native else {"window": "a Chrome or Edge window", "browser": "your usual browser"}.get(
            choice or "", "not chosen yet (asks the next time Rooks starts)"))
        print(f"opens in: {how}")
        for tool in ("rooks", "rooks-browser", "rooks-desk"):
            print(f"{tool}: {shutil.which(tool) or 'not on PATH'}")
        return 0
    if a.stop:
        ok = running and stop(st)
        print("stopped" if ok else "not running")
        return 0
    if a.shell:
        save_shell_choice(a.shell)
        say({"window": "Saved: without a Rooks app, Rooks opens in a Chrome or Edge window of its own.",
             "browser": "Saved: without a Rooks app, Rooks opens in your usual browser."}[a.shell])

    notice = updates.cached_notice(current)  # no network: the result of the last --status / --update check
    if notice:
        say(notice)
    native = None if (a.web or a.no_open) else installed_native()
    plan = open_plan(native, shell_choice(), sys.stdin.isatty() and sys.stdout.isatty(), bool(window_browser()), a.web)
    if plan["how"] == "native":
        say(plan["say"])
        subprocess.Popen(native)
        return 0
    if plan["how"] == "ask" and not a.no_open:
        choice = ask_in_terminal()
        save_shell_choice(choice)
        plan = open_plan(None, choice, True, bool(window_browser()), False)
    if not a.no_open:
        say(plan["say"])
    in_window = plan["how"] == "window"

    if running:  # one copy at a time: reopen its window with a fresh sign-in link
        say(f"{NAME} is already running at {st['url']}")
        if not a.no_open:
            link = handoff_url(st["url"], st.get("token", ""), plan.get("shell"))
            if not link:
                say("Run `ai-workspace --stop`, then `ai-workspace` again.", err=True)
                return 1
            open_window(link, data_dir() / "window", in_window)
        return 0

    dd = data_dir()
    dd.mkdir(parents=True, exist_ok=True)
    close_window(dd / "window")  # a window left over from a backend that is gone would swallow the new one
    logs = logs_dir()
    logs.mkdir(parents=True, exist_ok=True)
    port = a.port or free_port()
    token = secrets.token_urlsafe(32)
    url = f"http://127.0.0.1:{port}"
    # The page's answer to "window or usual browser?" is saved in install.json (POST /api/desktop/shell).
    env = {**os.environ, "WORKBENCH_DESKTOP_TOKEN": token, "AI_WORKSPACE_INSTALL_FILE": str(install_file())}
    log = open(logs / "workbench.log", "ab")  # noqa: SIM115
    server = [sys.executable, str(ROOT / "desktop" / "sidecar" / "workbench_server.py"), "--port", str(port), "--data-dir", str(dd),
              "--exit-with-parent"]
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    proc = subprocess.Popen(server, env=env, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    say(f"Starting {NAME} {(ROOT / 'VERSION').read_text().strip() if (ROOT / 'VERSION').exists() else ''} on port {port}…")
    deadline = time.monotonic() + 90
    while not healthy(url, 1):
        if proc.poll() is not None or time.monotonic() > deadline:
            say(f"{NAME} did not start. Last lines of {logs / 'workbench.log'}:", err=True)
            try:
                say("\n".join((logs / "workbench.log").read_text(errors="replace").splitlines()[-25:]), err=True)
            except OSError:
                pass
            proc.kill()
            return 1
        time.sleep(0.3)
    write_state({"url": url, "token": token, "pid": proc.pid})  # 0600: --status, a second `ai-workspace`, the agents
    say(f"{NAME} is running at {url}  (logs: {logs})")
    if not ui_ok(url):
        say(f"The web UI is missing from {ROOT / 'workbench' / 'frontend' / 'dist'}, so the window would be blank. "
            "Run the installer again.", err=True)
    rc = 0
    try:
        if a.no_open:
            print(f"Sign in (one-time link, valid 2 minutes): {handoff_url(url, token)}")
            print("Press Ctrl+C to stop.")
            proc.wait()
        else:
            started = time.monotonic()
            link = handoff_url(url, token, plan.get("shell"))
            if not link:
                raise KeyboardInterrupt
            win = open_window(link, dd / "window", in_window)
            if win:
                say("Close the window (or press Ctrl+C) to quit.")
                win.wait()
                if time.monotonic() - started < 5:  # handed off to a browser already running on this profile
                    say("Opened in the existing app window. Press Ctrl+C here to quit.")
                    proc.wait()
            else:
                say("Opened in your browser. Press Ctrl+C here to quit.")
                proc.wait()
    except KeyboardInterrupt:
        pass
    finally:
        if proc.poll() is None:
            proc.stdin.close()  # --exit-with-parent: the backend stops itself (and Rooks Browser) when stdin closes
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if read_state().get("pid") == proc.pid:
            state_file().unlink(missing_ok=True)
        say(f"{NAME} stopped.")
    return rc


if __name__ == "__main__":
    sys.exit(main())
