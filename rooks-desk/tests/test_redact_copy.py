"""rooks_desk/redact.py is the app's redaction, copied verbatim, so the desk hides the same secrets in its logs."""

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_redaction_is_a_verbatim_copy_of_workbench():
    ours = (REPO / "rooks-desk/rooks_desk/redact.py").read_text(encoding="utf-8").split("\n", 1)[1]
    assert ours == (REPO / "workbench/backend/app/redact.py").read_text(encoding="utf-8")


def test_private_keys_and_aws_ids_are_hidden():
    from rooks_desk import redact

    marker = "OPENSSH PRIVATE" + " KEY"  # built at run time so the secret scanner does not see a key in the source
    pem = f"-----BEGIN {marker}-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END {marker}-----"
    out = redact.redact(f"key {pem} id AKIA" + "A" * 16)
    assert "b3BlbnNzaC1rZXktdjEAAAAA" not in out and "AKIA" + "A" * 16 not in out
