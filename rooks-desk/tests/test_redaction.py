"""Receipts must not keep private keys or AWS keys, and the redaction module must stay Workbench's own (R7)."""
import json
from pathlib import Path

from rooks_desk import receipts
from rooks_desk.redact import redact

REPO = Path(__file__).resolve().parents[2]

# Built at run time so secret scanners do not flag this file. AKIA...EXAMPLE is AWS's documented example id.
PEM = "-----BEGIN " + "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\nAAAAC2tleQ==\n-----END " + "OPENSSH PRIVATE KEY-----"
AWS = "AKIA" + "IOSFODNN7EXAMPLE"


def test_redaction_is_a_verbatim_copy_of_workbench():
    ours = (REPO / "rooks-desk/rooks_desk/redact.py").read_text().split("\n", 1)[1]
    assert ours == (REPO / "workbench/backend/app/redact.py").read_text()


def test_private_keys_and_aws_keys_are_redacted():
    out = redact(f"key:\n{PEM}\nid={AWS}")
    assert "PRIVATE KEY" not in out and "b3BlbnNzaC1rZXkt" not in out and AWS not in out
    assert "<redacted:private-key>" in out and "<redacted:aws-key>" in out


def test_receipt_rows_never_store_a_private_key_or_aws_key(tmp_path):
    log = receipts.RunLog(tmp_path)
    rid = log.add("tool_call", "ok", tool="run_command", args=f"echo {AWS}")
    log.finish(rid, "ok", evidence=PEM)
    text = log.path.read_text()
    assert AWS not in text and "PRIVATE KEY" not in text
    last = json.loads(text.splitlines()[-1])
    assert last["args"] == "echo <redacted:aws-key>" and last["evidence"] == "<redacted:private-key>"
