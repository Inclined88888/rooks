"""Run the actual interactive CLI through a PTY against a scripted local model."""
import os
import select
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from fakes import FakeModel, openai_reply


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTY")
def test_interactive_cli_accepts_input_streams_and_exits(project):
    import fcntl
    import pty
    import struct
    import termios

    model = FakeModel([openai_reply("PTY_REPLY_CONFIRMED")])
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", PROMPT_TOOLKIT_NO_CPR="1")
    env.pop("NO_COLOR", None)
    env.pop("ROOKS_PLAIN", None)
    installed = env.get("ROOKS_TEST_BIN")
    if installed:
        env.pop("PYTHONPATH", None)
        command = [installed]
    else:
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
        command = [sys.executable, "-m", "rooks_code"]
    command += ["-C", str(project), "--no-mcp", "-P", "openai-compatible", "--base-url", model.url, "-m", "fake-model"]
    process = None
    output = bytearray()

    def until(needle):
        deadline = time.monotonic() + 20
        while needle not in output and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
            elif process.poll() is not None:
                break
        assert needle in output, output.decode(errors="replace")

    try:
        process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        slave = None
        until("❯".encode())
        os.write(master, b"hello\r")
        until(b"PTY_REPLY_CONFIRMED")
        os.write(master, b"/exit\r")
        until(b"Bye.")
        assert process.wait(timeout=10) == 0
        assert len(model.requests) == 1
        assert model.requests[0]["body"].get("stream") is True
        assert b"Traceback" not in output
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        os.close(master)
        if slave is not None:
            os.close(slave)
        model.close()


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTY")
def test_the_real_terminal_is_calm_and_asks_needs_your_ok(project):
    """A change in the real terminal: one quiet header, the diff without a box, "Needs your OK" with Approve and Deny,
    and no emoji, spinner frames or rook glyph anywhere on the screen."""
    import fcntl
    import pty
    import re
    import struct
    import termios

    model = FakeModel([openai_reply("", [("edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a + b"})]),
                       openai_reply("CALM_DONE")])
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", PROMPT_TOOLKIT_NO_CPR="1", COLORTERM="truecolor",
               PYTHONPATH=str(Path(__file__).resolve().parents[1]))
    env.pop("NO_COLOR", None)
    env.pop("ROOKS_PLAIN", None)
    command = [sys.executable, "-m", "rooks_code", "-C", str(project), "--no-mcp", "-P", "openai-compatible",
               "--base-url", model.url, "-m", "fake-model"]
    output = bytearray()
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)

    def until(needle):
        deadline = time.monotonic() + 20
        while needle not in output and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
            elif process.poll() is not None:
                break
        assert needle in output, output.decode(errors="replace")

    try:
        until("❯".encode())
        os.write(master, b"fix add\r")
        until(b"Needs your OK")
        os.write(master, b"y\n")
        until(b"CALM_DONE")
        os.write(master, b"/exit\r")
        until(b"Bye.")
        assert process.wait(timeout=10) == 0
        text = output.decode(errors="replace")
        assert "Approve" in text and "Deny" in text and "Rooks" in text
        assert (project / "calc.py").read_text().endswith("a + b\n")
        assert not re.search("[⏺♜⠀-⣿✳-✸✻╭╮╰╯\U0001F300-\U0001FAFF]", text)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        os.close(master)
        model.close()
