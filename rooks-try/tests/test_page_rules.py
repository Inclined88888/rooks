"""What the assistant may do in the Room's browser without a second yes (design 0007, sections 1.3 and 1.5).

rooks-browser's element snapshot and its `classify` are copied into rooks-try (the app cannot import rooks-browser). These
parity tests keep the copies the same: one table of elements and steps through both `classify`s, and the snapshot's
script compared with rooks-browser's. When rooks-browser is not next to this package (an install without it), they skip.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from rooks_try import page_rules

BROWSER = Path(__file__).resolve().parents[2] / "rooks-browser"


def _theirs():
    if not (BROWSER / "rooks_browser").is_dir():
        pytest.skip("rooks-browser is not next to this package")
    if str(BROWSER) not in sys.path:
        sys.path.insert(0, str(BROWSER))
    from rooks_browser import page_js, policy

    return policy, page_js


def _el(**kw) -> dict:
    base = {"tag": "button", "role": "button", "name": "", "type": "", "in_form": False, "form_has_password": False,
            "form_action": "", "is_submit": False}
    base.update(kw)
    return base


TABLE = [
    ("click", _el(name="Add to cart"), {}),
    ("click", _el(name="Buy now", in_form=True, is_submit=True), {}),
    ("click", _el(name="Place your order", in_form=True, is_submit=True, form_action="/checkout"), {}),
    ("click", _el(name="Search", in_form=True, is_submit=True, form_action="/search"), {}),
    ("click", _el(name="Sign in", in_form=True, is_submit=True, form_has_password=True), {}),
    ("click", _el(name="Log in", role="link", tag="a"), {}),
    ("click", _el(name="Send", role="button"), {}),
    ("click", _el(name="Post comment", in_form=True, is_submit=True), {}),
    ("click", _el(name="Next page", role="link", tag="a"), {}),
    ("click", _el(name="Subscribe"), {}),
    ("click", None, {}),
    ("select", _el(name="Pay monthly", tag="select", role="combobox"), {}),
    ("type", _el(tag="input", role="textbox", type="password", name="Password"), {}),
    ("type", _el(tag="input", role="textbox", name="Card number"), {}),
    ("type", _el(tag="input", role="textbox", name="CVV"), {}),
    ("type", _el(tag="input", role="textbox", name="Search words", in_form=True), {}),
    ("type", _el(tag="input", role="textbox", name="Search words", in_form=True), {"submit": True}),
    ("type", _el(tag="input", role="textbox", name="Message", in_form=True), {"submit": True}),
    ("type", _el(tag="input", role="textbox", name="User name", in_form=True, form_has_password=True), {"submit": True}),
    ("type", _el(tag="input", role="textbox", name="Quantity", in_form=True, form_action="/checkout"), {"submit": True}),
    ("type", _el(tag="input", role="textbox", name="Notes"), {"submit": True}),
]


def test_classify_is_rooks_browsers_on_one_table():
    policy, _ = _theirs()
    for action, el, args in TABLE:
        assert page_rules.classify(action, el, args) == policy.classify(action, el, args), (action, el, args)


def test_the_table_covers_every_category():
    seen = {page_rules.classify(a, e, x) for a, e, x in TABLE}
    assert {"purchase", "submit", "login", "message", None} <= seen


def test_the_snapshot_script_is_rooks_browsers():
    _, page_js = _theirs()
    assert page_rules.SNAPSHOT.strip() == page_js.SNAPSHOT.strip()


def test_card_words_mark_a_purchase_form():
    for name in ("Card number", "Credit card", "Security code", "Expiry date", "IBAN"):
        assert page_rules.card_words(name), name
    for name in ("Search words", "User name", "Message"):
        assert not page_rules.card_words(name), name
