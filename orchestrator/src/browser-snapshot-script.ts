/**
 * The page script `take_snapshot` of `bin/browser-mcp.mjs` evaluates, copied character for
 * character (a test holds the two equal: `bin/` is outside this package's `rootDir`). The daemon
 * recognises it to let a conversion mission read a page without evaluating anything else.
 */
export const BROWSER_SNAPSHOT_SCRIPT = `(() => {
  document.querySelectorAll('[data-rooks-browser-uid]').forEach(el => el.removeAttribute('data-rooks-browser-uid'));
  const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
    .filter(el => { const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(el).visibility!=='hidden'; }).slice(0,250);
  const elements = nodes.map((el,i) => { const uid=String(i+1); el.setAttribute('data-rooks-browser-uid',uid); return {
    uid, tag:el.tagName.toLowerCase(), role:el.getAttribute('role'), type:el.getAttribute('type'),
    label:(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('name') || '').slice(0,160)
  }; });
  return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,12000),elements};
})()`;
