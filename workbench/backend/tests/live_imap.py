"""A real IMAP server for tests: Dovecot on 127.0.0.1 with TLS, one mailbox, messages appended over IMAP.

This is a real protocol test of the app's mail code (TLS handshake, LOGIN, SELECT, UID SEARCH, FETCH), not a test of
any mail provider. It is skipped when Dovecot is not installed, or when the tests do not run as root (Dovecot's own
users must own the mail folder). Install on Debian or Ubuntu: apt-get install dovecot-imapd.
"""

from __future__ import annotations

import imaplib
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
from pathlib import Path

import pytest

USER, PASSWORD = "owner@example.com", "imap-test-pass"

CONF = """base_dir = {run}
protocols = imap
listen = 127.0.0.1
ssl = required
ssl_cert = <{root}/cert.pem
ssl_key = <{root}/key.pem
service imap-login {{
  inet_listener imap {{
    port = 0
  }}
  inet_listener imaps {{
    port = {port}
    ssl = yes
  }}
}}
service imap-urlauth-login {{
  inet_listener imap-urlauth {{
    port = 0
  }}
}}
passdb {{
  driver = passwd-file
  args = {root}/users
}}
userdb {{
  driver = static
  args = uid=dovecot gid=dovecot home={root}/mail/%n
}}
mail_location = maildir:~/Maildir
first_valid_uid = 1
default_internal_user = dovecot
default_login_user = dovenull
log_path = {root}/dovecot.log
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LiveImap:
    def __init__(self, root: Path, port: int):
        self.root, self.host, self.port = root, "127.0.0.1", port
        self.cafile = str(root / "cert.pem")

    def context(self) -> ssl.SSLContext:
        return ssl.create_default_context(cafile=self.cafile)

    def append(self, sender: str, subject: str, body: str, message_id: str) -> None:
        raw = (f"From: {sender}\r\nTo: {USER}\r\nSubject: {subject}\r\n"
               f"Date: {time.strftime('%a, %d %b %Y %H:%M:%S +0000', time.gmtime())}\r\n"
               f"Message-ID: {message_id}\r\n\r\n{body}\r\n").encode()
        m = imaplib.IMAP4_SSL(self.host, self.port, ssl_context=self.context())
        try:
            m.login(USER, PASSWORD)
            typ, _ = m.append("INBOX", None, imaplib.Time2Internaldate(time.time()), raw)
            assert typ == "OK"
        finally:
            m.logout()


@pytest.fixture
def live_imap():
    if not shutil.which("dovecot") or not shutil.which("openssl"):
        pytest.skip("Dovecot is not installed (apt-get install dovecot-imapd)")
    if os.geteuid() != 0:
        pytest.skip("The live IMAP test needs root to hand the mail folder to Dovecot's own user")
    root = Path(tempfile.mkdtemp(prefix="dv", dir="/tmp"))  # short: Dovecot's sockets live here (108 byte limit)
    os.chmod(root, 0o755)
    port = _free_port()
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(root / "key.pem"),
                    "-out", str(root / "cert.pem"), "-days", "1", "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], check=True, capture_output=True)
    (root / "users").write_text(f"{USER}:{{PLAIN}}{PASSWORD}\n")
    (root / "mail").mkdir()
    shutil.chown(root / "mail", "dovecot", "dovecot")
    for f in ("key.pem", "users"):
        os.chmod(root / f, 0o644)
    (root / "run").mkdir()
    conf = root / "dovecot.conf"
    conf.write_text(CONF.format(root=root, run=root / "run", port=port))
    # Dovecot forks a daemon that keeps inherited pipes open, so its output goes to a file, never to a pipe we wait on
    with open(root / "start.log", "wb") as out:
        subprocess.run(["dovecot", "-c", str(conf)], check=True, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        yield LiveImap(root, port)
    finally:
        subprocess.run(["dovecot", "-c", str(conf), "stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not os.environ.get("KEEP_IMAP"):  # KEEP_IMAP=1 leaves the folder and dovecot.log for debugging
            shutil.rmtree(root, ignore_errors=True)
