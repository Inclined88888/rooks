/**
 * Copies text to the clipboard. `navigator.clipboard` only exists in a
 * secure context: ROOKS is often opened over http on the LAN, so we fall
 * back to the old textarea + execCommand method rather than failing
 * silently. Returns false if both paths fail — the caller must tell the
 * user.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied / insecure context → fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
