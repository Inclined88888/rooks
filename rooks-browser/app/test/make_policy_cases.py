"""Writes app/test/policy_cases.json from the Python site rules, the reference app/policy.js must match.

    cd rooks-browser && python app/test/make_policy_cases.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from rooks_browser.policy import SitePolicy, _match  # noqa: E402
from rooks_browser.receipts import is_local  # noqa: E402

HOSTS = ["fcbarcelona.com", "fd.example", "localhost", "printer.local", "svc.internal", "a.localhost", "intranet", "10.1.2.3",
         "172.20.0.1", "172.32.0.1", "8.8.8.8", "::1", "fd00::1", "fe80::1", "2001:4860::1", "100.64.0.1", "192.168.1.5",
         "169.254.1.1", "0.0.0.0", "example.com",
         # the rest of Python's ipaddress private ranges (IANA special purpose), and its exceptions to them
         "198.18.0.1", "240.0.0.1", "192.0.2.1", "192.0.0.1", "192.0.0.9", "192.0.0.10", "192.0.0.170", "203.0.113.5", "198.51.100.1",
         "255.255.255.255", "100::1", "100:0:0:1::1", "2001:db8::1", "2002:c0a8:101::1", "2001::1", "2001:1::1", "2001:2::1",
         "2001:3::1", "2001:4:112::1", "2001:10::1", "2001:20::1", "2001:30::1", "2001:40::1", "::ffff:8.8.8.8", "::ffff:10.0.0.1",
         "64:ff9b::1", "64:ff9b:1::1", "fec0::1", "::2", "1::", "::", "fe80::1%eth0"]
# fnmatch's character classes, which hosts never need but the two sides must still read alike
PATTERNS = [("a.com", "[a].com"), ("[a].com", "[a].com"), ("a.com", "a[.]com"), ("ab.com", "a[!b].com"), ("ac.com", "a[!b].com"),
            ("a[.com", "a[.com"), ("ab.com", "a?.com"), ("x.example.com", "*.example.com"), ("a.com", "a[a-z].com"),
            ("a1.com", "a[a-z].com"), ("a].com", "a[]].com"), ("a^.com", "a[^].com")]
POLICIES = [{}, {"allow": ["*.wikipedia.org"]}, {"allow": ["example.com"]}, {"deny": ["ads.example.com", "*.tracker.net"]},
            {"block_private": True}, {"allow": ["https://shop.example.com/x"]}, {"deny": ["*"]}]
URLS = ["https://en.wikipedia.org/wiki/X", "https://wikipedia.org/", "https://example.com/a", "https://sub.example.com/",
        "https://ads.example.com/p", "https://tracker.net/x", "https://a.tracker.net/x", "http://127.0.0.1:8000/", "file:///etc/passwd",
        "javascript:alert(1)", "about:blank", "data:text/html,hi", "https://shop.example.com/y", "ftp://example.com/f",
        "https://notexample.com/"]

out = {"is_local": {h: is_local(h) for h in HOSTS},
       "match": [[h, p, _match(h, p)] for h, p in PATTERNS],
       "check": [[p, u, list(SitePolicy(**p).check(u))] for p in POLICIES for u in URLS]}
(Path(__file__).parent / "policy_cases.json").write_text(json.dumps(out))
print(f"{len(out['is_local'])} hosts, {len(out['match'])} patterns, {len(out['check'])} rule checks")
