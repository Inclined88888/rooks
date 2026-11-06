/** Generates one atomic, top-document operation. No submission, cross-origin
 * frame access, arbitrary selectors, or page-supplied JavaScript is accepted.
 * `username: null` is a value-only fill (a secret the user typed for one
 * mission): the username field is left as it is, and a page with no password
 * field may take the value in its single one-time-code field instead. */
export function credentialScript(action: 'capture' | 'fill', params: { origin?: unknown; username?: unknown; password?: unknown } = {}): string {
  if (action !== 'capture' && action !== 'fill') throw new Error('Unsupported credential operation.');
  if (action === 'fill' && (typeof params.origin !== 'string' || (params.username !== null && typeof params.username !== 'string')
    || typeof params.password !== 'string' || !params.password || params.password.length > 16_384
    || (typeof params.username === 'string' && params.username.length > 1024))) {
    throw new Error('Invalid credential input.');
  }
  if (params.origin !== undefined) {
    try {
      const url = new URL(String(params.origin));
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== params.origin || url.username || url.password) throw new Error();
    } catch { throw new Error('A canonical HTTP or HTTPS credential origin is required.'); }
  }
  const payload = JSON.stringify({ action, origin: params.origin, username: params.username, password: params.password });
  return `(() => {
    const request = ${payload};
    const refused = () => ({error:'Credential operation refused: verify the exact site origin and an unambiguous login form.'});
    try {
      if (window !== window.top) return refused();
      const origin = location.origin;
      if (!['http:', 'https:'].includes(location.protocol) || (request.origin !== undefined && request.origin !== origin)) return refused();
      const visible = el => {
        const r = el.getBoundingClientRect(); const css = getComputedStyle(el);
        return !el.disabled && !el.readOnly && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
          && r.left < innerWidth && r.top < innerHeight && css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0';
      };
      const safeAction = raw => { try { const url = new URL(raw || location.href, document.baseURI); return url.origin === origin && !url.username && !url.password && ['http:', 'https:'].includes(url.protocol); } catch { return false; } };
      const formSafeOf = f => safeAction(f.action) && [...f.elements].every(el => !el.hasAttribute('formaction') || safeAction(el.formAction));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const fill = (el, value) => { setter.call(el, value); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); };
      const valueOnly = request.action === 'fill' && request.username === null;
      const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
      if (valueOnly && passwords.length === 0) {
        // A code page (2FA): one field the site itself marks as a one-time code.
        // Its form, when there is one, must post to this origin like a login form.
        const codes = [...document.querySelectorAll('input[autocomplete="one-time-code"]')].filter(visible);
        if (codes.length !== 1) return refused();
        const code = codes[0]; const codeForm = code.form;
        if (codeForm && !formSafeOf(codeForm)) return refused();
        fill(code, request.password);
        return {filled:true};
      }
      if (passwords.length !== 1) return refused();
      const password = passwords[0]; const form = password.form;
      if (!form) return refused();
      const controls = [...form.elements];
      const formSafe = () => formSafeOf(form);
      if (!formSafe()) return refused();
      const candidates = controls.filter(el => el.tagName === 'INPUT' && ['text','email','tel'].includes(el.type) && visible(el));
      const named = candidates.filter(el => /(?:^|\\s)(?:username|email)(?:\\s|$)/.test(el.autocomplete || ''));
      const users = named.length ? named : candidates;
      // A value-only fill never touches the username, so its ambiguity does not matter.
      if (users.length > 1 && !valueOnly) return refused();
      const username = users[0] || null;
      if (request.action === 'capture') {
        if (!password.value || password.value.length > 16384 || (username && username.value.length > 1024)) return refused();
        return {origin, username:username ? username.value : '', password:password.value};
      }
      if (username && !valueOnly) fill(username, request.username);
      // Framework input handlers may change a form action. Recheck before
      // putting the password into the document; never submit the form here.
      if (location.origin !== origin || !formSafe() || !password.isConnected || password.form !== form || password.type !== 'password' || !visible(password)) return refused();
      fill(password, request.password);
      return {filled:true};
    } catch { return refused(); }
  })()`;
}
