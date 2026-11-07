"""Writes app/test/policy_cases.json from the Python site rules, the reference app/policy.js must match.

    cd rooks-browser && python app/test/make_policy_cases.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from rooks_browser.policy import SitePolicy  # noqa: E402
from rooks_browser.receipts import is_local  # noqa: E402

HOSTS = ["fcbarcelona.com", "fd.example", "localhost", "printer.local", "svc.internal", "a.localhost", "intranet", "10.1.2.3",
         "172.20.0.1", "172.32.0.1", "8.8.8.8", "::1", "fd00::1", "fe80::1", "2001:4860::1", "100.64.0.1", "192.168.1.5",
         "169.254.1.1", "0.0.0.0", "example.com"]
POLICIES = [{}, {"allow": ["*.wikipedia.org"]}, {"allow": ["example.com"]}, {"deny": ["ads.example.com", "*.tracker.net"]},
            {"block_private": True}, {"allow": ["https://shop.example.com/x"]}, {"deny": ["*"]}]
URLS = ["https://en.wikipedia.org/wiki/X", "https://wikipedia.org/", "https://example.com/a", "https://sub.example.com/",
        "https://ads.example.com/p", "https://tracker.net/x", "https://a.tracker.net/x", "http://127.0.0.1:8000/", "file:///etc/passwd",
        "javascript:alert(1)", "about:blank", "data:text/html,hi", "https://shop.example.com/y", "ftp://example.com/f",
        "https://notexample.com/"]

out = {"is_local": {h: is_local(h) for h in HOSTS},
       "check": [[p, u, list(SitePolicy(**p).check(u))] for p in POLICIES for u in URLS]}
(Path(__file__).parent / "policy_cases.json").write_text(json.dumps(out))
print(f"{len(out['is_local'])} hosts, {len(out['check'])} rule checks")
