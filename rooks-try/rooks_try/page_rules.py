"""What the assistant may do in the Room's browser without a second yes (design 0007, sections 1.3 and 1.5).

Copied from rooks-browser, which the app cannot import (parity tests: tests/test_page_rules.py): its element snapshot
(SNAPSHOT, from rooks_browser/page_js.py) and its `classify` (from rooks_browser/policy.py). Keep them the same; change
both or neither.

Added here for the Room: DESCRIBE, which describes one element in the same words as the snapshot (by its number, at a
point on the page, or the focused one) with where it is and whether its form has card fields, and says when the point
is on a frame from another site that the snapshot cannot read; and VISIBLE, the elements in view with their boxes.
"""

from __future__ import annotations

import re

CATEGORIES = ("submit", "purchase", "message", "login", "download")

_PURCHASE = re.compile(r"\b(buy|purchase|checkout|check out|place (?:your )?order|pay|payment|add to (?:cart|basket|bag)|"
                       r"order now|subscribe|donate|confirm order|book now|complete (?:order|purchase))\b", re.I)
_MESSAGE = re.compile(r"\b(send|post|reply|tweet|comment|publish|share|submit (?:comment|review|message)|message)\b", re.I)
_CARD = re.compile(r"\b(card ?number|credit card|debit card|cvv|cvc|security code|expiry|expiration|iban|account number|sort code|bsb)\b", re.I)
_LOGIN = re.compile(r"\b(log ?in|sign ?in|sign ?up|register|create account|authenticate|continue with (?:google|apple|microsoft))\b", re.I)


def card_words(text: str) -> bool:
    """A field or form named like a payment card or a bank account (a form with one is a purchase)."""
    return bool(_CARD.search(text or ""))


def classify(action: str, el: dict | None, args: dict) -> str | None:
    """The sensitive category of an action, or None if it can run without asking.

    `el` is the element the action targets, as produced by the page snapshot: tag, role, type, name, in_form,
    form_has_password, form_action, is_submit."""
    if not el:
        return None
    name = " ".join(str(el.get(k) or "") for k in ("name", "value", "form_action"))
    if action == "type":
        if (el.get("type") or "").lower() == "password":
            return "login"
        if _CARD.search(el.get("name") or ""):
            return "purchase"
        if args.get("submit") and el.get("in_form"):
            return _form_category(el, name)
        return None
    if action in ("click", "select"):
        if _PURCHASE.search(name):
            return "purchase"
        if el.get("is_submit") and el.get("in_form"):
            return _form_category(el, name)
        if _LOGIN.search(name) and (el.get("form_has_password") or el.get("is_submit")):
            return "login"
        if _MESSAGE.search(el.get("name") or "") and (el.get("is_submit") or el.get("role") == "button"):
            return "message"
    return None


def _form_category(el: dict, name: str) -> str:
    if el.get("form_has_password") or _LOGIN.search(name):
        return "login"
    if _PURCHASE.search(name):
        return "purchase"
    if _MESSAGE.search(el.get("name") or ""):
        return "message"
    return "submit"


# Numbers every interactive element on the page (data-rb-id) and describes it the way an accessibility tree would:
# role, accessible name, state. The same script as rooks-browser's (page_js.SNAPSHOT).
SNAPSHOT = r"""
(maxElements) => {
  const old = document.querySelectorAll('[data-rb-id]');
  old.forEach(e => e.removeAttribute('data-rb-id'));
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], ' +
    '[role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], ' +
    '[role=searchbox], [role=textbox], [contenteditable=""], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  const vw = window.innerWidth, vh = window.innerHeight;
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const labelOf = el => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map(i => document.getElementById(i)).filter(Boolean).map(e => e.innerText).join(' '); if (t) return t; }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const wrap = el.closest('label'); if (wrap && wrap !== el) return wrap.innerText;
    return '';
  };
  const roleOf = el => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= maxElements) break;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || el.disabled && el.tagName !== 'BUTTON') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const form = el.form || el.closest('form');
    const text = clean(el.innerText || el.value && ['submit', 'button'].includes(type) && el.value || '');
    const name = clean(labelOf(el) || text || el.getAttribute('placeholder') || el.getAttribute('title') ||
      el.getAttribute('alt') || (el.querySelector && el.querySelector('img[alt]') ? el.querySelector('img[alt]').alt : '') ||
      el.getAttribute('name') || '').slice(0, 120);
    const id = ++n;
    el.setAttribute('data-rb-id', String(id));
    const d = { id, tag, role: roleOf(el), name, type,
      in_view: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
      in_form: !!form, form_has_password: !!(form && form.querySelector('input[type=password]')),
      form_action: form ? clean(form.getAttribute('action') || '') : '',
      is_submit: tag === 'button' ? (type === '' || type === 'submit') && !!form : (tag === 'input' && ['submit', 'image'].includes(type)) };
    if (tag === 'a') { d.href = el.href; if (el.hasAttribute('download')) d.download = true; }
    if (type !== 'password' && ['input', 'textarea'].includes(tag) && !['submit', 'button', 'checkbox', 'radio'].includes(type)) d.value = clean(el.value).slice(0, 80);
    if (type === 'checkbox' || type === 'radio') d.checked = el.checked;
    if (tag === 'select') d.options = Array.from(el.options).slice(0, 15).map(o => clean(o.text));
    if (el.disabled) d.disabled = true;
    out.push(d);
  }
  let body = document.body ? document.body.innerText : '';
  const banner = document.getElementById('__rooks_banner');  // our own overlay is not page content
  if (banner && banner.innerText) body = body.replace(banner.innerText, '');
  return { url: location.href, title: document.title, elements: out, text: body.replace(/\n{3,}/g, '\n\n'),
    scroll_y: Math.round(window.scrollY), page_height: Math.round(document.documentElement.scrollHeight), viewport_h: vh };
}
"""

# The words the snapshot uses for one element, and where it is (for the Room: a fresh look just before each click, type
# or Enter). describe(mode, a, b): mode "id" (a = the snapshot's number; scrolled into view first), "point" (a, b = x,
# y on the page) or "focus" (the focused element). Answers {el, frame, top}: el in the snapshot's words plus box and
# form_has_card, or null; frame {site} when the point is on a frame from another site that cannot be read; top, the page.
_HELPERS = r"""
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], ' +
    '[role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], ' +
    '[role=searchbox], [role=textbox], [contenteditable=""], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const card = /\b(card ?number|credit card|debit card|cvv|cvc|security code|expiry|expiration|iban|account number|sort code|bsb)\b/i;
  const labelOf = el => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const doc = el.ownerDocument;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map(i => doc.getElementById(i)).filter(Boolean).map(e => e.innerText).join(' '); if (t) return t; }
    if (el.id) { const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const wrap = el.closest('label'); if (wrap && wrap !== el) return wrap.innerText;
    return '';
  };
  const roleOf = el => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (t === 'iframe' || t === 'frame') return 'frame';
    return 'generic';
  };
  const fieldName = f => clean(labelOf(f) || f.getAttribute('placeholder') || f.getAttribute('name') || f.getAttribute('autocomplete') || '');
  const hasCard = form => !!form && Array.from(form.querySelectorAll('input, select')).some(f =>
    /^cc-/.test(f.getAttribute('autocomplete') || '') || card.test(fieldName(f)));
  const describe = (el, dx, dy) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const form = el.form || el.closest('form');
    const text = clean(el.innerText || el.value && ['submit', 'button'].includes(type) && el.value || '');
    const name = clean(labelOf(el) || text || el.getAttribute('placeholder') || el.getAttribute('title') ||
      el.getAttribute('alt') || el.getAttribute('name') || '').slice(0, 120);
    const r = el.getBoundingClientRect();
    const d = { id: Number(el.getAttribute('data-rb-id')) || null, tag, role: roleOf(el), name, type,
      in_form: !!form, form_has_password: !!(form && form.querySelector('input[type=password]')),
      form_action: form ? clean(form.getAttribute('action') || '') : '',
      is_submit: tag === 'button' ? (type === '' || type === 'submit') && !!form : (tag === 'input' && ['submit', 'image'].includes(type)),
      form_has_card: hasCard(form), editable: ['input', 'textarea'].includes(tag) || el.isContentEditable,
      x: Math.round(r.left + dx), y: Math.round(r.top + dy), w: Math.round(r.width), h: Math.round(r.height) };
    if (tag === 'a') d.href = el.href;
    return d;
  };
  const siteOf = f => { try { return new URL(f.src || f.getAttribute('src') || 'about:blank', location.href).hostname; } catch (e) { return ''; } };
  // The element at (x, y), going into frames of the same origin; a frame that cannot be read stops the search.
  const at = (doc, x, y, dx, dy) => {
    const hit = doc.elementFromPoint(x, y);
    if (!hit) return { el: null, frame: null };
    const t = hit.tagName.toLowerCase();
    if (t === 'iframe' || t === 'frame') {
      let inner = null;
      try { inner = hit.contentDocument; } catch (e) { inner = null; }
      const r = hit.getBoundingClientRect();
      if (!inner) return { el: null, frame: { site: siteOf(hit), x: Math.round(r.left + dx), y: Math.round(r.top + dy) } };
      return at(inner, x - r.left, y - r.top, dx + r.left, dy + r.top);
    }
    return { el: hit.closest(sel) || hit, frame: null, dx, dy };
  };
"""

DESCRIBE = r"""
(mode, a, b) => {
""" + _HELPERS + r"""
  let el = null, frame = null, dx = 0, dy = 0;
  if (mode === 'id') {
    el = document.querySelector(`[data-rb-id="${Number(a)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const there = at(document, r.left + r.width / 2, r.top + r.height / 2, 0, 0);
      if (there.frame && !(el.tagName === 'IFRAME' || el.tagName === 'FRAME')) frame = there.frame;  // covered by a frame
    }
  } else if (mode === 'point') {
    const there = at(document, Number(a), Number(b), 0, 0);
    el = there.el; frame = there.frame; dx = there.dx || 0; dy = there.dy || 0;
  } else {
    el = document.activeElement;
    while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
      let inner = null;
      try { inner = el.contentDocument; } catch (e) { inner = null; }
      if (!inner) { frame = { site: siteOf(el) }; el = null; break; }
      const r = el.getBoundingClientRect(); dx += r.left; dy += r.top;
      el = inner.activeElement;
    }
    if (el && (el === document.body || el === document.documentElement)) el = null;
  }
  return { el: el ? describe(el, dx, dy) : null, frame, top: location.href };
}
"""

# The elements in view with their boxes (after SNAPSHOT has numbered them), and the frames in view with their site.
VISIBLE = r"""
() => {
""" + _HELPERS + r"""
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = [];
  const inView = r => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width >= 2 && r.height >= 2;
  for (const el of document.querySelectorAll('[data-rb-id]')) {
    const r = el.getBoundingClientRect();
    if (!inView(r)) continue;
    const d = describe(el, 0, 0);
    out.push({ id: d.id, role: d.role, name: d.name, x: d.x, y: d.y, w: d.w, h: d.h });
  }
  for (const f of document.querySelectorAll('iframe, frame')) {
    const r = f.getBoundingClientRect();
    if (!inView(r)) continue;
    let readable = false;
    try { readable = !!f.contentDocument; } catch (e) { readable = false; }
    out.push({ id: null, role: 'frame', name: clean(f.getAttribute('title') || ''), site: siteOf(f), readable,
               x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return { url: location.href, title: document.title, view: [vw, vh], elements: out };
}
"""

# Focus one element (by the snapshot's number) and select what is in it, so typing replaces it.
FOCUS = r"""
(id, clear) => {
  const el = document.querySelector(`[data-rb-id="${Number(id)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  if (clear) {
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) document.execCommand('selectAll', false, null);
  }
  return document.activeElement === el;
}
"""


def call(script: str, *args) -> str:
    """An expression that runs one of these scripts with its arguments (JSON)."""
    import json

    return f"({script})({', '.join(json.dumps(a) for a in args)})"
