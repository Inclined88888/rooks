"""The Room's browser (design 0007, sections 1.1 to 1.4 and 1.7): a real Chromium, run by the app, seen only as a stream.

Where the engine comes from, first found wins (find_engine): the Room's own build in `<Room>/tools/browser/` (used only
once install_engine checked it against a SHA-256 and wrote `engine.json`), Playwright's Chromium (its cache, or
PLAYWRIGHT_BROWSERS_PATH; never its headless shell), a Chromium from the system's packages (never the Snap one: Snap
refuses a profile outside its own folder and will not start inside the Room's walls), then Google Chrome and Microsoft
Edge, used only as engines: headless, with the Room's own profile, so the person's own profile, sign-ins, extensions and
sync are never opened.

How it starts (launch_argv): `--headless=new` (no window on the person's screen; the picture is only the stream) and
`--remote-debugging-pipe` (the DevTools protocol over the child's fds 3 and 4: no port, so nothing else on this computer
can drive it). Never a debugging port, never without Chromium's own sandbox, never with web security or file access
loosened (check_flags refuses all four). The profile is `<Room home>/.room-browser/profile`; passwords are never saved
(sign-ins persist through cookies), the keychain is a mock one on macOS and a plain store on Linux, the disk cache is
100 MB. On Linux with bwrap, the browser runs behind it: the Room's home over the person's home path, an unprivileged id
inside (Chromium will not start as root without switching its sandbox off, which we never do), the engine bound
read-only at a fixed place when it lies under the person's home, no network when the Room is offline. Without bwrap
(macOS, or Linux without it) it runs as the person, in the Room's home, with no outer wall, and the app says so; an
offline Room's browser then goes through a proxy that answers nothing (a closed door, not a wall).

Session drives one running browser: tabs (eight at most, the person's and the assistant's together), the address bar's
rules (normalise, the same as rooks-browser's app/address.js), back, forward, reload, page text, screenshots, the live
stream (Page.startScreencast, only while someone watches), input, downloads into the Room's Downloads (a safe, unique
name; a download stops at 2 GB), popups as tabs, and the Rules every request goes through: a file outside the Room's
home and the app's own address fail. Open tabs are written to `.room-browser/tabs.json` on every change; the next start
reopens them and says why the browser had closed. Close asks the browser to close, then ends the process tree after
three seconds.

Nothing here imports the app. The pipe reader and the event handlers run in threads of their own, so a browser outlives
any one event loop, as the Room's terminals do.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from . import store

# --- words ------------------------------------------------------------------------------------------------------------------
OFF_WORDS = {
    "no_engine": "The Room has no browser yet.",
    "windows": "The Room's browser is not on Windows yet.",
    "helper": "The Room runs elsewhere, so its browser is not here.",
    "switched_off": "The Room's browser is switched off in Settings.",
}
FILE_OUTSIDE = "That file is outside the Room, so the Room's browser does not open it."
APP_ADDRESS = "The Room's browser does not open this app's own address."
TABS_FULL = "Eight tabs are open. Close one to open another."
TAB_SLEPT = "A tab was put to sleep to save memory."
TOO_BIG = "The browser used too much memory, so it closed. Your tabs are kept."
DOWNLOAD_CUT = "A download stopped at 2 GB."
RESTARTED = "The app restarted, so the browser closed. Your tabs and sign-ins are kept."
NOT_LOCKED = "Not locked off: this browser runs as you."
DID_NOT_START = "The Room's browser could not start."
CLOSED = "The Room's browser is closed."
NO_SUCH_TAB = "No such tab."

# --- limits and places ------------------------------------------------------------------------------------------------------
TAB_MAX = 8
MEMORY_SLEEP = 1536 * 1024 * 1024     # over this the least recently viewed background tab sleeps
MEMORY_CLOSE = 2560 * 1024 * 1024     # over this the browser closes, its tabs kept
DOWNLOAD_MAX = 2 * 1024 * 1024 * 1024
DISK_CACHE = 100 * 1024 * 1024
FRAME_MAX = (1920, 1200)
VIEW_DEFAULT = (1280, 800)
PAGE_TEXT_MAX = 8000
CLOSE_WAIT_S = 3.0
CALL_TIMEOUT_S = 15.0
DIR = ".room-browser"                  # in the Room's home: profile/, tabs.json, state.json
ENGINE_MOUNT = "/tmp/.room-browser-engine"  # where an engine under the person's home is bound, read-only, inside bwrap
CACHE_DIRS = ("Cache", "Code Cache", "GPUCache")  # left out of a saved point
HOME_PAGE = "about:blank"
FORBIDDEN_FLAGS = ("--remote-debugging-port", "--no-sandbox", "--disable-web-security",
                   "--allow-file-access-from-files")
# What the engine never inherits next to the secrets room_env drops: the person's desktop session, keyring and agents.
_SESSION_ENV = ("DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "SSH_AUTH_SOCK",
                "GNOME_KEYRING_CONTROL", "GPG_AGENT_INFO", "XDG_RUNTIME_DIR", "SESSION_MANAGER")


# --- where the engine comes from -----------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Engine:
    path: str
    kind: str   # "own" | "playwright" | "system" | "chrome" | "edge"


def is_snap(path: str) -> bool:
    """A Snap Chromium: its path is under /snap, or it is the small wrapper script that runs the snap."""
    real = os.path.realpath(path)
    if real.startswith("/snap/") or "/snap/" in path:
        return True
    try:
        if os.path.getsize(real) < 64 * 1024:
            with open(real, "rb") as f:
                head = f.read(4096)
            return head.startswith(b"#!") and b"snap" in head
    except OSError:
        return False
    return False


def _executable(path: Path | str | None) -> str | None:
    if not path:
        return None
    p = Path(path)
    return str(p) if p.is_file() and os.access(p, os.X_OK) else None


def _own(root: Path) -> str | None:
    """The Room's own build, only when install_engine checked it (engine.json names the binary inside the folder)."""
    folder = root / "tools" / "browser"
    try:
        meta = json.loads((folder / "engine.json").read_text())
    except (OSError, ValueError):
        return None
    rel = str((meta or {}).get("path") or "") if isinstance(meta, dict) else ""
    if not rel or rel.startswith("/") or ".." in Path(rel).parts:
        return None
    return _executable(folder / rel)


def _version(name: str) -> int:
    m = re.search(r"-(\d+)$", name)
    return int(m.group(1)) if m else -1


def _playwright(home: Path, env: dict, platform: str) -> str | None:
    caches = []
    custom = str(env.get("PLAYWRIGHT_BROWSERS_PATH") or "").strip()
    if custom and custom != "0":
        caches.append(Path(custom).expanduser())
    caches.append(home / "Library" / "Caches" / "ms-playwright" if platform == "darwin"
                  else home / ".cache" / "ms-playwright")
    for cache in caches:
        try:
            builds = sorted((p for p in cache.iterdir() if re.fullmatch(r"chromium-\d+", p.name)),
                            key=lambda p: _version(p.name), reverse=True)
        except OSError:
            continue
        for build in builds:
            if platform == "darwin":
                tails = ["chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
                         "chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
            else:
                tails = ["chrome-linux64/chrome", "chrome-linux/chrome"]
            for tail in tails:
                for hit in sorted(build.glob(tail)):
                    found = _executable(hit)
                    if found:
                        return found
    return None


_SYSTEM = {"linux": [("system", ("chromium", "chromium-browser")),
                     ("chrome", ("google-chrome", "google-chrome-stable")),
                     ("edge", ("microsoft-edge", "microsoft-edge-stable"))]}
_MAC_APPS = [("system", "/Applications/Chromium.app/Contents/MacOS/Chromium"),
             ("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
             ("edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")]


def find_engine(*, root: Path | None = None, home: Path | None = None, env: dict | None = None, which=None,
                platform: str | None = None) -> Engine | None:
    """The engine the Room's browser uses here, or None. Never the Snap Chromium."""
    platform = platform or sys.platform
    if platform == "win32":
        return None
    env = dict(os.environ) if env is None else env
    home = Path(home) if home is not None else Path.home()
    if which is None:
        from .drivers.shell import host_which as which
    own = _own(Path(root) if root is not None else store.root())
    if own:
        return Engine(own, "own")
    pw = _playwright(home, env, "darwin" if platform == "darwin" else "linux")
    if pw:
        return Engine(pw, "playwright")
    if platform == "darwin":
        for kind, app in _MAC_APPS:
            if _executable(app):
                return Engine(app, kind)
        return None
    for kind, names in _SYSTEM["linux"]:
        for name in names:
            hit = which(name)
            if hit and not is_snap(hit) and _executable(hit):
                return Engine(hit, kind)
    return None


def off_reason(engine: Engine | None, platform: str | None = None) -> str | None:
    """Why the Room has no browser here: "windows", "no_engine", or None."""
    if (platform or sys.platform) == "win32":
        return "windows"
    return None if engine else "no_engine"


def install_engine(archive: Path, expected_sha256: str, *, root: Path | None = None, inner: str) -> Path:
    """Unpack a downloaded engine into `<Room>/tools/browser/` only when its SHA-256 is the one kept in the code, and
    only when nothing in it reaches outside that folder. Returns the binary's path. Raises ValueError otherwise; nothing
    is left behind that find_engine would use."""
    archive = Path(archive)
    digest = hashlib.sha256()
    with archive.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != str(expected_sha256 or "").lower():
        raise ValueError("The download did not match, so it was not used.")
    folder = Path(root if root is not None else store.root()) / "tools" / "browser"
    staging = folder.with_name("browser.new")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        _unpack(archive, staging)
        binary = staging / inner
        if not _executable(binary):
            raise ValueError("The download has no browser in it, so it was not used.")
        (staging / "engine.json").write_text(json.dumps({"sha256": digest.hexdigest(), "path": inner}))
        shutil.rmtree(folder, ignore_errors=True)
        staging.rename(folder)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return folder / inner


def _unpack(archive: Path, dest: Path) -> None:
    root = dest.resolve()

    def inside(name: str) -> bool:
        target = (root / name).resolve()
        return target == root or root in target.parents

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                if not inside(info.filename):
                    raise ValueError("The download reaches outside its folder, so it was not used.")
            for info in z.infolist():
                z.extract(info, root)
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    os.chmod(root / info.filename, mode)
        return
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for m in members:
            if not inside(m.name) or m.isdev() or ((m.issym() or m.islnk()) and not inside(
                    os.path.join(os.path.dirname(m.name), m.linkname))):
                raise ValueError("The download reaches outside its folder, so it was not used.")
        if hasattr(tarfile, "data_filter"):
            tar.extractall(root, members=members, filter="data")
        else:
            tar.extractall(root, members=members)  # noqa: S202 - every member checked above


# --- how it starts --------------------------------------------------------------------------------------------------------------
def profile_dir(home: Path) -> Path:
    return Path(home) / DIR / "profile"


def chrome_flags(home: Path, platform: str | None = None) -> list[str]:
    """The engine's flags, with `home` the Room's home as the browser sees it."""
    platform = platform or sys.platform
    flags = ["--headless=new", "--remote-debugging-pipe", f"--user-data-dir={profile_dir(home)}",
             "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
             "--disable-component-update", "--disable-default-apps", "--disable-extensions", "--no-pings",
             "--deny-permission-prompts", f"--disk-cache-size={DISK_CACHE}",
             f"--window-size={VIEW_DEFAULT[0]},{VIEW_DEFAULT[1]}",
             "--disable-client-side-phishing-detection", "--disable-domain-reliability", "--disable-breakpad",
             "--disable-field-trial-config", "--metrics-recording-only", "--disable-search-engine-choice-screen",
             "--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,MediaRouter,"
             "OptimizationHints,Translate,DialMediaRouteProvider,InterestFeedContentSuggestions,"
             "CertificateTransparencyComponentUpdater"]
    flags.append("--use-mock-keychain" if platform == "darwin" else "--password-store=basic")
    return flags


OFFLINE_FLAGS = ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
                 "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]


def check_flags(argv: list[str]) -> None:
    """Refuse an argv with a debugging port, Chromium's sandbox off, web security off or file access loosened."""
    for a in argv:
        for bad in FORBIDDEN_FLAGS:
            if a == bad or a.startswith(bad + "="):
                raise ValueError(f"The Room's browser never starts with {bad}.")
    if "--remote-debugging-pipe" not in argv:
        raise ValueError("The Room's browser is driven only over its pipe.")


# Puts the two pipe ends at fds 3 (the browser reads) and 4 (the browser writes), then runs the rest. sh cannot name an
# fd above 9, and Popen's preexec_fn is not safe in a threaded server, so this small step does it.
_PIPE_STEP = ("import os,sys,fcntl\nr,w=int(sys.argv[1]),int(sys.argv[2])\n"
              "hr,hw=fcntl.fcntl(r,fcntl.F_DUPFD,10),fcntl.fcntl(w,fcntl.F_DUPFD,10)\n"
              "os.dup2(hr,3)\nos.dup2(hw,4)\n"
              "[os.close(f) for f in {r,w,hr,hw}-{3,4}]\nos.execv(sys.argv[3],sys.argv[3:])")


PIPE_STEP_FLAG = "--rooks-pipe-step"


def pipe_step(args: list[str]) -> None:
    """The same step for a packaged app, which has no Python to run `-c` with: its own program is started with
    PIPE_STEP_FLAG, r, w, then the command (desktop/sidecar/workbench_server.py hands it here first thing)."""
    import fcntl

    r, w = int(args[0]), int(args[1])
    hr, hw = fcntl.fcntl(r, fcntl.F_DUPFD, 10), fcntl.fcntl(w, fcntl.F_DUPFD, 10)
    os.dup2(hr, 3)
    os.dup2(hw, 4)
    for f in {r, w, hr, hw} - {3, 4}:
        os.close(f)
    os.execv(args[2], args[2:])


def _step(fds: tuple[int, int]) -> list[str]:
    """What runs the pipe step: Python with -c, or, inside the packaged app (sys.frozen), the app's own program."""
    if getattr(sys, "frozen", False):
        return [sys.executable, PIPE_STEP_FLAG, str(fds[0]), str(fds[1])]
    return [sys.executable, "-I", "-c", _PIPE_STEP, str(fds[0]), str(fds[1])]


def bwrap_path() -> str | None:
    """bwrap on this computer when it can give the browser a user namespace of its own (Linux only)."""
    if not sys.platform.startswith("linux"):
        return None
    from .drivers.shell import host_which

    path = host_which("bwrap")
    if not path:
        return None
    try:
        ok = subprocess.run([path, "--unshare-user", "--ro-bind", "/", "/", "true"], capture_output=True,
                            timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return None
    return path if ok else None


def launch_argv(engine: Engine, room_home: Path, *, person_home: Path | None = None, offline: bool = False,
                bwrap: str | None = None, uid: int | None = None, gid: int | None = None,
                fds: tuple[int, int]) -> tuple[list[str], Path]:
    """The argv that starts the engine with its pipe at fds 3 and 4, and the Room's home as the browser sees it."""
    room_home = Path(room_home)
    person_home = Path(person_home or Path.home())
    binary = os.path.realpath(engine.path) if os.path.exists(engine.path) else engine.path
    step = _step(fds)
    if not bwrap:
        # no wall to take the network away: an offline Room's browser is pointed at a proxy that answers nothing,
        # loopback included (the Room's proxy variables alone are not read by Chrome on macOS)
        argv = step + [binary, *chrome_flags(room_home), *(OFFLINE_FLAGS if offline else [])]
        check_flags(argv)
        return argv, room_home
    uid = os.getuid() if uid is None else uid
    gid = os.getgid() if gid is None else gid
    inside_uid = uid if uid else 1000  # Chromium refuses root without --no-sandbox: an ordinary id inside
    inside_gid = gid if gid else 1000
    wall = [bwrap, "--unshare-user", "--uid", str(inside_uid), "--gid", str(inside_gid), "--die-with-parent",
            "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    if offline:
        wall.append("--unshare-net")
    engine_dir = os.path.dirname(binary)
    under_home = engine_dir == str(person_home) or engine_dir.startswith(str(person_home).rstrip("/") + "/")
    if under_home:  # the home bind below hides it: bound read-only at a fixed place first
        wall += ["--ro-bind", engine_dir, ENGINE_MOUNT]
        binary = f"{ENGINE_MOUNT}/{os.path.basename(binary)}"
    wall += ["--bind", str(room_home), str(person_home), "--chdir", str(person_home),
             "--setenv", "HOME", str(person_home)]
    argv = step + wall + [binary, *chrome_flags(person_home)]
    check_flags(argv)
    return argv, person_home


def browser_env(home: Path, base: dict | None = None, offline: bool = False) -> dict:
    """The Room's environment (room_env: no secrets, no app names), HOME the Room's home as the browser sees it, and
    nothing of the person's desktop session, keyring or agents."""
    from .drivers.shell import room_env

    env = room_env(Path(home), offline, base=base)
    for name in _SESSION_ENV:
        env.pop(name, None)
    env["HOME"] = str(home)
    return env


# --- the address bar and what is refused -------------------------------------------------------------------------------------
def is_local(host: str) -> bool:
    """rooks-browser's is_local: loopback, private, link-local, *.local/.internal/.localhost, single labels."""
    h = (host or "").lower().strip("[]")
    if h == "localhost" or h.endswith((".local", ".internal", ".localhost")):
        return True
    try:
        ip = ipaddress.ip_address(h)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return "." not in h


_HOSTLIKE = (re.compile(r"^[\w-]+(\.[\w-]+)+(:\d+)?(/.*)?$"), re.compile(r"^localhost(:\d+)?(/.*)?$", re.I),
             re.compile(r"^\[[0-9a-f:.]+\](:\d+)?(/.*)?$", re.I))


def normalise(raw) -> str:
    """What the address bar makes of what was typed (rooks-browser's app/address.js): an address as it is, a site name
    (https first, plain http only for a computer on this network), or a search on DuckDuckGo."""
    s = str(raw or "").strip()
    if not s:
        return HOME_PAGE
    if re.match(r"^(https?|file|about|data):", s, re.I):
        return s
    if any(r.match(s) for r in _HOSTLIKE):
        host = urlsplit("http://" + s).hostname or ""
        return ("http://" if is_local(host) else "https://") + s
    return "https://duckduckgo.com/?q=" + quote(s, safe="-_.!~*'()")


def _own_addresses() -> set[str]:
    out = {"0.0.0.0", "::", "localhost"}
    try:
        name = socket.gethostname()
        out.add(name.lower())
        for a in socket.gethostbyname_ex(name)[2]:
            out.add(a)
    except OSError:
        pass
    return out


@dataclass
class Rules:
    """What every request of the Room's browser is checked against: a file outside the Room's home (as the browser
    sees it; `host_home` is where that folder really is, for links) and this app's own address fail."""
    home: Path
    app_ports: set = field(default_factory=set)
    host_home: Path | None = None
    _own: set | None = None

    def _file_inside(self, url: str) -> bool:
        path = unquote(urlsplit(url).path or "/")
        home = os.path.normpath(str(self.home))
        norm = os.path.normpath(path)
        if not (norm == home or norm.startswith(home.rstrip("/") + "/")):
            return False
        real_home = os.path.realpath(str(self.host_home or self.home))
        real = os.path.realpath(real_home + norm[len(home):])  # a link in the Room that leads outside is outside
        return real == real_home or real.startswith(real_home.rstrip("/") + "/")

    def _app(self, url: str) -> bool:
        if not self.app_ports:
            return False
        try:
            u = urlsplit(url)
            port = u.port or (443 if u.scheme in ("https", "wss") else 80)
        except ValueError:
            return False
        if port not in self.app_ports:
            return False
        # a name with a dot at the end (localhost., foo.localhost.) is the same name to Chromium's resolver
        host = (u.hostname or "").lower().strip("[]").rstrip(".")
        if host == "localhost" or host.endswith(".localhost"):
            return True
        try:
            ip = ipaddress.ip_address(host)
            if ip.is_loopback or ip.is_unspecified or (ip.version == 6 and ip.ipv4_mapped and ip.ipv4_mapped.is_loopback):
                return True
        except ValueError:
            pass
        if self._own is None:
            self._own = {a.rstrip(".") for a in _own_addresses()}
        return host in self._own

    def refused(self, url: str) -> str | None:
        scheme = (urlsplit(url).scheme or "").lower() if "://" in url or url.startswith("file:") else ""
        if scheme == "file":
            return None if self._file_inside(url) else FILE_OUTSIDE
        if scheme in ("http", "https", "ws", "wss") and self._app(url):
            return APP_ADDRESS
        return None

    def patterns(self) -> list[dict]:
        pats = [{"urlPattern": "file://*", "requestStage": "Request"}]
        for port in sorted(self.app_ports):
            pats.append({"urlPattern": f"*:{port}/*", "requestStage": "Request"})
            # Chromium writes an address on its scheme's own port without the port, so `*:80/*` never sees it
            for scheme in {80: ("http", "ws"), 443: ("https", "wss")}.get(port, ()):
                pats.append({"urlPattern": f"{scheme}://*", "requestStage": "Request"})
        return pats


# --- downloads -------------------------------------------------------------------------------------------------------------------
def safe_name(name: str) -> str:
    """rooks-browser's _safe: the last part of a name, only plain characters, never empty."""
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", Path(str(name or "").replace("\\", "/")).name).strip(" .") or "download"
    return name[:120]


def unique(path: Path) -> Path:
    """rooks-browser's _unique: `name (2).ext` when the name is taken."""
    path = Path(path)
    if not path.exists():
        return path
    for i in range(2, 1000):
        p = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not p.exists():
            return p
    return path.with_name(f"{path.stem} {uuid.uuid4().hex[:6]}{path.suffix}")


# --- the protocol over the pipe ------------------------------------------------------------------------------------------------
class ProtocolError(RuntimeError):
    pass


class Pipe:
    """The DevTools protocol over two pipe ends: JSON messages ending in a NUL byte. A reader thread resolves answers;
    events go to a second thread, so a handler may make calls of its own."""

    def __init__(self, rfd: int, wfd: int, on_event, on_close=None) -> None:
        self.rfd, self.wfd = rfd, wfd
        self.on_event, self.on_close = on_event, on_close
        self._id = 0
        self._wait: dict[int, list] = {}
        self._lock = threading.Lock()
        self._wlock = threading.Lock()
        self._events: queue.Queue = queue.Queue()
        self.closed = threading.Event()
        self._reader = threading.Thread(target=self._read, name="room-browser-pipe", daemon=True)
        self._worker = threading.Thread(target=self._dispatch, name="room-browser-events", daemon=True)
        self._reader.start()
        self._worker.start()

    def _read(self) -> None:
        buf = b""
        while True:
            try:
                data = os.read(self.rfd, 1 << 20)
            except OSError:
                data = b""
            if not data:
                break
            buf += data
            while b"\0" in buf:
                raw, buf = buf.split(b"\0", 1)
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if "id" in msg:
                    with self._lock:
                        slot = self._wait.pop(msg["id"], None)
                    if slot is not None:
                        slot[1] = msg
                        slot[0].set()
                elif "method" in msg:
                    self._events.put(msg)
        self.closed.set()
        with self._lock:
            waiting, self._wait = list(self._wait.values()), {}
        for slot in waiting:
            slot[0].set()
        self._events.put(None)

    def _dispatch(self) -> None:
        while True:
            msg = self._events.get()
            if msg is None:
                break
            try:
                self.on_event(msg.get("method"), msg.get("params") or {}, msg.get("sessionId"))
            except Exception:  # noqa: BLE001 - one bad handler never stops the browser
                pass
        if self.on_close:
            try:
                self.on_close()
            except Exception:  # noqa: BLE001
                pass

    def _write(self, msg: dict) -> int:
        with self._lock:
            self._id += 1
            mid = msg["id"] = self._id
        data = json.dumps(msg).encode() + b"\0"
        with self._wlock:
            while data:
                try:
                    data = data[os.write(self.wfd, data):]
                except OSError as e:
                    raise ProtocolError(CLOSED) from e
        return mid

    def send(self, method: str, params: dict | None = None, session: str | None = None) -> None:
        """A call whose answer nobody waits for (acks, continue a request)."""
        if self.closed.is_set():
            return
        msg = {"method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        try:
            self._write(msg)
        except ProtocolError:
            pass

    def call(self, method: str, params: dict | None = None, session: str | None = None,
             timeout: float = CALL_TIMEOUT_S) -> dict:
        if self.closed.is_set():
            raise ProtocolError(CLOSED)
        slot = [threading.Event(), None]
        msg = {"method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        with self._lock:
            self._id += 1
            mid = msg["id"] = self._id
            self._wait[mid] = slot
        data = json.dumps(msg).encode() + b"\0"
        try:
            with self._wlock:
                while data:
                    data = data[os.write(self.wfd, data):]
        except OSError as e:
            with self._lock:
                self._wait.pop(mid, None)
            raise ProtocolError(CLOSED) from e
        if not slot[0].wait(timeout):
            with self._lock:
                self._wait.pop(mid, None)
            raise ProtocolError(f"The browser did not answer {method}.")
        answer = slot[1]
        if answer is None:
            raise ProtocolError(CLOSED)
        if "error" in answer:
            raise ProtocolError(str((answer["error"] or {}).get("message") or "error")[:300])
        return answer.get("result") or {}

    def close(self) -> None:
        for fd in (self.wfd, self.rfd):
            try:
                os.close(fd)
            except OSError:
                pass


# --- the process tree --------------------------------------------------------------------------------------------------------------
def _tree(root_pid: int) -> list[int]:
    """root_pid and every process under it (Linux /proc; elsewhere ps)."""
    parents: dict[int, int] = {}
    if Path("/proc/self/stat").exists():
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            try:
                stat = Path(f"/proc/{d}/stat").read_text()
                parents[int(d)] = int(stat[stat.rindex(")") + 2:].split()[1])
            except (OSError, ValueError, IndexError):
                continue
    else:
        try:
            out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            out = ""
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                parents[int(parts[0])] = int(parts[1])
    found, todo = [root_pid], [root_pid]
    while todo:
        p = todo.pop()
        for child, parent in parents.items():
            if parent == p and child not in found:
                found.append(child)
                todo.append(child)
    return found


def tree_memory(root_pid: int) -> int:
    """Resident memory of the browser's process tree, in bytes."""
    total = 0
    pids = _tree(root_pid)
    if Path("/proc/self/status").exists():
        for pid in pids:
            try:
                for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                    if line.startswith("VmRSS:"):
                        total += int(line.split()[1]) * 1024
                        break
            except (OSError, ValueError):
                continue
        return total
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", ",".join(map(str, pids))], capture_output=True, text=True,
                             timeout=5).stdout
        total = sum(int(x) for x in out.split() if x.isdigit()) * 1024
    except (OSError, subprocess.SubprocessError):
        pass
    return total


def _kill_tree(proc: subprocess.Popen, known: list[int] | None = None) -> None:
    """End the browser's whole tree: its process group, every process found under it now, and the ones `known` from
    before it was asked to close (a helper process can outlive the browser's own pid for a moment). Waits, briefly,
    until they are gone, so the profile is free for the next start."""
    pids = list(dict.fromkeys([*_tree(proc.pid), *(known or [])]))
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    for pid in reversed(pids):
        if pid == os.getpid():
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and any(_running(p) for p in pids if p != proc.pid):
        time.sleep(0.05)


def _running(pid: int) -> bool:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rindex(")") + 2] != "Z"
    except (OSError, ValueError, IndexError):
        pass
    if Path("/proc/self/stat").exists():
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


# --- one running browser ---------------------------------------------------------------------------------------------------------
@dataclass
class Tab:
    id: str
    url: str = HOME_PAGE
    title: str = ""
    target: str | None = None       # the protocol's target id (None while asleep)
    session: str | None = None
    asleep: bool = False
    loading: bool = False
    blocked: str | None = None      # why the last main-frame load was refused
    viewed: float = 0.0
    loaded: threading.Event = field(default_factory=threading.Event)

    def row(self) -> dict:
        return {"id": self.id, "url": self.url, "title": self.title or _title_from(self.url), "asleep": self.asleep,
                "loading": self.loading, "blocked": self.blocked}


def _title_from(url: str) -> str:
    if not url or url == HOME_PAGE:
        return "New tab"
    u = urlsplit(url)
    return u.hostname or (Path(unquote(u.path)).name if u.scheme == "file" else url[:60])


def _quiet_url(url: str) -> str:
    """An address without its query or fragment, for anything written down."""
    try:
        u = urlsplit(url)
    except ValueError:
        return ""
    if u.scheme in ("data", "blob", "javascript"):
        return f"{u.scheme}:"
    return f"{u.scheme}://{u.netloc}{u.path}" if u.netloc or u.scheme == "file" else url.split("?")[0][:200]


class Session:
    """One running Room browser. Thread safe; every method blocks (the app calls it off its event loop)."""

    def __init__(self, engine: Engine, room_home: Path, *, offline: bool = False, app_ports=(),
                 person_home: Path | None = None, bwrap: str | None | bool = "auto", on_frame=None, on_change=None,
                 tab_max: int = TAB_MAX, memory_reader=None, run: str = "") -> None:
        self.engine = engine
        self.room_home = Path(room_home)
        self.offline = offline
        self.app_ports = set(app_ports or ())
        self.person_home = Path(person_home) if person_home else Path.home()
        self._bwrap = bwrap
        self.on_frame = on_frame          # (jpeg bytes, metadata) while someone watches
        self.on_change = on_change        # (what: str) state changed: tabs, url, title, note, closed
        self.tab_max = tab_max
        self.memory_reader = memory_reader or tree_memory
        self.run = run                     # which run of the app started it (state.json: a restart is told apart)
        self._closing = False
        self.walled = False
        self.inside_home = self.room_home
        self.proc: subprocess.Popen | None = None
        self.pipe: Pipe | None = None
        self.rules: Rules | None = None
        self.tabs: list[Tab] = []
        self.active: str | None = None
        self.view = VIEW_DEFAULT
        self.watching = False
        self.casting: str | None = None   # the tab whose screencast runs
        self._frame_edges: tuple[int, int] | None = None  # the window's size beyond its page area
        self.notes: list[str] = []
        self.closed_reason: str | None = None
        self.downloads: dict[str, dict] = {}
        self.lock = threading.RLock()
        self._create = threading.Lock()   # our own new tabs, so a popup is told from them
        self._ours: set[str] = set()
        self._stop = threading.Event()
        self._ready = threading.Event()   # set once start has closed the window headless opens with
        self._watchdog: threading.Thread | None = None
        self.started_at = 0.0

    # --- where things are ------------------------------------------------------------------------------------------------
    @property
    def dir(self) -> Path:
        return self.room_home / DIR

    @property
    def downloads_dir(self) -> Path:
        return self.room_home / "Downloads"

    # --- start and close -------------------------------------------------------------------------------------------------------
    def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            self.dir.chmod(0o700)
        except OSError:
            pass
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        _prefs(profile_dir(self.room_home))
        _drop_stale_locks(profile_dir(self.room_home))
        bwrap = bwrap_path() if self._bwrap == "auto" else (self._bwrap or None)
        to_r, to_w = os.pipe()
        fr_r, fr_w = os.pipe()
        for fd in (to_w, fr_r):
            os.set_inheritable(fd, False)  # portable; fcntl does not exist on Windows
        try:
            argv, inside = launch_argv(self.engine, self.room_home, person_home=self.person_home, offline=self.offline,
                                       bwrap=bwrap, fds=(to_r, fr_w))
            self.walled, self.inside_home = bool(bwrap), inside
            self.rules = Rules(home=inside, app_ports=self.app_ports, host_home=self.room_home)
            env = browser_env(inside, offline=self.offline)
            self.proc = subprocess.Popen(argv, pass_fds=(to_r, fr_w), stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         cwd=str(self.room_home), env=env, start_new_session=True)
        except BaseException:
            for fd in (to_r, to_w, fr_r, fr_w):
                try:
                    os.close(fd)
                except OSError:
                    pass
            raise
        os.close(to_r)
        os.close(fr_w)
        self.pipe = Pipe(fr_r, to_w, self._event, self._gone)
        self.started_at = time.monotonic()
        try:
            self.pipe.call("Browser.getVersion", timeout=30)
            self.pipe.call("Fetch.enable", {"patterns": self.rules.patterns()})
            self.pipe.call("Browser.setDownloadBehavior", {"behavior": "allowAndName", "eventsEnabled": True,
                                                            "downloadPath": str(inside / "Downloads")})
            self.pipe.call("Target.setDiscoverTargets", {"discover": True})
            for info in self.pipe.call("Target.getTargets").get("targetInfos") or []:
                if info.get("type") == "page":  # the window headless opens with: not a tab of ours
                    self.pipe.send("Target.closeTarget", {"targetId": info["targetId"]})
        except ProtocolError as e:
            self.close("did not start")
            raise RuntimeError(DID_NOT_START) from e
        self._ready.set()
        self._write_state(open_=True)
        self._watchdog = threading.Thread(target=self._watch, name="room-browser-memory", daemon=True)
        self._watchdog.start()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None and self.pipe is not None \
            and not self.pipe.closed.is_set() and self.closed_reason is None

    def close(self, reason: str = "closed") -> None:
        """Ask the browser to close, then end its process tree after three seconds. Tabs stay in tabs.json."""
        with self.lock:
            if self._closing:
                return
            self._closing = True
            if self.closed_reason is None:
                self.closed_reason = reason
            reason = self.closed_reason
        self._stop.set()
        pipe, proc = self.pipe, self.proc
        known = _tree(proc.pid) if proc is not None else []
        if pipe is not None and not pipe.closed.is_set():
            try:
                pipe.call("Browser.close", timeout=CLOSE_WAIT_S)
            except ProtocolError:
                pass
        if proc is not None:
            try:
                proc.wait(timeout=CLOSE_WAIT_S)
            except subprocess.TimeoutExpired:
                pass
            _kill_tree(proc, known)
        if pipe is not None:
            pipe.close()
        self._write_state(open_=False, reason=reason)
        self._changed("closed")

    def _gone(self) -> None:
        """The pipe closed: the browser exited (or was closed)."""
        with self.lock:
            crashed = not self._closing
            if self.closed_reason is None:
                self.closed_reason = "exited"
        if crashed:
            self._write_state(open_=False, reason="exited")
        for t in self.tabs:
            t.target = t.session = None
            t.loaded.set()
        self._changed("closed")

    # --- tabs ---------------------------------------------------------------------------------------------------------------
    def _need(self, tid: str | None) -> Tab:
        with self.lock:
            tid = tid or self.active
            for t in self.tabs:
                if t.id == tid:
                    return t
        raise KeyError(NO_SUCH_TAB)

    def tab(self, tid: str | None = None) -> Tab:
        return self._need(tid)

    def rows(self) -> list[dict]:
        with self.lock:
            return [t.row() for t in self.tabs]

    def _call(self, method: str, params: dict | None = None, session: str | None = None, **kw) -> dict:
        if not self.alive():
            raise ProtocolError(CLOSED)
        return self.pipe.call(method, params, session, **kw)

    def _attach(self, tab: Tab, target: str) -> None:
        session = self._call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        with self.lock:
            tab.target, tab.session, tab.asleep = target, session, False
        for method, params in (("Page.enable", {}), ("Page.setLifecycleEventsEnabled", {"enabled": False}),
                               ("Runtime.enable", {})):
            try:
                self._call(method, params, session)
            except ProtocolError:
                pass
        self._fit(tab)

    def _fit(self, tab: Tab) -> None:
        """Size the tab's window so its page area is the view: the stream shows the whole page area at its real size,
        and a click at (x, y) in a frame lands at (x, y) on the page."""
        if not tab.target or not self.alive():
            return
        try:
            win = self._call("Browser.getWindowForTarget", {"targetId": tab.target})["windowId"]
            if self._frame_edges is None and tab.session:
                got = self._call("Runtime.evaluate", {"expression": "[outerWidth - innerWidth, outerHeight - innerHeight]",
                                                      "returnByValue": True}, tab.session)
                v = (got.get("result") or {}).get("value") or [0, 0]
                self._frame_edges = (max(0, int(v[0])), max(0, int(v[1])))
            dw, dh = self._frame_edges or (0, 0)
            self._call("Browser.setWindowBounds", {"windowId": win, "bounds": {"width": self.view[0] + dw,
                                                                                 "height": self.view[1] + dh}})
        except (ProtocolError, KeyError, TypeError, ValueError):
            pass

    def new_tab(self, url: str | None = None, activate: bool = True) -> str:
        with self.lock:
            if len(self.tabs) >= self.tab_max:
                raise OverflowError(TABS_FULL)
            tab = Tab(id=uuid.uuid4().hex[:8], url=HOME_PAGE, viewed=time.monotonic())
            self.tabs.append(tab)
        try:
            with self._create:
                target = self._call("Target.createTarget", {"url": HOME_PAGE})["targetId"]
                self._ours.add(target)
            self._attach(tab, target)
        except BaseException:
            with self.lock:
                self.tabs = [t for t in self.tabs if t is not tab]
            raise
        if activate:
            self.switch(tab.id)
        if url and url != HOME_PAGE:
            self.navigate(tab.id, url)
        self._changed("tabs")
        return tab.id

    def close_tab(self, tid: str) -> None:
        tab = self._need(tid)
        with self.lock:
            idx = self.tabs.index(tab)
            self.tabs.remove(tab)
            if self.active == tab.id:
                self.active = None
                rest = self.tabs[min(idx, len(self.tabs) - 1)] if self.tabs else None
            else:
                rest = None
        if tab.target and self.alive():
            if self.casting == tab.id:
                self.casting = None
            self.pipe.send("Target.closeTarget", {"targetId": tab.target})
        if rest is not None:
            self.switch(rest.id)
        self._changed("tabs")

    def switch(self, tid: str) -> None:
        tab = self._need(tid)
        if tab.asleep:
            self._wake(tab)
        with self.lock:
            before, self.active = self.active, tab.id
            tab.viewed = time.monotonic()
        if tab.target and self.alive():
            self.pipe.send("Target.activateTarget", {"targetId": tab.target})
        if before != tab.id:
            self._recast()
        self._changed("tabs")

    def _wake(self, tab: Tab) -> None:
        with self._create:
            target = self._call("Target.createTarget", {"url": HOME_PAGE})["targetId"]
            self._ours.add(target)
        self._attach(tab, target)
        if tab.url and tab.url != HOME_PAGE:
            self.navigate(tab.id, tab.url)

    def sleep_tab(self, tid: str) -> None:
        """Close a tab's page and keep it as an address (memory)."""
        tab = self._need(tid)
        if tab.asleep or not tab.target:
            return
        target = tab.target
        with self.lock:
            tab.target = tab.session = None
            tab.asleep, tab.loading = True, False
            if self.casting == tab.id:
                self.casting = None
        if self.alive():
            self.pipe.send("Target.closeTarget", {"targetId": target})
        self._changed("tabs")

    # --- navigation -------------------------------------------------------------------------------------------------------------
    def navigate(self, tid: str | None, address: str, wait: bool = False, timeout: float = 20.0) -> dict:
        tab = self._need(tid)
        url = normalise(address)
        if tab.asleep:
            tab.url = url
            self._wake(tab)
            return {"url": url}
        refused = self.rules.refused(url) if self.rules else None
        with self.lock:
            tab.blocked = None
            tab.loaded.clear()
        if refused:  # said before anything is asked; the request rule would refuse it as well
            with self.lock:
                tab.blocked = refused
                tab.loaded.set()
            self._note(refused)
            self._changed("tabs")
            return {"url": url, "blocked": refused}
        out = self._call("Page.navigate", {"url": url}, tab.session)
        with self.lock:
            tab.loading = True
            if not out.get("errorText"):
                tab.url = url  # the address bar shows where it is going while it loads
        err = out.get("errorText")
        if err:
            with self.lock:
                tab.loading = False
                tab.loaded.set()
        elif wait:
            tab.loaded.wait(timeout)
        self._changed("tabs")
        return {"url": url, "error": err, "blocked": tab.blocked}

    def history(self, tid: str | None = None) -> dict:
        tab = self._need(tid)
        if not tab.session:
            return {"back": False, "forward": False}
        try:
            h = self._call("Page.getNavigationHistory", {}, tab.session, timeout=5)
        except ProtocolError:
            return {"back": False, "forward": False}
        i, n = int(h.get("currentIndex") or 0), len(h.get("entries") or [])
        return {"back": i > 0, "forward": i < n - 1, "index": i, "entries": h.get("entries") or []}

    def go(self, tid: str | None, step: int) -> bool:
        tab = self._need(tid)
        h = self.history(tab.id)
        entries, i = h.get("entries") or [], h.get("index", 0)
        j = i + step
        if not entries or not 0 <= j < len(entries):
            return False
        with self.lock:
            tab.loaded.clear()
            tab.blocked = None
        self._call("Page.navigateToHistoryEntry", {"entryId": entries[j]["id"]}, tab.session)
        return True

    def reload(self, tid: str | None = None) -> None:
        tab = self._need(tid)
        if tab.asleep:
            self._wake(tab)
            return
        self._call("Page.reload", {}, tab.session)

    def stop_loading(self, tid: str | None = None) -> None:
        tab = self._need(tid)
        if tab.session:
            self._call("Page.stopLoading", {}, tab.session)

    # --- reading the page --------------------------------------------------------------------------------------------------------
    def evaluate(self, tid: str | None, expression: str, timeout: float = 10.0):
        tab = self._need(tid)
        if not tab.session:
            raise ProtocolError("That tab is asleep. Open it first.")
        out = self._call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True},
                         tab.session, timeout=timeout)
        return (out.get("result") or {}).get("value")

    def page_text(self, tid: str | None = None, limit: int = PAGE_TEXT_MAX) -> str:
        text = self.evaluate(tid, "document.body ? document.body.innerText : ''") or ""
        return str(text)[:limit]

    def screenshot(self, tid: str | None = None, fmt: str = "png", quality: int = 80) -> bytes:
        tab = self._need(tid)
        if not tab.session:
            raise ProtocolError("That tab is asleep. Open it first.")
        params = {"format": fmt}
        if fmt == "jpeg":
            params["quality"] = quality
        out = self._call("Page.captureScreenshot", params, tab.session, timeout=20)
        return base64.b64decode(out.get("data") or "")

    # --- the live view -------------------------------------------------------------------------------------------------------------
    def watch(self, on: bool) -> None:
        with self.lock:
            self.watching = bool(on)
        self._recast()

    def _recast(self) -> None:
        with self.lock:
            want = self.active if self.watching else None
            was = self.casting
            tab = next((t for t in self.tabs if t.id == want), None) if want else None
            old = next((t for t in self.tabs if t.id == was), None) if was else None
        if was == want and (want is None or (tab and tab.session)):
            return
        if old is not None and old.session and self.alive():
            self.pipe.send("Page.stopScreencast", {}, old.session)
        self.casting = None
        if tab is not None and tab.session and self.alive():
            self.pipe.send("Page.startScreencast", {"format": "jpeg", "quality": 70, "maxWidth": self.view[0],
                                                    "maxHeight": self.view[1], "everyNthFrame": 1}, tab.session)
            self.casting = tab.id

    def resize(self, width: int, height: int) -> tuple[int, int]:
        w = max(200, min(int(width), FRAME_MAX[0]))
        h = max(150, min(int(height), FRAME_MAX[1]))
        with self.lock:
            self.view = (w, h)
            awake = [t for t in self.tabs if t.target]
        for t in awake:
            self._fit(t)
        with self.lock:
            casting = next((t for t in self.tabs if t.id == self.casting), None)
            self.casting = None
        if casting is not None and casting.session and self.alive():  # the stream restarts at the new size
            self.pipe.send("Page.stopScreencast", {}, casting.session)
        self._recast()
        return w, h

    # --- input -----------------------------------------------------------------------------------------------------------------------
    def _session(self) -> str:
        tab = self._need(None)
        if tab.asleep:
            self._wake(tab)
        if not tab.session:
            raise ProtocolError(CLOSED)
        return tab.session

    def mouse(self, kind: str, x: float, y: float, button: str = "left", clicks: int = 1, modifiers: int = 0) -> None:
        types = {"down": "mousePressed", "up": "mouseReleased", "move": "mouseMoved"}
        params = {"type": types.get(kind, "mouseMoved"), "x": float(x), "y": float(y), "modifiers": int(modifiers)}
        if kind in ("down", "up"):
            params.update(button=button if button in ("left", "right", "middle") else "left",
                          clickCount=max(1, min(int(clicks), 3)))
        self._call("Input.dispatchMouseEvent", params, self._session(), timeout=5)

    def click(self, x: float, y: float, button: str = "left", clicks: int = 1) -> None:
        self.mouse("move", x, y)
        self.mouse("down", x, y, button, clicks)
        self.mouse("up", x, y, button, clicks)

    def wheel(self, x: float, y: float, dx: float = 0, dy: float = 0) -> None:
        self._call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": float(x), "y": float(y),
                                                "deltaX": float(dx), "deltaY": float(dy)}, self._session(), timeout=5)

    def key(self, kind: str, key: str, code: str = "", text: str = "", key_code: int = 0, modifiers: int = 0) -> None:
        params = {"type": "keyDown" if kind == "down" else "keyUp", "key": str(key)[:32], "code": str(code)[:32],
                  "modifiers": int(modifiers)}
        if key_code:
            params["windowsVirtualKeyCode"] = params["nativeVirtualKeyCode"] = int(key_code)
        if kind == "down" and text and not (int(modifiers) & (2 | 4)):  # Ctrl or Meta: a shortcut, not a character
            params["text"] = params["unmodifiedText"] = str(text)[:8]
        elif kind == "down":
            params["type"] = "rawKeyDown"
        self._call("Input.dispatchKeyEvent", params, self._session(), timeout=5)

    def press(self, key: str) -> None:
        """One named key down and up (Enter, Tab, Backspace, Escape, arrows)."""
        codes = {"Enter": 13, "Tab": 9, "Backspace": 8, "Escape": 27, "ArrowLeft": 37, "ArrowUp": 38,
                 "ArrowRight": 39, "ArrowDown": 40, "Delete": 46, "PageUp": 33, "PageDown": 34, "Home": 36, "End": 35,
                 " ": 32}
        text = {"Enter": "\r", " ": " "}.get(key, "")
        self.key("down", key, code=key, text=text, key_code=codes.get(key, 0))
        self.key("up", key, code=key, key_code=codes.get(key, 0))

    def insert_text(self, text: str) -> None:
        self._call("Input.insertText", {"text": str(text)[:20000]}, self._session(), timeout=10)

    def selection(self) -> str:
        return str(self.evaluate(None, "String(window.getSelection ? window.getSelection() : '')") or "")

    # --- memory ------------------------------------------------------------------------------------------------------------------------
    def memory(self) -> int:
        return self.memory_reader(self.proc.pid) if self.proc is not None else 0

    def check_memory(self) -> str | None:
        """One memory step: "slept" (a background tab), "closed" (the whole browser) or None."""
        if not self.alive():
            return None
        used = self.memory()
        if used > MEMORY_CLOSE:
            self._note(TOO_BIG)
            self.close("memory")
            return "closed"
        if used > MEMORY_SLEEP:
            with self.lock:
                awake = [t for t in self.tabs if t.target and t.id != self.active]
            if awake:
                self.sleep_tab(min(awake, key=lambda t: t.viewed).id)
                self._note(TAB_SLEPT)
                return "slept"
        return None

    def _watch(self) -> None:
        while not self._stop.wait(10):
            try:
                self.check_memory()
            except Exception:  # noqa: BLE001
                pass

    # --- what the browser says -----------------------------------------------------------------------------------------------------
    def _tab_by(self, session: str | None = None, target: str | None = None) -> Tab | None:
        with self.lock:
            for t in self.tabs:
                if (session and t.session == session) or (target and t.target == target):
                    return t
        return None

    def _event(self, method: str, p: dict, session: str | None) -> None:
        if method == "Fetch.requestPaused":
            self._paused(p)
        elif method == "Page.screencastFrame":
            if session and self.pipe:
                self.pipe.send("Page.screencastFrameAck", {"sessionId": p.get("sessionId")}, session)
            tab = self._tab_by(session=session)
            if tab is not None and tab.id == self.casting and self.watching and self.on_frame:
                self.on_frame(base64.b64decode(p.get("data") or ""), p.get("metadata") or {})
        elif method == "Target.targetInfoChanged":
            info = p.get("targetInfo") or {}
            tab = self._tab_by(target=info.get("targetId"))
            if tab is not None and info.get("type") == "page":
                url, title = info.get("url") or tab.url, info.get("title") or ""
                if title and title == url.split("://", 1)[-1]:
                    title = ""  # the browser names a page with no title yet by its address: that is not a title
                with self.lock:
                    tab.url, tab.title = url, title
                self._changed("tabs")
        elif method == "Target.targetCreated":
            info = p.get("targetInfo") or {}
            if info.get("type") == "page" and info.get("openerId") and self._ready.is_set():
                # a popup (window.open, a link to a new window): a tab of its own, attached off this thread
                threading.Thread(target=self._popup, args=(info,), name="room-browser-popup", daemon=True).start()
        elif method == "Target.targetDestroyed":
            tab = self._tab_by(target=p.get("targetId"))
            if self._closing or self.closed_reason:  # the whole browser is closing: its tabs are kept
                return
            if tab is not None and not tab.asleep:  # the page closed itself (window.close)
                with self.lock:
                    if tab in self.tabs:
                        self.tabs.remove(tab)
                    if self.active == tab.id:
                        self.active = self.tabs[-1].id if self.tabs else None
                self._recast()
                self._changed("tabs")
        elif method == "Page.frameStartedLoading":
            tab = self._tab_by(session=session)
            if tab is not None and p.get("frameId") == tab.target:
                with self.lock:
                    tab.loading = True
                self._changed("tabs")
        elif method in ("Page.frameStoppedLoading", "Page.loadEventFired"):
            tab = self._tab_by(session=session)
            if tab is not None and (method == "Page.loadEventFired" or p.get("frameId") == tab.target):
                with self.lock:
                    tab.loading = False
                tab.loaded.set()
                self._changed("tabs")
                if tab is not None and method == "Page.loadEventFired":
                    # the browser's own title event does not always come (a form that posts and redirects): read it
                    threading.Thread(target=self._read_title, args=(tab,), name="room-browser-title", daemon=True).start()
        elif method == "Page.javascriptDialogOpening":
            if session and self.pipe:  # nobody can answer a dialog in a stream: alerts are accepted, the rest declined
                accept = p.get("type") in ("alert", "beforeunload")
                self.pipe.send("Page.handleJavaScriptDialog", {"accept": accept}, session)
        elif method == "Browser.downloadWillBegin":
            with self.lock:
                self.downloads[p.get("guid")] = {"name": safe_name(p.get("suggestedFilename") or ""),
                                                 "url": _quiet_url(p.get("url") or "")}
        elif method == "Browser.downloadProgress":
            self._download(p)

    def _paused(self, p: dict) -> None:
        req = p.get("request") or {}
        rid = p.get("requestId")
        refused = self.rules.refused(str(req.get("url") or "")) if self.rules else None
        if not refused:
            self.pipe.send("Fetch.continueRequest", {"requestId": rid})
            return
        self.pipe.send("Fetch.failRequest", {"requestId": rid, "errorReason": "BlockedByClient"})
        if p.get("resourceType") == "Document":
            tab = self._tab_by(target=p.get("frameId"))
            if tab is not None:
                with self.lock:
                    tab.blocked = refused
                self._note(refused)
                self._changed("tabs")

    def _read_title(self, tab: Tab) -> None:
        session = tab.session
        if not session or not self.alive():
            return
        try:
            got = self.pipe.call("Runtime.evaluate", {"expression": "document.title", "returnByValue": True}, session, timeout=5)
        except ProtocolError:
            return
        title = str((got.get("result") or {}).get("value") or "")
        if title and tab.session == session and title != tab.title:
            with self.lock:
                tab.title = title
            self._changed("tabs")

    def _popup(self, info: dict) -> None:
        target = info["targetId"]
        with self._create:  # waits for a tab of ours that is being made, so its id is known
            if target in self._ours or self._tab_by(target=target) is not None:
                return
            self._ours.add(target)
        with self.lock:
            full = len(self.tabs) >= self.tab_max
            tab = None if full else Tab(id=uuid.uuid4().hex[:8], url=info.get("url") or HOME_PAGE,
                                        viewed=time.monotonic())
            if tab:
                self.tabs.append(tab)
        if full:
            self.pipe.send("Target.closeTarget", {"targetId": target})
            self._note(TABS_FULL)
            return
        try:
            self._attach(tab, target)
        except ProtocolError:
            with self.lock:
                if tab in self.tabs:
                    self.tabs.remove(tab)
            return
        self.switch(tab.id)

    def _download(self, p: dict) -> None:
        guid = p.get("guid")
        state = p.get("state")
        received, total = int(p.get("receivedBytes") or 0), int(p.get("totalBytes") or 0)
        if state == "inProgress" and max(received, total) > DOWNLOAD_MAX:
            self.pipe.send("Browser.cancelDownload", {"guid": guid})
            self._note(DOWNLOAD_CUT)
            return
        if state not in ("completed", "canceled"):
            return
        with self.lock:
            meta = self.downloads.pop(guid, None) or {"name": "download"}
        raw = self.downloads_dir / str(guid)
        if state == "canceled":
            try:
                raw.unlink()
            except OSError:
                pass
            return
        dest = unique(self.downloads_dir / meta["name"])
        for _ in range(20):  # the file is renamed into place a moment after the event on some systems
            if raw.exists():
                break
            time.sleep(0.05)
        try:
            raw.rename(dest)
            meta["saved"] = dest.name
        except OSError:
            meta["saved"] = None
        with self.lock:
            self.notes.append(f"Downloaded {dest.name} to Downloads.")
        self._changed("download")

    # --- notes, state, tabs.json -----------------------------------------------------------------------------------------------------
    def _note(self, words: str) -> None:
        with self.lock:
            self.notes.append(words)
            del self.notes[:-20]
        self._changed("note")

    def take_notes(self) -> list[str]:
        with self.lock:
            out, self.notes = self.notes, []
        return out

    def _changed(self, what: str) -> None:
        if what in ("tabs", "closed"):
            self._save_tabs()
        if self.on_change:
            try:
                self.on_change(what)
            except Exception:  # noqa: BLE001
                pass

    def _save_tabs(self) -> None:
        with self.lock:
            rows = [{"url": t.url, "title": t.title} for t in self.tabs if t.url]
            active = next((i for i, t in enumerate(self.tabs) if t.id == self.active), 0)
        save_tabs(self.room_home, rows, active)

    def restore(self, saved: list[dict], active: int = 0) -> list[str]:
        """Reopen saved tabs: the one that was in front loads, the others wait asleep as addresses until opened."""
        names = []
        saved = [s for s in saved if isinstance(s, dict) and s.get("url")][: self.tab_max]
        for i, s in enumerate(saved):
            url = str(s["url"])
            if i == active:
                tid = self.new_tab(url)
            else:
                with self.lock:
                    tab = Tab(id=uuid.uuid4().hex[:8], url=url, title=str(s.get("title") or ""), asleep=True)
                    self.tabs.append(tab)
                    tid = tab.id
            names.append(str(s.get("title") or "") or _title_from(url))
        if saved and self.active is None:
            self.switch(self.tabs[0].id)
        self._changed("tabs")
        return names

    def _write_state(self, open_: bool, reason: str | None = None) -> None:
        write_state(self.room_home, {"open": open_, "closed": reason, "run": self.run, "at": time.time()})

    def set_app_ports(self, ports) -> None:
        """The app is reached on another port too: its requests are refused from now on."""
        ports = {int(p) for p in ports or () if p}
        if not ports - self.app_ports or not self.rules:
            return
        self.app_ports |= ports
        self.rules.app_ports = self.app_ports
        try:
            self._call("Fetch.enable", {"patterns": self.rules.patterns()})
        except ProtocolError:
            pass


def _prefs(profile: Path) -> None:
    """Passwords are never saved and never offered (sign-ins persist through cookies only)."""
    path = profile / "Default" / "Preferences"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        prefs = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(prefs, dict):
            prefs = {}
    except (OSError, ValueError):
        prefs = {}
    prefs["credentials_enable_service"] = False
    prefs.setdefault("profile", {})["password_manager_enabled"] = False
    prefs.setdefault("autofill", {}).update(profile_enabled=False, credit_card_enabled=False)
    try:
        path.write_text(json.dumps(prefs))
    except OSError:
        pass


def _drop_stale_locks(profile: Path) -> None:
    """A browser that was killed leaves its profile locked; nothing else uses the Room's profile, so the lock goes."""
    for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        p = profile / name
        try:
            if p.is_symlink() or p.exists():
                p.unlink()
        except OSError:
            pass


def save_tabs(room_home: Path, rows: list[dict], active: int = 0) -> None:
    folder = Path(room_home) / DIR
    try:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / "tabs.json.tmp"
        tmp.write_text(json.dumps({"tabs": rows, "active": active}))
        tmp.replace(folder / "tabs.json")
    except OSError:
        pass


def load_tabs(room_home: Path) -> tuple[list[dict], int]:
    try:
        data = json.loads((Path(room_home) / DIR / "tabs.json").read_text())
    except (OSError, ValueError):
        return [], 0
    if not isinstance(data, dict):
        return [], 0
    rows = [r for r in data.get("tabs") or [] if isinstance(r, dict) and isinstance(r.get("url"), str)]
    try:
        active = int(data.get("active") or 0)
    except (TypeError, ValueError):
        active = 0
    return rows[:TAB_MAX], max(0, min(active, max(0, len(rows) - 1)))


def write_state(room_home: Path, state: dict) -> None:
    folder = Path(room_home) / DIR
    try:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / "state.json.tmp"
        tmp.write_text(json.dumps(state))
        tmp.replace(folder / "state.json")
    except OSError:
        pass


def read_state(room_home: Path) -> dict:
    try:
        data = json.loads((Path(room_home) / DIR / "state.json").read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def closed_by_restart(room_home: Path, run: str = "") -> bool:
    """The browser was open when the app last stopped: closed by the app's exit, or never closed because the app was
    killed (state.json still says open, written by another run of the app than `run`)."""
    st = read_state(room_home)
    if st.get("closed") == "restart":
        return True
    return bool(st.get("open")) and (not run or st.get("run") != run)


def ignore_caches(home: Path):
    """For copytree: the browser's caches under `<home>/.room-browser` are left out of a saved point."""
    base = os.path.realpath(Path(home) / DIR)

    def ignore(folder: str, names: list[str]) -> set[str]:
        real = os.path.realpath(folder)
        if real == base or real.startswith(base + os.sep):
            return {n for n in names if n in CACHE_DIRS}
        return set()

    return ignore
